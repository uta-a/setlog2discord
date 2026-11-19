/**
 * クリップと写真の投稿（設計書7.1）。取り込み（ingest）から clip・photo を受け取り、復号して clips チャンネルに投稿する。
 * 写真（type=snap、image/jpeg など）も暗号と CDN の仕組みはクリップと同じ（2026-11-19 実測）。
 *
 * 記録する失敗（failed で記録して通知。再試行しても変わらない）：
 *   形が違う、自分宛の鍵が無い・kid 不一致・復号できない、大きすぎる、CDN 以外を指す path
 * 記録しない失敗（通知は同じ messageId につき 1 回。残っている間は 5 分ごとの補完で拾い直す。receiver.ts）：
 *   CDN の取得失敗（5xx・通信断・タイムアウト。バックオフして 3 回まで再試行したあと）、Discord への投稿失敗
 * CDN の 403・404・410 は消えたものとして記録する失敗に入れる（media.ts が ClipDecryptError にする）。
 * 削除済み（REST の isDeleted）は投稿せず skipped で記録する。
 *
 * 投稿はカード（Components V2 のコンテナ）：左の帯にその人の tintColor、中に送信者の名前 1 行（右にアイコン）と、
 * その下に mp4。日付・グループ名は出さない。
 *
 * mp4 はメモリの Buffer のまま渡し、ディスクには書かない。通知に本文やメンバー名は出さない。
 */
import {
  ClipDecryptError,
  ClipPayloadSchema,
  MediaFetchError,
  decryptClip,
  type Keyring,
} from "../lib/setlog/media";
import { short, type HandlerResult, type IncomingMessage } from "./ingest";
import { log } from "./log";
import {
  AttachmentTooLargeError,
  createOutcomes,
  makeNonce,
  resolveAuthor,
  type AuthorDeps,
  type PostEmbed,
} from "./posting";
import type { Notifier } from "./status";

export type ClipDeps = AuthorDeps & {
  keyring: Keyring;
  myUserId: string;
  fetchMedia: (path: string) => Promise<Buffer>;
  post: PostEmbed;
  notify: Notifier;
  /** CDN の再試行の待ち時間（回数もこれで決まる）。既定 1, 2, 4 秒。 */
  retryDelaysMs?: number[];
  /** プロフィールとアイコンを待つ上限。過ぎたら無しで投稿する。既定 5 秒。 */
  nameTimeoutMs?: number;
};

export type ClipHandler = ((m: IncomingMessage) => Promise<HandlerResult>) & {
  /** 記録しない失敗で、まだ投稿できていないクリップがあるか（定期補完の合図）。 */
  hasPending(): boolean;
};

export const clipNonce = (messageId: string) => makeNonce("clip", messageId);

const EXT: Record<string, string> = { "video/mp4": "mp4", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic" };

function fileName(ts: number, messageId: string, mime: string): string {
  const w = new Date(ts + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${w.getUTCFullYear()}${p(w.getUTCMonth() + 1)}${p(w.getUTCDate())}-${p(w.getUTCHours())}${p(w.getUTCMinutes())}`;
  const safeId = short(messageId).replace(/[^A-Za-z0-9-]/g, "_");
  return `setlog-${stamp}-${safeId}.${EXT[mime] ?? "bin"}`;
}

export function createClipHandler(deps: ClipDeps): ClipHandler {
  const delays = deps.retryDelaysMs ?? [1000, 2000, 4000];
  const nameTimeoutMs = deps.nameTimeoutMs ?? 5000;
  const out = createOutcomes(deps.notify);

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
    const what = m.kind === "photo" ? "写真" : "クリップ";
    const where = `${m.group.name} msg=${short(id)}`;
    // 削除済みは本体の形が崩れていることがあるので、厳密な検証より先に見る
    if ((m.message as { isDeleted?: unknown }).isDeleted === true) {
      log.info(`削除済みの${what}を飛ばす（${where}）`);
      return out.done(id, { result: "skipped" });
    }
    const parsed = ClipPayloadSchema.safeParse(m.message);
    if (!parsed.success) {
      const keys = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      return out.failed(id, `${what}の形が想定と違う（${where}）: ${keys}`, `clip-shape:${keys}`);
    }
    const clip = parsed.data;

    let mp4: Buffer;
    try {
      const bytes = await fetchWithRetry(clip.media.path);
      mp4 = decryptClip(clip, bytes, deps.keyring, deps.myUserId);
    } catch (e) {
      if (e instanceof ClipDecryptError) return out.failed(id, `${what}を開けない（${where}）: ${e.message}`);
      if (e instanceof MediaFetchError) return out.transient(id, `${what}の取得に失敗（${where}）: ${e.message}`);
      throw e;
    }

    // 名前とアイコンを動画の上に出す（時刻・グループ名は出さない。色はカードの帯に使う）
    const author = await resolveAuthor(deps, clip.senderId, clip.senderName, nameTimeoutMs);
    try {
      const discordMessageId = await deps.post(
        m.group.clipsChannelId,
        {
          layout: "clip",
          authorName: author.name,
          color: author.color,
          avatar: author.avatar,
          video: { name: fileName(clip.timestamp, id, clip.media.mimeType), data: mp4 },
        },
        clipNonce(id),
      );
      log.info(`${what}を投稿（${where}）`);
      return out.done(id, { result: "posted", discordMessageId });
    } catch (e) {
      if (e instanceof AttachmentTooLargeError) return out.failed(id, `${what}が Discord の添付の上限を超えた（${where}）`);
      return out.transient(id, `${what}の投稿に失敗（${where}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return Object.assign(handler, { hasPending: out.hasPending });
}
