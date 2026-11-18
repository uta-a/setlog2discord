/**
 * 暗号チェーンの移植検証（ラウンドトリップ）。
 *
 * ここで確かめるのは「X25519→HKDF-SHA256→ChaCha20-Poly1305 のラップ/アンラップが
 * 移植可能か」だけ。setlog とのバイト一致は、実鍵で復号した実クリップが無いと
 * 確認できない（実鍵は AndroidKeyStore 内で取り出せない）。
 */
import { describe, it, expect } from "vitest";
import { createPublicKey, generateKeyPairSync, pbkdf2Sync, randomBytes } from "node:crypto";

import {
  aeadOpen,
  aeadSeal,
  contentInfo,
  decryptMedia,
  deriveKey,
  rawOfPublicKey,
  rawToPrivateKey,
  rawToPublicKey,
  recoverPrivateKeyFromBackup,
  unwrapContentKey,
  wrapInfo,
  type KeyBackup,
} from "./crypto";

/** X25519 鍵ペアを生成し、生 32byte と KeyObject の両方を返す。 */
function genPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const rawPriv = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  return { publicKey, privateKey, rawPub: Buffer.from(rawPub), rawPriv: Buffer.from(rawPriv) };
}

describe("生鍵 → KeyObject の変換", () => {
  it("ECDH の共有値が双方向で一致する", () => {
    const a = genPair();
    const b = genPair();
    const k1 = deriveKey(a.privateKey, b.publicKey, Buffer.alloc(32), "info");
    // 生鍵から復元した KeyObject でも同じ共有鍵になる
    const k2 = deriveKey(rawToPrivateKey(a.rawPriv), rawToPublicKey(b.rawPub), Buffer.alloc(32), "info");
    expect(k1.equals(k2)).toBe(true);
  });
});

describe("AEAD ラウンドトリップ", () => {
  it("seal → open で元に戻る", () => {
    const key = randomBytes(32);
    const aad = Buffer.from("aad-info", "utf-8");
    const pt = Buffer.from("hello setlog クリップ");
    const combined = aeadSeal(key, pt, aad, randomBytes(12));
    expect(aeadOpen(key, combined, aad).equals(pt)).toBe(true);
  });

  it("AAD が違うと開けない", () => {
    const key = randomBytes(32);
    const combined = aeadSeal(key, Buffer.from("x"), Buffer.from("a"), randomBytes(12));
    expect(() => aeadOpen(key, combined, Buffer.from("b"))).toThrow();
  });
});

describe("content key のラップ/アンラップ（setlog 方式の再現）", () => {
  it("送信者が受信者宛にラップした content key を受信者が開ける", () => {
    const sender = genPair();
    const recipient = genPair();
    const convId = "conv-1";
    const senderId = "sender-1";
    const info = wrapInfo(convId, senderId);
    const salt = randomBytes(32);
    const contentKey = randomBytes(32);

    // 送信者側：ECDH(senderPriv, recipientPub) → HKDF → その鍵で content key をラップ
    const wrapKey = deriveKey(sender.privateKey, recipient.publicKey, salt, info);
    const wrappedB64 = aeadSeal(wrapKey, contentKey, Buffer.from(info, "utf-8"), randomBytes(12)).toString(
      "base64",
    );

    // 受信者側：keys[] エントリから content key を取り出す
    const entry = {
      saltB64: salt.toString("base64"),
      senderPublicKey: sender.rawPub.toString("base64"),
      wrappedB64,
    };
    const got = unwrapContentKey(entry, recipient.privateKey, convId, senderId);
    expect(got.equals(contentKey)).toBe(true);
  });

  it("別人の秘密鍵では開けない", () => {
    const sender = genPair();
    const recipient = genPair();
    const attacker = genPair();
    const info = wrapInfo("c", "s");
    const salt = randomBytes(32);
    const wrapKey = deriveKey(sender.privateKey, recipient.publicKey, salt, info);
    const wrappedB64 = aeadSeal(wrapKey, randomBytes(32), Buffer.from(info, "utf-8"), randomBytes(12)).toString(
      "base64",
    );
    const entry = {
      saltB64: salt.toString("base64"),
      senderPublicKey: sender.rawPub.toString("base64"),
      wrappedB64,
    };
    expect(() => unwrapContentKey(entry, attacker.privateKey, "c", "s")).toThrow();
  });
});

describe("メディア復号（pb3.b 方式：全体 1 回の AEAD、鍵=content key）", () => {
  it("content key と content info で暗号化した本体を復号できる", () => {
    const contentKey = randomBytes(32);
    const mime = "video/mp4";
    const info = contentInfo("conv-1", "msg-1", "sender-1", mime, 1);
    const plain = Buffer.concat([Buffer.from("\0\0\0\x18ftypmp42"), randomBytes(500)]);
    const fileBytes = aeadSeal(contentKey, plain, Buffer.from(info, "utf-8"), randomBytes(12));
    const out = decryptMedia(contentKey, fileBytes, "conv-1", "msg-1", "sender-1", [mime]);
    expect(out.equals(plain)).toBe(true);
  });

  it("正しい MIME が候補に無いと失敗", () => {
    const contentKey = randomBytes(32);
    const info = contentInfo("c", "m", "s", "video/mp4", 1);
    const fileBytes = aeadSeal(contentKey, Buffer.from("x"), Buffer.from(info, "utf-8"), randomBytes(12));
    expect(() => decryptMedia(contentKey, fileBytes, "c", "m", "s", ["image/png"])).toThrow();
  });
});

describe("鍵バックアップからの秘密鍵復元（PBKDF2 + AEAD）", () => {
  it("パスフレーズで秘密鍵を復元し公開鍵が一致する", () => {
    const id = genPair();
    const passphrase = "correct horse battery staple";
    const salt = randomBytes(32);
    const iterations = 10_000; // テストは軽く
    const dk = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
    const publicKeyB64 = id.rawPub.toString("base64");
    const aad = Buffer.from(JSON.stringify({ publicKeyB64 }), "utf-8");
    const inner = JSON.stringify({
      v: 1,
      identityPrivateKeyB64: id.rawPriv.toString("base64"),
      publicKeyB64,
      kid: "kid-1",
    });
    const ctB64 = aeadSeal(dk, Buffer.from(inner, "utf-8"), aad, randomBytes(12)).toString("base64");
    const backup: KeyBackup = {
      v: 1,
      alg: "PBKDF2-HMAC-SHA256+CHACHA20-POLY1305",
      kdf: { name: "PBKDF2-HMAC-SHA256", iterations, saltB64: salt.toString("base64") },
      aadB64: aad.toString("base64"),
      ctB64,
      kid: "kid-1",
      publicKeyB64,
    };
    const r = recoverPrivateKeyFromBackup(backup, passphrase);
    expect(rawOfPublicKey(createPublicKey(r.privateKey)).toString("base64")).toBe(publicKeyB64);
  });

  it("パスフレーズが違うと復元できない", () => {
    const id = genPair();
    const salt = randomBytes(32);
    const dk = pbkdf2Sync("right", salt, 10_000, 32, "sha256");
    const publicKeyB64 = id.rawPub.toString("base64");
    const aad = Buffer.from("{}", "utf-8");
    const ctB64 = aeadSeal(
      dk,
      Buffer.from(JSON.stringify({ identityPrivateKeyB64: id.rawPriv.toString("base64"), publicKeyB64 })),
      aad,
      randomBytes(12),
    ).toString("base64");
    const backup: KeyBackup = {
      v: 1,
      alg: "x",
      kdf: { name: "PBKDF2-HMAC-SHA256", iterations: 10_000, saltB64: salt.toString("base64") },
      aadB64: aad.toString("base64"),
      ctB64,
      kid: "k",
      publicKeyB64,
    };
    expect(() => recoverPrivateKeyFromBackup(backup, "wrong")).toThrow();
  });
});
