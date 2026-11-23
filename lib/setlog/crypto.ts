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
  pbkdf2Sync,
  randomBytes,
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

/** KeyObject(public/private) から生 32byte を取り出す。 */
export function rawOfPublicKey(pub: KeyObject): Buffer {
  return Buffer.from(pub.export({ type: "spki", format: "der" }).subarray(-32));
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

/**
 * メディア本文の content info 文字列（pb3.k）。AAD に使う。
 * v1: conv={convId} msg={msgId}、v2: conv=media-v2 msg=shared-media。
 */
export function contentInfo(
  convId: string,
  msgId: string,
  senderId: string,
  mime: string,
  v = 1,
): string {
  if (v >= 2) {
    return `msg:enc:v${v}|conv:media-v2|msg:shared-media|sender:${senderId}|type:${mime}`;
  }
  return `msg:enc:v1|conv:${convId}|msg:${msgId}|sender:${senderId}|type:${mime}`;
}

/**
 * メディア本体の復号（pb3.b）。
 * **鍵は content key そのもの**（追加の HKDF は無い）。ファイル全体が 1 回の
 * ChaCha20-Poly1305：nonce(12) + ciphertext + tag(16)、AAD = content info。
 * 正しい MIME が分からないと AEAD 認証で落ちるので候補を順に試す。
 */
export function decryptMedia(
  contentKey: Buffer,
  fileBytes: Buffer,
  convId: string,
  msgId: string,
  senderId: string,
  mimeCandidates: string[],
): Buffer {
  const infos: string[] = [];
  for (const mime of mimeCandidates) {
    infos.push(contentInfo(convId, msgId, senderId, mime, 1));
    infos.push(contentInfo(convId, msgId, senderId, mime, 2));
  }
  let lastErr: unknown;
  for (const info of infos) {
    try {
      return aeadOpen(contentKey, fileBytes, Buffer.from(info, "utf-8"));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`メディア復号に失敗（MIME/AAD 候補すべて不一致）: ${String(lastErr)}`);
}

/**
 * 鍵バックアップ（GET auth/key-backup）＋パスフレーズ → X25519 秘密鍵を復元。
 * PBKDF2-HMAC-SHA256（kdf.iterations 回）→ ChaCha20-Poly1305 で ctB64 を開く。
 * 平文は {identityPrivateKeyB64, publicKeyB64, kid} の JSON。
 * 復元鍵の公開鍵が backup.publicKeyB64 と一致するか検証して返す。
 *
 * 注意：この経路は秘密鍵を端末外（BFF/サーバー）で扱う。信頼境界が広がる。
 */
export type KeyBackup = {
  v: number;
  alg: string;
  kdf: { name: string; iterations: number; saltB64: string };
  aadB64: string;
  ctB64: string;
  kid: string;
  publicKeyB64: string;
};

// --- テキストメッセージ（受信・送信）--------------------------------

const WRAP_ALG = "X25519-HKDF-SHA256+CHACHA20-POLY1305";

export type MessageKeyEntry = {
  uid: string;
  kid: string;
  v: number;
  alg: string;
  saltB64: string;
  wrappedB64: string;
  senderKid: string;
  senderPublicKey: string;
};

export type Envelope = { v: number; alg: string; aadB64: string; combinedB64: string };

/**
 * 受信：テキストメッセージを復号する。
 * keys[] の自分宛（uid === selfUserId）で content key をアンラップし、
 * envelope.combinedB64 を content info(text/plain) を AAD にして開く。
 */
export function decryptText(
  msg: {
    conversationId: string;
    messageId: string;
    senderId: string;
    contentType?: string;
    keys: { uid: string; saltB64: string; senderPublicKey: string; wrappedB64: string }[];
    envelope: Envelope;
  },
  myPriv: KeyObject,
  selfUserId: string,
): string {
  const entry = msg.keys.find((k) => k.uid === selfUserId);
  if (!entry) throw new Error("自分宛の鍵エントリが無い");
  const contentKey = unwrapContentKey(entry, myPriv, msg.conversationId, msg.senderId);
  const mime = msg.contentType || "text/plain";
  const info = contentInfo(msg.conversationId, msg.messageId, msg.senderId, mime, msg.envelope.v);
  const pt = aeadOpen(contentKey, Buffer.from(msg.envelope.combinedB64, "base64"), Buffer.from(info, "utf-8"));
  return pt.toString("utf-8");
}

/** content key を 1 受信者宛にラップして keys[] エントリを作る（送信用）。 */
export function wrapContentKey(
  contentKey: Buffer,
  recipient: { uid: string; kid: string; publicKeyB64: string },
  myPriv: KeyObject,
  sender: { kid: string; publicKeyB64: string; senderId: string },
  convId: string,
): MessageKeyEntry {
  const info = wrapInfo(convId, sender.senderId);
  const salt = randomBytes(32);
  const recipientPub = rawToPublicKey(Buffer.from(recipient.publicKeyB64, "base64"));
  const wrapKey = deriveKey(myPriv, recipientPub, salt, info);
  const nonce = randomBytes(12);
  const wrapped = aeadSeal(wrapKey, contentKey, Buffer.from(info, "utf-8"), nonce);
  return {
    uid: recipient.uid,
    kid: recipient.kid,
    v: 1,
    alg: WRAP_ALG,
    saltB64: salt.toString("base64"),
    wrappedB64: wrapped.toString("base64"),
    senderKid: sender.kid,
    senderPublicKey: sender.publicKeyB64,
  };
}

/**
 * 送信：テキストを暗号化し envelope + keys[] を作る。
 * content key はランダム 32byte。各受信者（自分含む）宛にラップする。
 */
export function encryptText(params: {
  text: string;
  convId: string;
  msgId: string;
  senderId: string;
  myPriv: KeyObject;
  sender: { kid: string; publicKeyB64: string };
  recipients: { uid: string; kid: string; publicKeyB64: string }[];
}): { envelope: Envelope; keys: MessageKeyEntry[] } {
  const contentKey = randomBytes(32);
  const info = contentInfo(params.convId, params.msgId, params.senderId, "text/plain", 1);
  const nonce = randomBytes(12);
  const combined = aeadSeal(contentKey, Buffer.from(params.text, "utf-8"), Buffer.from(info, "utf-8"), nonce);
  const envelope: Envelope = {
    v: 1,
    alg: "CHACHA20-POLY1305",
    aadB64: Buffer.from(info, "utf-8").toString("base64"),
    combinedB64: combined.toString("base64"),
  };
  const senderFull = { ...params.sender, senderId: params.senderId };
  const keys = params.recipients.map((r) =>
    wrapContentKey(contentKey, r, params.myPriv, senderFull, params.convId),
  );
  return { envelope, keys };
}

/**
 * 送信：画像・動画を暗号化し、CDN に置く暗号文と keys[] を作る（アプリの cq3.o / cq3.z の移植）。
 *
 * - 本体はファイル全体を 1 回の ChaCha20-Poly1305 で封じる：nonce(12) + ciphertext + tag(16)。鍵は content key そのもの
 * - AAD は v1 の content info（conv:{convId}|msg:{msgId}|...|type:{mime}）。アプリが撮影してチャットに送る経路（h70・px5）では
 *   mediaCipherV=1（xq3 の既定）で、鍵エントリも v=1 になる。受信側（lr3）は v1・v2 の AAD を MIME の候補ごとに両方試すので
 *   どちらでも開けるが、送信本文の mediaCipherV と keys[].v も 1 にそろえる（client.sendMediaMessage）
 * - mime は送信本文の contentType・media.mimeType と同じ値を渡す（AAD に入るので食い違うと開けない）
 */
export function encryptMedia(params: {
  bytes: Buffer;
  mime: string;
  convId: string;
  msgId: string;
  senderId: string;
  myPriv: KeyObject;
  sender: { kid: string; publicKeyB64: string };
  recipients: { uid: string; kid: string; publicKeyB64: string }[];
}): { cipher: Buffer; keys: MessageKeyEntry[] } {
  const contentKey = randomBytes(32);
  const info = contentInfo(params.convId, params.msgId, params.senderId, params.mime, 1);
  const cipher = aeadSeal(contentKey, params.bytes, Buffer.from(info, "utf-8"), randomBytes(12));
  const senderFull = { ...params.sender, senderId: params.senderId };
  const keys = params.recipients.map((r) => wrapContentKey(contentKey, r, params.myPriv, senderFull, params.convId));
  return { cipher, keys };
}

export function recoverPrivateKeyFromBackup(
  backup: KeyBackup,
  passphrase: string,
): { privateKey: KeyObject; kid: string; publicKeyB64: string } {
  const dk = pbkdf2Sync(
    passphrase,
    Buffer.from(backup.kdf.saltB64, "base64"),
    backup.kdf.iterations,
    KEY_LEN,
    "sha256",
  );
  const aad = Buffer.from(backup.aadB64, "base64");
  const pt = aeadOpen(dk, Buffer.from(backup.ctB64, "base64"), aad);
  const obj = JSON.parse(pt.toString("utf-8")) as { identityPrivateKeyB64: string; kid?: string };
  // 外側の kid は認証されていないので、暗号文の中の kid と食い違えば使わない
  if (obj.kid !== undefined && obj.kid !== backup.kid) {
    throw new Error("鍵バックアップの kid が中身と一致しない");
  }
  const privRaw = Buffer.from(obj.identityPrivateKeyB64, "base64");
  const privateKey = rawToPrivateKey(privRaw);
  const gotPub = rawOfPublicKey(createPublicKey(privateKey));
  if (!gotPub.equals(Buffer.from(backup.publicKeyB64, "base64"))) {
    throw new Error("復元鍵の公開鍵が backup.publicKeyB64 と一致しない");
  }
  return { privateKey, kid: backup.kid, publicKeyB64: backup.publicKeyB64 };
}
