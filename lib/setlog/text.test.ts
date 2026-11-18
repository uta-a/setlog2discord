import { describe, expect, it } from "vitest";
import { keypair, makeEncryptedText } from "./test-helpers";
import { TextDecryptError, TextPayloadSchema, decryptTextMessage } from "./text";

describe("decryptTextMessage", () => {
  it("自分宛のエントリの kid で鍵を選んで復号する", () => {
    const me = keypair();
    const msg = TextPayloadSchema.parse(makeEncryptedText(me, "こんにちは"));
    expect(decryptTextMessage(msg, new Map([["kid-me", me.priv]]), "u-me")).toBe("こんにちは");
  });

  it("自分宛が複数あれば、手元に鍵がある kid のものを使う", () => {
    const me = keypair();
    const msg = TextPayloadSchema.parse(makeEncryptedText(me, "x"));
    const stale = { ...msg.keys[0], kid: "kid-gone" };
    expect(decryptTextMessage({ ...msg, keys: [stale, msg.keys[0]] }, new Map([["kid-me", me.priv]]), "u-me")).toBe("x");
  });

  it("鍵が無い・違う・自分宛が無いときは TextDecryptError", () => {
    const me = keypair();
    const msg = TextPayloadSchema.parse(makeEncryptedText(me, "x"));
    expect(() => decryptTextMessage(msg, new Map(), "u-me")).toThrow(/kid=/);
    expect(() => decryptTextMessage(msg, new Map([["kid-me", keypair().priv]]), "u-me")).toThrow(TextDecryptError);
    expect(() => decryptTextMessage(msg, new Map([["kid-me", me.priv]]), "u-other")).toThrow(TextDecryptError);
  });

  it("REST の空文字の parentId・senderName と isDeleted も通る", () => {
    const me = keypair();
    expect(TextPayloadSchema.safeParse(makeEncryptedText(me, "x", { parentId: "", senderName: "", isDeleted: false })).success).toBe(true);
  });
});
