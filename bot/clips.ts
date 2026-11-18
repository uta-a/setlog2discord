/**
 * クリップの投稿（設計書7.1）。取り込み（ingest）から clip を受け取り、復号して clips チャンネルに投稿する。
 *
 * 記録する失敗（failed で記録して通知。再試行しても変わらない）：
 *   形が違う、自分宛の鍵が無い・kid 不一致・復号できない、大きすぎる、CDN 以外を指す path
 * 記録しない失敗（通知は同じ messageId につき 1 回。次の REST 補完で拾い直す）：
 *   CDN の取得失敗（バックオフして 3 回まで再試行したあと）、Discord への投稿失敗
 * 削除済み（REST の isDeleted）は投稿せず skipped で記録する。
 *
 * mp4 はメモリの Buffer のまま渡し、ディスクには書かない。通知に本文やメンバー名は出さない。
 */
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

export type PostClip = (channelId: string, content: string, file: { name: string; data: Buffer }) => Promise<string>;

export type ClipDeps = {
  keyring: Keyring;
  myUserId: string;
  fetchMedia: (path: string) => Promise<Buffer>;
  post: PostClip;
  memberName: (userId: string) => Promise<string | undefined>;
  notify: Notifier;
  /** CDN の再試行の待ち時間（回数もこれで決まる）。既定 1, 2, 4 秒。 */
  retryDelaysMs?: number[];
};

const FALLBACK_NAME = "メンバー";

function fileName(ts: number, messageId: string): string {
  const w = new Date(ts + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${w.getUTCFullYear()}${p(w.getUTCMonth() + 1)}${p(w.getUTCDate())}-${p(w.getUTCHours())}${p(w.getUTCMinutes())}`;
  return `setlog-${stamp}-${short(messageId)}.mp4`;
}

export function createClipHandler(deps: ClipDeps): (m: IncomingMessage) => Promise<HandlerResult> {
  const delays = deps.retryDelaysMs ?? [1000, 2000, 4000];
  const notifiedTransient = new Set<string>();

  function transient(id: string, text: string): undefined {
    log.warn(text);
    if (!notifiedTransient.has(id)) {
      notifiedTransient.add(id);
      void deps.notify(`${text}。次の補完で再試行する`);
    }
    return undefined;
  }

  function failed(text: string): HandlerResult {
    log.warn(text);
    void deps.notify(text);
    return { result: "failed" };
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

  return async (m) => {
    const id = m.message.messageId;
    const where = `${m.group.name} msg=${short(id)}`;
    const parsed = ClipPayloadSchema.safeParse(m.message);
    if (!parsed.success) {
      const keys = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      return failed(`クリップの形が想定と違う（${where}）: ${keys}`);
    }
    const clip = parsed.data;
    if (clip.isDeleted) {
      log.info(`削除済みのクリップを飛ばす（${where}）`);
      return { result: "skipped" };
    }

    let mp4: Buffer;
    try {
      const bytes = await fetchWithRetry(clip.media.path);
      mp4 = decryptClip(clip, bytes, deps.keyring, deps.myUserId);
    } catch (e) {
      if (e instanceof ClipDecryptError) return failed(`クリップを開けない（${where}）: ${e.message}`);
      if (e instanceof MediaFetchError) return transient(id, `クリップの取得に失敗（${where}）: ${e.message}`);
      throw e;
    }

    const name = (await deps.memberName(clip.senderId).catch(() => undefined)) ?? clip.senderName ?? FALLBACK_NAME;
    const content = `${escapeMarkdown(name)} · ${clipTimeLabel(clip.timestamp)}`;
    try {
      const discordMessageId = await deps.post(m.group.clipsChannelId, content, {
        name: fileName(clip.timestamp, id),
        data: mp4,
      });
      log.info(`クリップを投稿（${where}）`);
      return { result: "posted", discordMessageId };
    } catch (e) {
      if (e instanceof AttachmentTooLargeError) return failed(`クリップが Discord の添付の上限を超えた（${where}）`);
      return transient(id, `クリップの投稿に失敗（${where}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
