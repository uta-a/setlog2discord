/** テスト用：鍵の生成と、自分宛に暗号化したクリップの作成。 */
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { aeadSeal, contentInfo, rawOfPublicKey, wrapContentKey } from "./crypto";
import type { ClipPayload } from "./media";

export function keypair(): { priv: KeyObject; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { priv: privateKey, pubB64: rawOfPublicKey(publicKey).toString("base64") };
}

/** 友達（sender）が自分（me, kid-me）宛に暗号化したクリップを作る。 */
export function makeEncryptedClip(me: { pubB64: string }, mp4: Buffer, over: Partial<ClipPayload> = {}) {
  const sender = keypair();
  const base = {
    messageId: "msg-1",
    conversationId: "conv-1",
    senderId: "u-friend",
    contentType: "video/mp4",
    timestamp: Date.UTC(2026, 10, 18, 13, 5), // JST 11/18 22:05
    media: { path: "ap/uploads/u-friend/1-abc", mimeType: "video/mp4" },
  };
  const contentKey = randomBytes(32);
  const info = contentInfo(base.conversationId, base.messageId, base.senderId, "video/mp4", 1);
  const bytes = aeadSeal(contentKey, mp4, Buffer.from(info, "utf-8"), randomBytes(12));
  const entry = wrapContentKey(
    contentKey,
    { uid: "u-me", kid: "kid-me", publicKeyB64: me.pubB64 },
    sender.priv,
    { kid: "kid-friend", publicKeyB64: sender.pubB64, senderId: base.senderId },
    base.conversationId,
  );
  const clip: ClipPayload = { ...base, keys: [entry], ...over };
  return { clip, bytes };
}
