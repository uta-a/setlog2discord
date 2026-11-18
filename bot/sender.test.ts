import { describe, expect, it } from "vitest";
import { SetlogAuthError } from "../lib/setlog/client";
import { decryptText } from "../lib/setlog/crypto";
import { keypair } from "../lib/setlog/test-helpers";
import { SendError, createSender, type SenderDeps } from "./sender";

function setup(over: Partial<SenderDeps> = {}) {
  const me = keypair();
  const friend = keypair();
  const sent: Parameters<SenderDeps["sendTextMessage"]>[0][] = [];
  let keyCalls = 0;
  let t = 0;
  // 実物の participantKeys は自分を含まなかった（2026-11-19）。自分の鍵はプロフィールから取る
  const participants = [{ userId: "u-friend", publicKey: friend.pubB64, kid: "kid-friend" }];
  const sender = createSender({
    keyring: new Map([["kid-me", me.priv]]),
    myUserId: "u-me",
    getParticipantKeys: async () => {
      keyCalls++;
      return participants;
    },
    getMyKey: async () => ({ kid: "kid-me", publicKey: me.pubB64 }),
    sendTextMessage: async (p) => {
      sent.push(p);
      return p.messageId;
    },
    now: () => t,
    ...over,
  });
  return { sender, sent, me, friend, participants, keyCalls: () => keyCalls, tick: (ms: number) => (t += ms) };
}

describe("createSender", () => {
  it("全参加者宛に暗号化して送り、友達も自分も読める", async () => {
    const { sender, sent, me, friend } = setup();
    const { messageId } = await sender.send("conv-1", "  今どこ？ ");
    expect(sent.length).toBe(1);
    const p = sent[0];
    expect(p.messageId).toBe(messageId);
    expect(p.keys.map((k) => k.uid).sort()).toEqual(["u-friend", "u-me"]);
    const msg = { conversationId: "conv-1", messageId, senderId: "u-me", keys: p.keys, envelope: p.envelope };
    expect(decryptText(msg, friend.priv, "u-friend")).toBe("今どこ？");
    expect(decryptText(msg, me.priv, "u-me")).toBe("今どこ？");
  });

  it("参加者の鍵は短時間キャッシュし、送信に失敗したら取り直す", async () => {
    let fail = true;
    const s = setup({
      sendTextMessage: async (p) => {
        if (fail) throw new Error("500");
        return p.messageId;
      },
    });
    await expect(s.sender.send("c", "a")).rejects.toThrow(SendError);
    fail = false;
    await s.sender.send("c", "b");
    await s.sender.send("c", "c");
    expect(s.keyCalls()).toBe(2);
    s.tick(61_000);
    await s.sender.send("c", "d");
    expect(s.keyCalls()).toBe(3);
  });

  it("空・長すぎる本文は送らない", async () => {
    const { sender, sent } = setup();
    await expect(sender.send("c", "   ")).rejects.toThrow(/空/);
    await expect(sender.send("c", "あ".repeat(2001))).rejects.toThrow(/長すぎる/);
    expect(sent).toEqual([]);
  });

  it("参加者の一覧に自分がいても、宛先は重ねない", async () => {
    const me2 = keypair();
    const s = setup({ keyring: new Map([["kid-me", me2.priv]]), getMyKey: async () => ({ kid: "kid-me", publicKey: me2.pubB64 }) });
    s.participants.push({ userId: "u-me", publicKey: me2.pubB64, kid: "kid-me" });
    await s.sender.send("c", "x");
    expect(s.sent[0].keys.map((k) => k.uid).sort()).toEqual(["u-friend", "u-me"]);
  });

  it("手元に今の kid の鍵が無い・公開鍵が合わない・自分の鍵が登録されていないときは送らない", async () => {
    const other = keypair();
    const b = setup({ keyring: new Map([["kid-old", other.priv]]) });
    await expect(b.sender.send("c", "x")).rejects.toThrow(/今の鍵/);
    const c = setup({ keyring: new Map([["kid-me", other.priv]]) });
    await expect(c.sender.send("c", "x")).rejects.toThrow(/合わない/);
    const d = setup({ getMyKey: async () => ({ kid: null, publicKey: "" }) });
    await expect(d.sender.send("c", "x")).rejects.toThrow(/登録されていない/);
    expect([...b.sent, ...c.sent, ...d.sent]).toEqual([]);
  });

  it("友達がいない（宛先が自分だけ）なら送らない", async () => {
    const s = setup({ getParticipantKeys: async () => [] });
    await expect(s.sender.send("c", "x")).rejects.toThrow(/友達/);
  });

  it("トークン失効は分かる理由にする。理由に本文を入れない", async () => {
    const s = setup({
      getParticipantKeys: async () => {
        throw new SetlogAuthError();
      },
    });
    const e = await s.sender.send("c", "ひみつ").catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect(String(e)).toMatch(/失効/);
    expect(String(e)).not.toMatch(/ひみつ/);
  });
});
