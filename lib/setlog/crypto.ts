/**
 * setlog の E2EE 方式（static-analysis.md 4.7）の移植。
 *
 * 目的：方式判断のためのスパイク。鍵さえあれば BFF 側で復号できるか（将来の
 * サーバー復号案）を確かめる。**実クリップの復号には受信者の X25519 秘密鍵が
 * 必要で、それは端末の AndroidKeyStore 内（取り出し不可）。さらに現アカウントは
 * 鍵バックアップが無い（hasKeyBackup=false, GET auth/key-backup=404）。**
 * よって現状これで実クリップは開けない。ここで検証するのは「暗号チェーンが
 * 移植可能か」だけ（既知鍵でのラウンドトリップ）。
 *
 * 方式：
 * - 鍵共有 X25519 → HKDF-SHA256（salt 32B, info 文字列, 出力 32B）
 * - AEAD ChaCha20-Poly1305。combined = nonce(12) + ciphertext + tag(16)、AAD = info
 * - content key は上記で「ラップ」され、受信者ごとに keys[] に入る
 *
 * Node / WebCrypto 互換のプリミティブのみ使用（Workers 移植も視野）。
 * ただし Workers の WebCrypto は chacha20-poly1305 を持たない場合があり、その
 * 場合は別実装が要る（デプロイ時の課題）。
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type KeyObject,
} from "node:crypto";

const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// 生の 32byte X25519 鍵を Node の KeyObject にするための固定ヘッダ。
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // public
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex"); // private

export function rawToPublicKey(raw32: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw32]),
    format: "der",
    type: "spki",
  });
}

export function rawToPrivateKey(raw32: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw32]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * X25519(myPriv, theirPub) → HKDF-SHA256(salt, info) → 32byte 鍵。
 */
export function deriveKey(
  myPriv: KeyObject,
  theirPub: KeyObject,
  salt: Buffer,
  info: string,
): Buffer {
  const shared = diffieHellman({ privateKey: myPriv, publicKey: theirPub });
  const out = hkdfSync("sha256", shared, salt, Buffer.from(info, "utf-8"), KEY_LEN);
  return Buffer.from(out);
}

/**
 * ChaCha20-Poly1305 で combined(= nonce|ct|tag) を開く。AAD = info。
 */
export function aeadOpen(key: Buffer, combined: Buffer, aad: Buffer): Buffer {
  const nonce = combined.subarray(0, NONCE_LEN);
  const tag = combined.subarray(combined.length - TAG_LEN);
  const ct = combined.subarray(NONCE_LEN, combined.length - TAG_LEN);
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_LEN });
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/**
 * aeadOpen の逆。テスト（移植検証）で暗号文を作るために使う。
 */
export function aeadSeal(key: Buffer, plaintext: Buffer, aad: Buffer, nonce: Buffer): Buffer {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_LEN });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

/**
 * content key のラップ／アンラップ用 info 文字列（4.7）。
 * convId が空なら呼び出し側で "saved" も試す。
 */
export function wrapInfo(convId: string, senderId: string): string {
  return `msg:enc:v1|conv:${convId}|msg:media-key|sender:${senderId}|type:application/octet-stream`;
}

/**
 * keys[] の 1 エントリから content key(32byte) を取り出す。
 * 実運用では myPriv は受信者の X25519 秘密鍵（端末内 or バックアップ由来）。
 */
export function unwrapContentKey(
  entry: { saltB64: string; senderPublicKey: string; wrappedB64: string },
  myPriv: KeyObject,
  convId: string,
  senderId: string,
): Buffer {
  const info = wrapInfo(convId, senderId);
  const salt = Buffer.from(entry.saltB64, "base64");
  const senderPub = rawToPublicKey(Buffer.from(entry.senderPublicKey, "base64"));
  const wrapKey = deriveKey(myPriv, senderPub, salt, info);
  return aeadOpen(wrapKey, Buffer.from(entry.wrappedB64, "base64"), Buffer.from(info, "utf-8"));
}
