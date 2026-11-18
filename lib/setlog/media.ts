/**
 * クリップ（video/mp4 のメッセージ）の検証・CDN 取得・復号（api.md 4.6・4.7、設計書7.1）。
 *
 * - WebSocket のメッセージには senderName・isDeleted が無いので、MessageSchema ではなく
 *   使う項目だけを検証する ClipPayloadSchema を使う
 * - CDN（media.newchatapi.com）は認証ヘッダー不要。media.path はサーバー由来の入力なので、
 *   URL を組んだあと origin が CDN であることを確かめる。トークン類は送らない
 * - 復号は keys[] の自分宛エントリの kid で鍵を選ぶ（端末の再登録で鍵が変わるため、kid ごとに持つ）
 */
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { decryptMedia, unwrapContentKey } from "./crypto";

export const MEDIA_BASE_URL = "https://media.newchatapi.com/";

const KeyEntrySchema = z
  .object({
    uid: z.string(),
    kid: z.string(),
    saltB64: z.string(),
    senderPublicKey: z.string(),
    wrappedB64: z.string(),
  })
  .loose();

export const ClipPayloadSchema = z
  .object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    senderId: z.string().min(1),
    contentType: z.string(),
    timestamp: z.number(),
    senderName: z.string().optional(), // REST だけにある
    isDeleted: z.boolean().optional(), // REST だけにある
    keys: z.array(KeyEntrySchema),
    media: z.object({ path: z.string().min(1), mimeType: z.string() }).loose(),
  })
  .loose();
export type ClipPayload = z.infer<typeof ClipPayloadSchema>;

/** kid → 自分の X25519 秘密鍵。 */
export type Keyring = ReadonlyMap<string, KeyObject>;

/** 取得の失敗（通信・HTTP・タイムアウト）。再試行してよい。 */
export class MediaFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaFetchError";
  }
}

/** 復号できない（鍵が無い・kid 不一致・認証失敗）。再試行しても変わらない。 */
export class ClipDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipDecryptError";
  }
}

/** media.path から CDN の URL を作る。CDN 以外を指していたら投げる。 */
export function mediaUrl(path: string, base = MEDIA_BASE_URL): URL {
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw new ClipDecryptError("media.path が URL として読めない");
  }
  if (url.origin !== new URL(base).origin) throw new ClipDecryptError("media.path が CDN 以外を指している");
  return url;
}

export async function fetchMedia(
  path: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number; base?: string } = {},
): Promise<Buffer> {
  const url = mediaUrl(path, opts.base);
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      // 実 CDN はリダイレクトせず 200 を返す（実測）。別ホストへ飛ばされないよう拒否する
      redirect: "error",
    });
  } catch (e) {
    throw new MediaFetchError(`CDN の取得に失敗: ${e instanceof Error ? e.name : "unknown"}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    // 消えた・見られないものは何度取り直しても変わらない
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new ClipDecryptError(`CDN に無い（HTTP ${res.status}）`);
    }
    throw new MediaFetchError(`CDN の取得に失敗: HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ClipDecryptError(`クリップが大きすぎる（${declared} B）`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ClipDecryptError(`クリップが大きすぎる（${total} B 超）`);
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader?.cancel().catch(() => {});
    if (e instanceof ClipDecryptError) throw e;
    throw new MediaFetchError(`CDN の受信に失敗: ${e instanceof Error ? e.name : "unknown"}`);
  }
  // 途中で切れた本体は復号の認証で落ちて「開けない」になるので、ここで一時的な失敗として扱う
  if (declared > 0 && total !== declared) throw new MediaFetchError(`CDN の受信が途中で切れた（${total}/${declared} B）`);
  return Buffer.concat(chunks);
}

/** 自分宛の鍵エントリで content key を開き、mp4 に戻す。 */
export function decryptClip(clip: ClipPayload, bytes: Buffer, keyring: Keyring, selfUserId: string): Buffer {
  const mine = clip.keys.filter((k) => k.uid === selfUserId);
  if (mine.length === 0) throw new ClipDecryptError("自分宛の鍵エントリが無い");
  // 鍵の世代が変わると自分宛が複数並ぶことがある。手元に鍵があるものを選ぶ
  const entry = mine.find((k) => keyring.has(k.kid));
  if (!entry) throw new ClipDecryptError(`手元に kid=${mine.map((k) => k.kid.slice(0, 8)).join("/")} の鍵が無い`);
  const priv = keyring.get(entry.kid)!;
  let contentKey: Buffer;
  try {
    contentKey = unwrapContentKey(entry, priv, clip.conversationId, clip.senderId);
  } catch {
    throw new ClipDecryptError("content key を開けない");
  }
  const candidates = [...new Set([clip.media.mimeType, clip.contentType, "video/mp4", "video/quicktime", "application/octet-stream"])];
  try {
    return decryptMedia(contentKey, bytes, clip.conversationId, clip.messageId, clip.senderId, candidates);
  } catch {
    throw new ClipDecryptError("動画を復号できない");
  }
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 撮影時刻を JST の暦どおりに「11/19（木）2時台」と書く（04:00 区切りの日付ではない）。 */
export function clipTimeLabel(ts: number): string {
  const w = new Date(ts + 9 * 60 * 60 * 1000);
  return `${w.getUTCMonth() + 1}/${w.getUTCDate()}（${WEEKDAYS[w.getUTCDay()]}）${w.getUTCHours()}時台`;
}
