/**
 * クリップとテキストの投稿で共通の部品：投稿内容の型、送信者の名前・アイコン・色の解決、nonce、失敗の扱い。
 *
 * 失敗の扱い（設計書7.1・7.2）：
 * - 記録する失敗（failed）：再試行しても変わらないもの。通知する（形の違いは理由ごとに 1 回）
 * - 記録しない失敗（transient）：CDN・Discord の一時的な失敗。通知は 1 件につき 1 回。
 *   残っている間は hasPending() が真になり、receiver が 5 分ごとに補完して拾い直す
 */
import { createHash } from "node:crypto";
import type { HandlerResult } from "./ingest";
import { log } from "./log";
import type { AvatarImage, Profile } from "./members";
import type { Notifier } from "./status";

/** Discord に添付が大きすぎると断られた。 */
export class AttachmentTooLargeError extends Error {
  constructor() {
    super("Discord の添付の上限を超えた");
    this.name = "AttachmentTooLargeError";
  }
}

export type FileData = { name: string; data: Buffer };

/**
 * クリップの投稿：カード（Components V2 のコンテナ）の中に、送信者の名前 1 行とその下に動画を並べる。
 * 従来の embed には Bot から動画を入れられず、添付は embed の上に出てしまうため。
 */
export type ClipCardPost = {
  layout: "clip";
  authorName: string;
  /** 動画のタイトル（setlog のキャプション）。名前と動画の間に出す。 */
  caption?: string;
  color?: number;
  avatar?: FileData;
  video: FileData;
};

/** embed 1 つの投稿（テキスト用）。 */
export type CardPost = {
  layout?: "card";
  authorName: string;
  /** embed の本文（Markdown として表示される。呼び出し側で必要ならエスケープする）。 */
  description: string;
  groupName: string;
  color?: number;
  /** embed のタイムスタンプ（ms）。Discord が見る人の時刻で表示する。 */
  timestamp?: number;
  avatar?: FileData;
  video?: FileData;
  /** 返信先の Discord のメッセージ ID。 */
  replyTo?: string;
};

/** 投稿 1 件。Discord の組み立ては main.ts がする。 */
export type EmbedPost = ClipCardPost | CardPost;

export type PostEmbed = (
  channelId: string,
  post: EmbedPost,
  /** 同じメッセージの再送を Discord 側で弾くための値（25 文字以内）。 */
  nonce: string,
) => Promise<string>;

export type AuthorDeps = {
  profile: (userId: string) => Promise<Profile | undefined>;
  avatar: (path: string) => Promise<AvatarImage | undefined>;
};

export const FALLBACK_NAME = "メンバー";
const NAME_MAX = 64;

/**
 * 友達が自由に付けた名前を 1 行の短い文字列にする（制御文字と文字の向きの制御を除き、64 文字に切る）。
 * embed の author は Markdown を解釈しないので、エスケープはしない。
 */
export function displayName(raw: string): string {
  const oneLine = raw.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, " ").replace(/\s+/g, " ").trim();
  return [...oneLine].slice(0, NAME_MAX).join("");
}

const CAPTION_MAX = 200;

/**
 * setlog のキャプション（media.captions[].text。平文）を 1 つの文字列にする。キャプションごとに 1 行。
 * 形が違っても投稿は止めないよう、ここでは検証で落とさず読めるものだけ拾う。制御文字は除き、長すぎれば切る。
 */
export function captionText(media: unknown): string | undefined {
  const caps = (media as { captions?: unknown } | null | undefined)?.captions;
  if (!Array.isArray(caps)) return undefined;
  const lines = caps
    .map((c) => (c && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .map((t) => t.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
  if (lines.length === 0) return undefined;
  return [...lines.join("\n")].slice(0, CAPTION_MAX).join("");
}

/** 種類と messageId から nonce（Discord の上限 25 文字）を作る。 */
export function makeNonce(kind: "clip" | "text", messageId: string): string {
  return createHash("sha256").update(`${kind}:${messageId}`).digest("base64url").slice(0, 25);
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => resolve(v),
      () => resolve(undefined),
    ).finally(() => clearTimeout(t));
  });
}

/** 送信者の名前・色・アイコンを引く。待ちすぎたら・失敗したら無しで返す。 */
export async function resolveAuthor(
  deps: AuthorDeps,
  senderId: string,
  senderName: string | undefined,
  timeoutMs: number,
): Promise<{ name: string; color?: number; avatar?: FileData }> {
  const profile = await withTimeout(deps.profile(senderId), timeoutMs);
  // 空文字も「無い」とみなす（REST の senderName は空文字で返る。実測 2026-11-19）
  const name = displayName(profile?.name || senderName || "") || FALLBACK_NAME;
  const icon = profile?.avatarPath ? await withTimeout(deps.avatar(profile.avatarPath), timeoutMs) : undefined;
  return { name, color: profile?.color, avatar: icon ? { name: `avatar.${icon.ext}`, data: icon.data } : undefined };
}

export type Outcomes = {
  transient(id: string, text: string): HandlerResult;
  failed(id: string, text: string, notifyKey?: string): HandlerResult;
  done(id: string, r: NonNullable<HandlerResult>): HandlerResult;
  hasPending(): boolean;
};

export function createOutcomes(notify: Notifier): Outcomes {
  /** 記録しない失敗で止まっているメッセージ（通知は 1 件につき 1 回）。 */
  const pending = new Set<string>();
  /** 記録する失敗のうち、形の違いは同じ理由につき 1 回だけ通知する。 */
  const notifiedKeys = new Set<string>();

  const done: Outcomes["done"] = (id, r) => {
    pending.delete(id);
    return r;
  };

  return {
    transient(id, text) {
      log.warn(text);
      if (!pending.has(id)) {
        pending.add(id);
        void notify(`${text}。5 分ごとに再試行する`);
      }
      return undefined;
    },
    failed(id, text, notifyKey) {
      log.warn(text);
      if (notifyKey === undefined || !notifiedKeys.has(notifyKey)) {
        if (notifyKey !== undefined) notifiedKeys.add(notifyKey);
        void notify(text);
      }
      return done(id, { result: "failed" });
    },
    done,
    hasPending: () => pending.size > 0,
  };
}
