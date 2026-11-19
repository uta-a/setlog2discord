/**
 * テキスト（text/plain のメッセージ）の検証と復号（api.md 4.8・4.9、設計書7.2）。
 *
 * - WebSocket には senderName・isDeleted・parentId が無い。REST には入るが、senderName と parentId は
 *   空文字で返る（実測 2026-11-19）。使う項目だけを検証する
 * - 復号は keys[] の自分宛エントリのうち、手元に鍵がある kid のものを使う
 */
import { z } from "zod";
import { decryptText } from "./crypto";
import { ClipDecryptError, type Keyring } from "./media";

const KeyEntrySchema = z
  .object({
    uid: z.string(),
    kid: z.string(),
    saltB64: z.string(),
    senderPublicKey: z.string(),
    wrappedB64: z.string(),
  })
  .loose();

export const TextPayloadSchema = z
  .object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    senderId: z.string().min(1),
    contentType: z.string(),
    timestamp: z.number(),
    senderName: z.string().optional(),
    isDeleted: z.boolean().optional(),
    parentId: z.string().nullable().optional(),
    keys: z.array(KeyEntrySchema),
    envelope: z.object({ v: z.number(), alg: z.string(), aadB64: z.string(), combinedB64: z.string() }),
  })
  .loose();
export type TextPayload = z.infer<typeof TextPayloadSchema>;

/** 復号できない（鍵が無い・kid 不一致・認証失敗）。再試行しても変わらない。 */
export class TextDecryptError extends ClipDecryptError {
  constructor(message: string) {
    super(message);
    this.name = "TextDecryptError";
  }
}

export function decryptTextMessage(msg: TextPayload, keyring: Keyring, selfUserId: string): string {
  const mine = msg.keys.filter((k) => k.uid === selfUserId);
  if (mine.length === 0) throw new TextDecryptError("no key entry for this account");
  const entry = mine.find((k) => keyring.has(k.kid));
  if (!entry) throw new TextDecryptError(`no local key for kid=${mine.map((k) => k.kid.slice(0, 8)).join("/")}`);
  try {
    return decryptText({ ...msg, keys: [entry] }, keyring.get(entry.kid)!, selfUserId);
  } catch {
    throw new TextDecryptError("could not decrypt the text");
  }
}
