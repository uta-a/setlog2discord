import { describe, expect, it } from "vitest";
import type { MessageHead } from "../lib/setlog/realtime";
import { keypair, makeEncryptedText } from "../lib/setlog/test-helpers";
import type { GroupConfig } from "./config";
import type { CardPost } from "./posting";
import { createTextHandler, textBody, textNonce, type TextDeps } from "./texts";

const group: GroupConfig = {
  name: "友達",
  conversationId: "conv-1",
  chatConversationId: "conv-1",
  clipsChannelId: "100000000000000004",
  chatChannelId: "100000000000000005",
};

function setup(text: string, over: Partial<TextDeps> = {}, msgOver: Record<string, unknown> = {}) {
  const me = keypair();
  const msg = makeEncryptedText(me, text, msgOver);
  const posts: (CardPost & { channelId: string; nonce: string })[] = [];
  const notes: string[] = [];
  const handler = createTextHandler({
    keyring: new Map([["kid-me", me.priv]]),
    myUserId: "u-me",
    post: async (channelId, post, nonce) => {
      if (post.layout === "clip") throw new Error("テキストは embed の投稿のはず");
      posts.push({ channelId, ...post, nonce });
      return "discord-t";
    },
    discordMessageIdOf: (id) => (id === "clip-1" ? "discord-clip" : undefined),
    profile: async () => ({ name: "たろう", color: 0x123456 }),
    avatar: async () => undefined,
    notify: async (t) => {
      notes.push(t);
    },
    ...over,
  });
  const run = (m: object = msg) => handler({ kind: "text", group, message: m as unknown as MessageHead });
  return { run, handler, posts, notes, msg };
}

describe("テキストのハンドラ", () => {
  it("復号して chat チャンネルに embed で転送する", async () => {
    const { run, posts } = setup("今どこ？");
    expect(await run()).toEqual({ result: "posted", discordMessageId: "discord-t" });
    const p = posts[0];
    expect(p.channelId).toBe("100000000000000005");
    expect([p.authorName, p.description, p.groupName, p.color]).toEqual(["たろう", "今どこ？", "友達", 0x123456]);
    expect(p.timestamp).toBe(Date.UTC(2026, 10, 18, 13, 5));
    expect(p.replyTo).toBeUndefined();
    expect(p.video).toBeUndefined();
    expect(p.nonce).toBe(textNonce("txt-1"));
  });

  it("返信先を投稿済みなら Discord の返信にする。空文字の parentId は返信にしない", async () => {
    const a = setup("いいね", {}, { parentId: "clip-1" });
    await a.run();
    expect(a.posts[0].replyTo).toBe("discord-clip");
    const b = setup("x", {}, { parentId: "unknown" });
    await b.run();
    expect(b.posts[0].replyTo).toBeUndefined();
    const c = setup("x", {}, { parentId: "" });
    await c.run();
    expect(c.posts[0].replyTo).toBeUndefined();
  });

  it("削除済みは skipped、復号できなければ failed で通知（本文は出さない）", async () => {
    expect(await setup("x", {}, { isDeleted: true }).run()).toEqual({ result: "skipped" });
    const b = setup("ひみつ", { keyring: new Map() });
    expect(await b.run()).toEqual({ result: "failed" });
    expect(b.notes[0]).toMatch(/開けない/);
    expect(b.notes.join()).not.toMatch(/ひみつ/);
  });

  it("投稿に失敗したら記録せず、hasPending が真になる。通知に本文は出さない", async () => {
    const { run, handler, notes } = setup("ひみつ", {
      post: async () => {
        throw new Error("network");
      },
    });
    expect(await run()).toBeUndefined();
    expect(handler.hasPending()).toBe(true);
    expect(notes.join()).not.toMatch(/ひみつ/);
  });
});

describe("textBody", () => {
  it("Markdown を無効にして書いたとおりに見せる", () => {
    expect(textBody("*強調* # 見出し")).toBe("\\*強調\\* # 見出し");
    expect(textBody("# 見出し")).toBe("\\# 見出し");
  });
  it("空なら仮の文、長すぎれば切って 4096 文字以内にする", () => {
    expect(textBody("  ")).toBe("（空のメッセージ）");
    expect([...textBody("*".repeat(5000))].length).toBeLessThanOrEqual(4096);
  });
});
