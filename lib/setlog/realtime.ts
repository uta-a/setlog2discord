/**
 * setlog の WebSocket（リアルタイム受信）のフレーム解析（api.md 4.9）。
 *
 * - 接続先は SETLOG_WS_URL。ヘッダーは jwt-key だけで、購読のフレームは送らない
 * - フレームは {"action": "...", "data": {...}}。newMessage の data はメッセージ本体そのもの
 *   （REST の messages と同じ形。ただし WS には senderName・isDeleted が無い。2026-11-18 実測）
 * - ここではクリップとテキストに共通する項目だけを検証する。本体（media / envelope）は
 *   処理する側（B2・B3）が既存のスキーマで検証する
 *
 * 失敗の詳細にはキー名だけを入れ、値（本文・ID）は入れない。
 */
import { z } from "zod";

export const SETLOG_WS_URL = "wss://ws.newchatapi.com/";

/** close code 4403：アカウントロック。アプリはこれを受けると再接続しない。 */
export const CLOSE_ACCOUNT_LOCKED = 4403;

/** クリップとテキストに共通する項目。余分な項目は残す（後段で使う）。 */
export const MessageHeadSchema = z
  .object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    senderId: z.string().min(1),
    contentType: z.string(),
    type: z.string(),
    timestamp: z.number(),
  })
  .loose();
export type MessageHead = z.infer<typeof MessageHeadSchema>;

const FrameSchema = z.object({ action: z.string().min(1), data: z.unknown() });

export type Frame =
  | { kind: "message"; message: MessageHead }
  | { kind: "other"; action: string }
  | { kind: "invalid"; action?: string; detail: string };

function issueKeys(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
}

export function parseMessageHead(raw: unknown): z.ZodSafeParseResult<MessageHead> {
  return MessageHeadSchema.safeParse(raw);
}

export function parseFrame(text: string): Frame {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", detail: "not valid JSON" };
  }
  const frame = FrameSchema.safeParse(json);
  if (!frame.success) return { kind: "invalid", detail: `unexpected frame shape: ${issueKeys(frame.error)}` };

  const { action, data } = frame.data;
  if (action !== "newMessage") return { kind: "other", action };

  const msg = parseMessageHead(data);
  if (!msg.success) return { kind: "invalid", action, detail: `unexpected fields: ${issueKeys(msg.error)}` };
  return { kind: "message", message: msg.data };
}

/** clip：2 秒クリップ（video/mp4）、photo：写真（type=snap、image/jpeg など。復号の仕組みはクリップと同じ）。 */
export function messageKind(m: { contentType: string }): "clip" | "photo" | "audio" | "text" | "other" {
  if (m.contentType === "video/mp4" || m.contentType === "video/quicktime") return "clip";
  if (m.contentType.startsWith("image/")) return "photo";
  // 音声メッセージ（type=snap・audio/mp4。暗号と CDN の仕組みはクリップと同じ）
  if (m.contentType.startsWith("audio/")) return "audio";
  if (m.contentType === "text/plain") return "text";
  return "other";
}
