import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MediaFetchError } from "../lib/setlog/media";
import type { MessageHead } from "../lib/setlog/realtime";
import { keypair, makeEncryptedClip } from "../lib/setlog/test-helpers";
import { AttachmentTooLargeError, createClipHandler, type ClipDeps } from "./clips";
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
  const posts: { channelId: string; content: string; name: string; data: Buffer }[] = [];
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
    post: async (channelId, content, file) => {
      posts.push({ channelId, content, ...file });
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
  return { run, posts, notes, clip, fetches: () => fetches };
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
    expect(notes[0]).toMatch(/次の補完で再試行/);
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
  it("知らない userId で取り直すが、間隔をあける", async () => {
    let calls = 0;
    let t = 0;
    const dir = createMemberDirectory(
      async () => {
        calls++;
        return calls === 1 ? [{ userId: "a", name: "A" }] : [{ userId: "a", name: "A" }, { userId: "b", name: "B" }];
      },
      { minRefreshMs: 100, now: () => t },
    );
    expect(await dir.name("a")).toBe("A");
    expect(await dir.name("b")).toBeUndefined();
    expect(calls).toBe(1);
    t = 150;
    expect(await dir.name("b")).toBe("B");
    expect(calls).toBe(2);
  });

  it("取得に失敗しても投げない", async () => {
    const dir = createMemberDirectory(async () => {
      throw new Error("x");
    });
    expect(await dir.name("a")).toBeUndefined();
  });
});
