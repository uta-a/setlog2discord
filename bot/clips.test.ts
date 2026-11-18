import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MediaFetchError } from "../lib/setlog/media";
import type { MessageHead } from "../lib/setlog/realtime";
import { keypair, makeEncryptedClip } from "../lib/setlog/test-helpers";
import { AttachmentTooLargeError, clipNonce, createClipHandler, displayName, type ClipDeps } from "./clips";
import { createIngest } from "./ingest";
import { openState } from "./state";
import type { GroupConfig } from "./config";
import { createMemberDirectory } from "./members";

const group: GroupConfig = {
  name: "友達",
  conversationId: "conv-1",
  chatConversationId: "conv-1",
  clipsChannelId: "100000000000000004",
  chatChannelId: "100000000000000005",
};
const MP4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypmp42"), randomBytes(32)]);

function setup(over: Partial<ClipDeps> = {}, clipOver = {}, fetchFailures = 0) {
  const me = keypair();
  const { clip, bytes } = makeEncryptedClip(me, MP4, clipOver);
  const posts: { channelId: string; content: string; name: string; data: Buffer; nonce: string }[] = [];
  const notes: string[] = [];
  let fetches = 0;
  const handler = createClipHandler({
    keyring: new Map([["kid-me", me.priv]]),
    myUserId: "u-me",
    fetchMedia: async () => {
      fetches++;
      if (fetches <= fetchFailures) throw new MediaFetchError("HTTP 503");
      return bytes;
    },
    post: async (channelId, content, file, nonce) => {
      posts.push({ channelId, content, ...file, nonce });
      return "discord-1";
    },
    memberName: async (id) => (id === "u-friend" ? "たろう" : undefined),
    notify: async (t) => {
      notes.push(t);
    },
    retryDelaysMs: [1, 1, 1],
    ...over,
  });
  const run = (msg: object = clip) =>
    handler({ kind: "clip", group, message: msg as unknown as MessageHead });
  return { run, handler, posts, notes, clip, bytes, fetches: () => fetches };
}

describe("クリップのハンドラ", () => {
  it("復号して clips チャンネルに「名前 · 暦どおりの時刻」で投稿する", async () => {
    const { run, posts } = setup();
    expect(await run()).toEqual({ result: "posted", discordMessageId: "discord-1" });
    expect(posts.length).toBe(1);
    expect(posts[0].channelId).toBe("100000000000000004");
    expect(posts[0].content).toBe("たろう · 11/18（水）22時台");
    expect(posts[0].name).toBe("setlog-20261118-2205-msg-1.mp4");
    expect(posts[0].data.equals(MP4)).toBe(true);
  });

  it("名前が引けなければ senderName、それも無ければ仮の名前。Markdown はエスケープする", async () => {
    const a = setup({ memberName: async () => undefined }, { senderName: "*はなこ*" });
    await a.run();
    expect(a.posts[0].content).toBe("\\*はなこ\\* · 11/18（水）22時台");
    const b = setup({
      memberName: async () => {
        throw new Error("x");
      },
    });
    await b.run();
    expect(b.posts[0].content).toMatch(/^メンバー · /);
    // REST の senderName は実際には空文字で返る
    const c = setup({ memberName: async () => "" }, { senderName: "" });
    await c.run();
    expect(c.posts[0].content).toMatch(/^メンバー · /);
  });

  it("削除済みは投稿せず skipped", async () => {
    const { run, posts } = setup({}, { isDeleted: true });
    expect(await run()).toEqual({ result: "skipped" });
    expect(posts).toEqual([]);
  });

  it("kid の鍵が無ければ failed で記録して通知する", async () => {
    const { run, notes } = setup({ keyring: new Map() });
    expect(await run()).toEqual({ result: "failed" });
    expect(notes[0]).toMatch(/開けない/);
  });

  it("形が違えば failed で、キー名だけを通知する", async () => {
    const { run, notes, clip } = setup();
    const { media: _drop, ...rest } = clip;
    expect(await run(rest)).toEqual({ result: "failed" });
    expect(notes[0]).toMatch(/media/);
  });

  it("CDN の一時的な失敗は再試行し、成功すれば投稿する", async () => {
    const { run, posts, fetches } = setup({}, {}, 3);
    expect(await run()).toEqual({ result: "posted", discordMessageId: "discord-1" });
    expect(fetches()).toBe(4);
    expect(posts.length).toBe(1);
  });

  it("CDN が再試行を使い切っても失敗なら記録せず、通知は 1 回だけ", async () => {
    const { run, notes, fetches } = setup({}, {}, 100);
    expect(await run()).toBeUndefined();
    expect(fetches()).toBe(4);
    expect(await run()).toBeUndefined();
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/10 分ごとに再試行/);
  });

  it("Discord への投稿失敗は記録しない。添付の上限超えは failed", async () => {
    const a = setup({
      post: async () => {
        throw new Error("network");
      },
    });
    expect(await a.run()).toBeUndefined();
    const b = setup({
      post: async () => {
        throw new AttachmentTooLargeError();
      },
    });
    expect(await b.run()).toEqual({ result: "failed" });
  });
});

describe("メンバー名", () => {
  it("初めて見る userId はすぐ取り直す（新しく入った友達）", async () => {
    let calls = 0;
    const dir = createMemberDirectory(async () => {
      calls++;
      return calls === 1 ? [{ userId: "a", name: "A" }] : [{ userId: "a", name: "A" }, { userId: "b", name: "B" }];
    });
    expect(await dir.name("a")).toBe("A");
    expect(await dir.name("a")).toBe("A");
    expect(calls).toBe(1);
    expect(await dir.name("b")).toBe("B");
    expect(calls).toBe(2);
  });

  it("取り直しても見つからない userId は、間隔をあけるまで取り直さない", async () => {
    let calls = 0;
    let t = 0;
    const dir = createMemberDirectory(
      async () => {
        calls++;
        return [{ userId: "a", name: "A" }];
      },
      { minRefreshMs: 100, now: () => t },
    );
    expect(await dir.name("x")).toBeUndefined();
    expect(await dir.name("x")).toBeUndefined();
    expect(calls).toBe(1);
    t = 150;
    await dir.name("x");
    expect(calls).toBe(2);
  });

  it("取得に失敗しても投げない", async () => {
    const dir = createMemberDirectory(async () => {
      throw new Error("x");
    });
    expect(await dir.name("a")).toBeUndefined();
  });
});

describe("レビューで直した点", () => {
  it("名前を 1 行・64 文字にし、リンク・見出し・リストも無効にする", () => {
    expect(displayName("# 見出し\n[公式](https://evil.example)")).toBe("\\# 見出し \\[公式](https://evil.example)");
    expect(displayName("- a")).toBe("\\- a");
    expect([...displayName("あ".repeat(100))].length).toBe(64);
    expect(displayName("\u202eabc\u0007")).toBe("abc");
  });

  it("投稿に messageId から作った 25 文字以内の nonce を付ける（同じクリップは同じ値）", async () => {
    const { run, posts } = setup();
    await run();
    expect(posts[0].nonce).toBe(clipNonce("msg-1"));
    expect(posts[0].nonce.length).toBeLessThanOrEqual(25);
    expect(clipNonce("msg-1")).not.toBe(clipNonce("msg-2"));
  });

  it("削除済みは media が無くても skipped（形の検証より先に見る）", async () => {
    const { run, clip, notes } = setup();
    const { media: _m, keys: _k, ...rest } = clip;
    expect(await run({ ...rest, isDeleted: true })).toEqual({ result: "skipped" });
    expect(notes).toEqual([]);
  });

  it("形の違いの通知は同じ理由につき 1 回", async () => {
    const { run, clip, notes } = setup();
    const { media: _m, ...rest } = clip;
    await run({ ...rest, messageId: "x1" });
    await run({ ...rest, messageId: "x2" });
    expect(notes.length).toBe(1);
  });

  it("記録しない失敗が残っている間だけ hasPending が真になる", async () => {
    const { run, handler } = setup({}, {}, 4);
    expect(await run()).toBeUndefined();
    expect(handler.hasPending()).toBe(true);
    expect((await run())?.result).toBe("posted");
    expect(handler.hasPending()).toBe(false);
  });

  it("メンバー名が返ってこなければ待ちきらずに仮の名前で投稿する", async () => {
    const { run, posts } = setup({ memberName: () => new Promise(() => {}), nameTimeoutMs: 20 });
    await run();
    expect(posts[0].content).toMatch(/^メンバー · /);
  });

  it("WebSocket のフレームから投稿まで通り、一時的な失敗は次の補完で 1 回だけ投稿される", async () => {
    const { handler, clip, posts } = setup({}, {}, 4);
    const store = openState(":memory:");
    const ingest = createIngest({
      store,
      myUserId: "u-me",
      groups: [group],
      handler,
      notify: async () => {},
      fetchMessages: async () => [clip],
      startedAt: 0,
    });
    ingest.onFrame(JSON.stringify({ action: "newMessage", data: clip }));
    await ingest.idle();
    expect(posts.length).toBe(0);
    expect(store.isProcessed("msg-1")).toBe(false);
    await ingest.backfill();
    await ingest.idle();
    await ingest.backfill();
    await ingest.idle();
    expect(posts.length).toBe(1);
    expect(store.isProcessed("msg-1")).toBe(true);
  });
});
