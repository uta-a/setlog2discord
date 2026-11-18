/**
 * 暗号チェーンの移植検証（ラウンドトリップ）。
 *
 * ここで確かめるのは「X25519→HKDF-SHA256→ChaCha20-Poly1305 のラップ/アンラップが
 * 移植可能か」だけ。setlog とのバイト一致は、実鍵で復号した実クリップが無いと
 * 確認できない（実鍵は AndroidKeyStore 内で取り出せない）。
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

import {
  aeadOpen,
  aeadSeal,
  deriveKey,
  rawToPrivateKey,
  rawToPublicKey,
  unwrapContentKey,
  wrapInfo,
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
