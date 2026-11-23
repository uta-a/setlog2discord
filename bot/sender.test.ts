import { describe, expect, it } from "vitest";
import { SetlogAuthError } from "../lib/setlog/client";
import { decryptMedia, decryptText, unwrapContentKey } from "../lib/setlog/crypto";
import { keypair } from "../lib/setlog/test-helpers";
import {
  MAX_MEDIA_BYTES,
  SendError,
  createSender,
  isSendableMediaType,
  resolveParent,
  sendParts,
  type OutgoingPart,
  type SenderDeps,
} from "./sender";

function setup(over: Partial<SenderDeps> = {}) {
  const me = keypair();
  const friend = keypair();
  const sent: Parameters<SenderDeps["sendTextMessage"]>[0][] = [];
  const sentMedia: Parameters<SenderDeps["sendMediaMessage"]>[0][] = [];
  const uploads: { url: string; cipher: Buffer }[] = [];
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
    getUploadUrl: async () => ({ uploadUrl: "https://bucket/put?sig", region: "ap-northeast-2", key: "ap/uploads/u-me/1-x" }),
    uploadMedia: async (url, cipher) => {
      uploads.push({ url, cipher });
    },
    sendMediaMessage: async (p) => {
      sentMedia.push(p);
      return p.messageId;
    },
    now: () => t,
    ...over,
  });
  return { sender, sent, sentMedia, uploads, me, friend, participants, keyCalls: () => keyCalls, tick: (ms: number) => (t += ms) };
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

  it("返信先を渡すと parentId を付けて送る。渡さなければ付けない", async () => {
    const { sender, sent } = setup();
    await sender.send("conv-1", "それな", { parentId: "m-parent" });
    await sender.send("conv-1", "ふつう");
    expect(sent[0].parentId).toBe("m-parent");
    expect(sent[1].parentId).toBeUndefined();
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
    await expect(sender.send("c", "   ")).rejects.toThrow(/empty/);
    await expect(sender.send("c", "あ".repeat(2001))).rejects.toThrow(/too long/);
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
    await expect(b.sender.send("c", "x")).rejects.toThrow(/current key/);
    const c = setup({ keyring: new Map([["kid-me", other.priv]]) });
    await expect(c.sender.send("c", "x")).rejects.toThrow(/does not match/);
    const d = setup({ getMyKey: async () => ({ kid: null, publicKey: "" }) });
    await expect(d.sender.send("c", "x")).rejects.toThrow(/no key registered/);
    expect([...b.sent, ...c.sent, ...d.sent]).toEqual([]);
  });

  it("友達がいない（宛先が自分だけ）なら送らない", async () => {
    const s = setup({ getParticipantKeys: async () => [] });
    await expect(s.sender.send("c", "x")).rejects.toThrow(/no other members/);
  });

  it("トークン失効は分かる理由にする。理由に本文を入れない", async () => {
    const s = setup({
      getParticipantKeys: async () => {
        throw new SetlogAuthError();
      },
    });
    const e = await s.sender.send("c", "ひみつ").catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect(String(e)).toMatch(/expired/);
    expect(String(e)).not.toMatch(/ひみつ/);
  });
});

describe("createSender.sendMedia", () => {
  const jpeg = Buffer.from("ffd8ffe0-fake-jpeg", "utf-8");

  it("暗号化して置き、置いた場所を media.path にして snap を送る。友達も自分も開ける", async () => {
    const { sender, sentMedia, uploads, me, friend } = setup();
    const { messageId } = await sender.sendMedia("conv-1", { data: jpeg, mimeType: "IMAGE/JPEG", width: 720, height: 1280 }, { parentId: "m-p" });
    expect(uploads.length).toBe(1);
    expect(uploads[0].cipher.includes(jpeg)).toBe(false);
    const p = sentMedia[0];
    expect(p).toMatchObject({
      conversationId: "conv-1",
      messageId,
      mimeType: "image/jpeg",
      parentId: "m-p",
      media: { path: "ap/uploads/u-me/1-x", region: "ap-northeast-2", width: 720, height: 1280 },
    });
    expect(p.keys.map((k) => k.uid).sort()).toEqual(["u-friend", "u-me"]);
    for (const [uid, priv] of [["u-friend", friend.priv], ["u-me", me.priv]] as const) {
      const ck = unwrapContentKey(p.keys.find((k) => k.uid === uid)!, priv, "conv-1", "u-me");
      // 受信側は送信本文の contentType（= media.mimeType）を AAD に使う
      expect(decryptMedia(ck, uploads[0].cipher, "conv-1", messageId, "u-me", [p.mimeType]).equals(jpeg)).toBe(true);
    }
  });

  it("送れない形式・空・大きすぎるものは、アップロードもせずに断る", async () => {
    const { sender, sentMedia, uploads } = setup();
    await expect(sender.sendMedia("c", { data: jpeg, mimeType: "image/gif" })).rejects.toThrow(/unsupported file type/);
    await expect(sender.sendMedia("c", { data: jpeg, mimeType: "" })).rejects.toThrow(/unsupported/);
    await expect(sender.sendMedia("c", { data: Buffer.alloc(0), mimeType: "video/mp4" })).rejects.toThrow(/empty/);
    await expect(sender.sendMedia("c", { data: Buffer.alloc(MAX_MEDIA_BYTES + 1), mimeType: "video/mp4" })).rejects.toThrow(/too large/);
    expect([...uploads, ...sentMedia]).toEqual([]);
    expect(isSendableMediaType("video/quicktime")).toBe(true);
    expect(isSendableMediaType("application/pdf")).toBe(false);
  });

  it("アップロードに失敗したらメッセージは送らない", async () => {
    const s = setup({
      uploadMedia: async () => {
        throw new Error("HTTP 403");
      },
    });
    await expect(s.sender.sendMedia("c", { data: jpeg, mimeType: "image/jpeg" })).rejects.toThrow(/failed to upload/);
    expect(s.sentMedia).toEqual([]);
  });

  it("送信の失敗とトークン失効は分かる理由にする（送り直さない）", async () => {
    let calls = 0;
    const s = setup({
      sendMediaMessage: async () => {
        calls++;
        throw new Error("500");
      },
    });
    await expect(s.sender.sendMedia("c", { data: jpeg, mimeType: "image/jpeg" })).rejects.toThrow(/failed to send/);
    expect(calls).toBe(1);
    const t = setup({
      getUploadUrl: async () => {
        throw new SetlogAuthError();
      },
    });
    await expect(t.sender.sendMedia("c", { data: jpeg, mimeType: "image/jpeg" })).rejects.toThrow(/expired/);
  });

  it("幅・高さが分からなければ入れない", async () => {
    const { sender, sentMedia } = setup();
    await sender.sendMedia("c", { data: jpeg, mimeType: "video/mp4", width: null, height: null });
    expect(sentMedia[0].media.width).toBeUndefined();
    expect(sentMedia[0].media.height).toBeUndefined();
  });
});

describe("resolveParent", () => {
  const table: Record<string, { messageId: string; conversationId: string }> = {
    "d-clip": { messageId: "m-clip", conversationId: "conv-1" },
    "d-other": { messageId: "m-other", conversationId: "conv-2" },
  };
  const lookup = (id: string) => table[id];

  it("返信でなければ返信先なし", () => {
    expect(resolveParent(lookup, undefined, "conv-1")).toBeUndefined();
  });

  it("Discord の返信先に対応する setlog のメッセージを返信先にする", () => {
    expect(resolveParent(lookup, "d-clip", "conv-1")).toBe("m-clip");
  });

  it("返信先が setlog のメッセージでないか、別の会話のものなら送らない", () => {
    expect(() => resolveParent(lookup, "d-status", "conv-1")).toThrow(SendError);
    expect(() => resolveParent(lookup, "d-other", "conv-1")).toThrow(/another conversation/);
  });
});

describe("sendParts", () => {
  const jpeg = Buffer.from("jpeg");
  const media = (name: string, over: Partial<Extract<OutgoingPart, { kind: "media" }>> = {}): OutgoingPart => ({
    kind: "media",
    name,
    mimeType: "image/jpeg",
    size: jpeg.length,
    load: async () => jpeg,
    ...over,
  });

  it("テキスト、添付の順に別々に送り、返信先は最初の 1 件にだけ付ける", async () => {
    const s = setup();
    const r = await sendParts(s.sender, "conv-1", [{ kind: "text", text: "見て" }, media("a.jpg"), media("b.jpg")], { parentId: "m-p" });
    expect(r.failures).toEqual([]);
    expect(r.sent).toBe(3);
    expect(s.sent.map((p) => p.parentId)).toEqual(["m-p"]);
    expect(s.sentMedia.map((p) => p.parentId)).toEqual([undefined, undefined]);
    expect(r.firstMessageId).toBe(s.sent[0].messageId);
  });

  it("送れないものがあっても残りは送り、理由を名前付きで返す。送れない形式・大きさなら取得もしない", async () => {
    const s = setup();
    let loads = 0;
    const r = await sendParts(
      s.sender,
      "conv-1",
      [
        media("anim.gif", { mimeType: "image/gif", load: async () => (loads++, jpeg) }),
        media("huge.mp4", { mimeType: "video/mp4", size: MAX_MEDIA_BYTES + 1, load: async () => (loads++, jpeg) }),
        media("ok.jpg"),
      ],
      { parentId: "m-p" },
    );
    expect(loads).toBe(0);
    expect(r.sent).toBe(1);
    expect(r.failures).toEqual([expect.stringMatching(/^anim\.gif: unsupported/), expect.stringMatching(/^huge\.mp4: file too large/)]);
    // 前の 2 つが送れなかったので、送れた最初のものを返信にする
    expect(s.sentMedia[0].parentId).toBe("m-p");
    expect(r.firstMessageId).toBe(s.sentMedia[0].messageId);
  });

  it("取得の失敗も理由にして続ける。想定外のエラーは中身を出さない", async () => {
    const s = setup();
    const r = await sendParts(s.sender, "c", [
      media("x.jpg", {
        load: async () => {
          throw new SendError("could not download the attachment from Discord");
        },
      }),
      media("y.jpg", {
        load: async () => {
          throw new Error("secret detail");
        },
      }),
    ]);
    expect(r.failures).toEqual(["x.jpg: could not download the attachment from Discord", "y.jpg: unexpected error"]);
    expect(r.firstMessageId).toBeUndefined();
  });
});
