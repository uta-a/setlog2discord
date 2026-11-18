/**
 * クリップの投稿（設計書7.1）。取り込み（ingest）から clip を受け取り、復号して clips チャンネルに投稿する。
 *
 * 記録する失敗（failed で記録して通知。再試行しても変わらない）：
 *   形が違う、自分宛の鍵が無い・kid 不一致・復号できない、大きすぎる、CDN 以外を指す path
 * 記録しない失敗（通知は同じ messageId につき 1 回。残っている間は 10 分ごとの補完で拾い直す。receiver.ts）：
 *   CDN の取得失敗（5xx・通信断・タイムアウト。バックオフして 3 回まで再試行したあと）、Discord への投稿失敗
 * CDN の 403・404・410 は消えたものとして記録する失敗に入れる（media.ts が ClipDecryptError にする）。
 * 削除済み（REST の isDeleted）は投稿せず skipped で記録する。
 *
 * mp4 はメモリの Buffer のまま渡し、ディスクには書かない。通知に本文やメンバー名は出さない。
 */
import { createHash } from "node:crypto";
import { escapeMarkdown } from "discord.js";
import {
  ClipDecryptError,
  ClipPayloadSchema,
  MediaFetchError,
  clipTimeLabel,
  decryptClip,
  type Keyring,
} from "../lib/setlog/media";
import { short, type HandlerResult, type IncomingMessage } from "./ingest";
import { log } from "./log";
import type { Notifier } from "./status";

/** Discord に添付が大きすぎると断られた。 */
export class AttachmentTooLargeError extends Error {
  constructor() {
    super("Discord の添付の上限を超えた");
    this.name = "AttachmentTooLargeError";
  }
}

export type PostClip = (
  channelId: string,
  content: string,
  file: { name: string; data: Buffer },
  /** 同じクリップの再送を Discord 側で弾くための値（messageId から作る。25 文字以内）。 */
  nonce: string,
) => Promise<string>;

export type ClipDeps = {
  keyring: Keyring;
  myUserId: string;
  fetchMedia: (path: string) => Promise<Buffer>;
  post: PostClip;
  memberName: (userId: string) => Promise<string | undefined>;
  notify: Notifier;
  /** CDN の再試行の待ち時間（回数もこれで決まる）。既定 1, 2, 4 秒。 */
  retryDelaysMs?: number[];
  /** メンバー名を待つ上限。過ぎたら仮の名前で投稿する。既定 5 秒。 */
  nameTimeoutMs?: number;
};

export type ClipHandler = ((m: IncomingMessage) => Promise<HandlerResult>) & {
  /** 記録しない失敗で、まだ投稿できていないクリップがあるか（定期補完の合図）。 */
  hasPending(): boolean;
};

const FALLBACK_NAME = "メンバー";
const NAME_MAX = 64;

/** 友達が自由に付けた名前を 1 行の短い文字列にし（制御文字と文字の向きの制御を除く）、Markdown を無効にする。 */
export function displayName(raw: string): string {
  const oneLine = raw.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, " ").replace(/\s+/g, " ").trim();
  const cut = [...oneLine].slice(0, NAME_MAX).join("");
  return escapeMarkdown(cut, { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/** messageId から nonce（Discord の上限 25 文字）を作る。 */
export function clipNonce(messageId: string): string {
  return createHash("sha256").update(`clip:${messageId}`).digest("base64url").slice(0, 25);
}

function fileName(ts: number, messageId: string): string {
  const w = new Date(ts + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${w.getUTCFullYear()}${p(w.getUTCMonth() + 1)}${p(w.getUTCDate())}-${p(w.getUTCHours())}${p(w.getUTCMinutes())}`;
  const safeId = short(messageId).replace(/[^A-Za-z0-9-]/g, "_");
  return `setlog-${stamp}-${safeId}.mp4`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => resolve(v),
      () => resolve(undefined),
    ).finally(() => clearTimeout(t));
  });
}

export function createClipHandler(deps: ClipDeps): ClipHandler {
  const delays = deps.retryDelaysMs ?? [1000, 2000, 4000];
  const nameTimeoutMs = deps.nameTimeoutMs ?? 5000;
  /** 記録しない失敗で止まっているクリップ（通知は 1 件につき 1 回）。 */
  const pending = new Set<string>();
  /** 記録する失敗のうち、形の違いは同じ理由につき 1 回だけ通知する。 */
  const notifiedShape = new Set<string>();

  function transient(id: string, text: string): undefined {
    log.warn(text);
    if (!pending.has(id)) {
      pending.add(id);
      void deps.notify(`${text}。10 分ごとに再試行する`);
    }
    return undefined;
  }

  function done(id: string, r: NonNullable<HandlerResult>): HandlerResult {
    pending.delete(id);
    return r;
  }

  function failed(id: string, text: string, notifyKey?: string): HandlerResult {
    log.warn(text);
    if (notifyKey === undefined || !notifiedShape.has(notifyKey)) {
      if (notifyKey !== undefined) notifiedShape.add(notifyKey);
      void deps.notify(text);
    }
    return done(id, { result: "failed" });
  }

  async function fetchWithRetry(path: string): Promise<Buffer> {
    for (let i = 0; ; i++) {
      try {
        return await deps.fetchMedia(path);
      } catch (e) {
        if (!(e instanceof MediaFetchError) || i >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  }

  const handler = async (m: IncomingMessage): Promise<HandlerResult> => {
    const id = m.message.messageId;
    const where = `${m.group.name} msg=${short(id)}`;
    // 削除済みは本体の形が崩れていることがあるので、厳密な検証より先に見る
    if ((m.message as { isDeleted?: unknown }).isDeleted === true) {
      log.info(`削除済みのクリップを飛ばす（${where}）`);
      return done(id, { result: "skipped" });
    }
    const parsed = ClipPayloadSchema.safeParse(m.message);
    if (!parsed.success) {
      const keys = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      return failed(id, `クリップの形が想定と違う（${where}）: ${keys}`, `shape:${keys}`);
    }
    const clip = parsed.data;

    let mp4: Buffer;
    try {
      const bytes = await fetchWithRetry(clip.media.path);
      mp4 = decryptClip(clip, bytes, deps.keyring, deps.myUserId);
    } catch (e) {
      if (e instanceof ClipDecryptError) return failed(id, `クリップを開けない（${where}）: ${e.message}`);
      if (e instanceof MediaFetchError) return transient(id, `クリップの取得に失敗（${where}）: ${e.message}`);
      throw e;
    }

    // 空文字も「無い」とみなす（REST の senderName は空文字で返る。実測 2026-11-19）
    const raw = (await withTimeout(deps.memberName(clip.senderId), nameTimeoutMs)) || clip.senderName || "";
    const name = displayName(raw) || FALLBACK_NAME;
    const content = `${name} · ${clipTimeLabel(clip.timestamp)}`;
    try {
      const discordMessageId = await deps.post(
        m.group.clipsChannelId,
        content,
        { name: fileName(clip.timestamp, id), data: mp4 },
        clipNonce(id),
      );
      log.info(`クリップを投稿（${where}）`);
      return done(id, { result: "posted", discordMessageId });
    } catch (e) {
      if (e instanceof AttachmentTooLargeError) return failed(id, `クリップが Discord の添付の上限を超えた（${where}）`);
      return transient(id, `クリップの投稿に失敗（${where}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return Object.assign(handler, { hasPending: () => pending.size > 0 });
}
