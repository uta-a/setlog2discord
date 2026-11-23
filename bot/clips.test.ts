import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MediaFetchError } from "../lib/setlog/media";
import type { MessageHead } from "../lib/setlog/realtime";
import { keypair, makeEncryptedClip } from "../lib/setlog/test-helpers";
import { clipNonce, createClipHandler, type ClipDeps } from "./clips";
import { AttachmentTooLargeError, displayName, type ClipCardPost } from "./posting";
import { createIngest } from "./ingest";
import { openState } from "./state";
import type { GroupConfig } from "./config";
import { createMemberDirectory, sniffImage } from "./members";

const group: GroupConfig = {
  name: "友達",
  conversationId: "conv-1",
  chatConversationId: "conv-1",
  clipsChannelId: "100000000000000004",
  chatChannelId: "100000000000000005",
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const MP4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypmp42"), randomBytes(32)]);

function setup(over: Partial<ClipDeps> = {}, clipOver = {}, fetchFailures = 0) {
  const me = keypair();
  const { clip, bytes } = makeEncryptedClip(me, MP4, clipOver);
  const posts: (ClipCardPost & { channelId: string; nonce: string })[] = [];
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
    post: async (channelId, post, nonce) => {
      if (post.layout !== "clip") throw new Error("クリップはカードの投稿のはず");
      posts.push({ channelId, ...post, nonce });
      return "discord-1";
    },
    profile: async (id) => (id === "u-friend" ? { name: "たろう", avatarPath: "ap/a.heic", color: 0x65ea7b } : undefined),
    avatar: async () => ({ data: JPEG, ext: "jpg" as const }),
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
  it("音声は mp3 に変換して、ファイルの部品で投稿する（m4a は Discord がその場で再生しないため）", async () => {
    const MP3 = Buffer.from("ID3-converted");
    const calls: { audio: Buffer; mime: string }[] = [];
    const { handler, posts, clip } = setup({
      toMp3: async (audio, mime) => {
        calls.push({ audio, mime });
        return MP3;
      },
    });
    const audio = { ...clip, type: "snap", contentType: "audio/mp4", media: { ...clip.media, mimeType: "audio/mp4" } };
    await handler({ kind: "audio", group, message: audio as unknown as MessageHead });
    expect(calls).toEqual([{ audio: MP4, mime: "audio/mp4" }]);
    expect(posts[0].video.name).toMatch(/\.mp3$/);
    expect(posts[0].video.data).toEqual(MP3);
    expect(posts[0].asFile).toBe(true);
  });

  it("mp3 に変換できなければ元の .m4a で投稿し、#bot-status には 1 回だけ知らせる", async () => {
    const { handler, posts, notes, clip } = setup({
      toMp3: async () => {
        throw new Error("ffmpeg is not installed");
      },
    });
    const audio = { ...clip, type: "snap", contentType: "audio/mp4", media: { ...clip.media, mimeType: "audio/mp4" } };
    const r1 = await handler({ kind: "audio", group, message: audio as unknown as MessageHead });
    const r2 = await handler({ kind: "audio", group, message: audio as unknown as MessageHead });
    expect(r1).toEqual({ result: "posted", discordMessageId: "discord-1" });
    expect(r2).toEqual({ result: "posted", discordMessageId: "discord-1" });
    expect(posts.map((p) => p.video.name)).toEqual([expect.stringMatching(/\.m4a$/), expect.stringMatching(/\.m4a$/)]);
    expect(posts[0].video.data).toEqual(MP4);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/mp3/);
    expect(notes[0]).toMatch(/ffmpeg is not installed/);
  });

  it("変換の対象外の音声（mp3 など）と動画は変換しない", async () => {
    let calls = 0;
    const { handler, run, posts, clip } = setup({
      toMp3: async () => {
        calls++;
        return Buffer.from("x");
      },
    });
    const mp3 = { ...clip, type: "snap", contentType: "audio/mpeg", media: { ...clip.media, mimeType: "audio/mpeg" } };
    await handler({ kind: "audio", group, message: mp3 as unknown as MessageHead });
    await run(clip);
    expect(calls).toBe(0);
    expect(posts.map((p) => p.video.name)).toEqual([expect.stringMatching(/\.mp3$/), expect.stringMatching(/\.mp4$/)]);
  });

  it("video/quicktime のクリップは .mov で投稿する", async () => {
    const { run, posts, clip } = setup();
    await run({ ...clip, contentType: "video/quicktime", media: { ...clip.media, mimeType: "video/quicktime" } });
    expect(posts[0].video.name).toMatch(/\.mov$/);
  });

  it("タイトル（キャプション）があればカードに入れる", async () => {
    const { run, posts, clip } = setup();
    const withCaption = { ...clip, media: { ...clip.media, captions: [{ style: 0, text: "夕焼け", time: "", translation: "{0, 0}" }] } };
    await run(withCaption);
    expect(posts[0].caption).toBe("夕焼け");
  });

  it("復号して clips チャンネルに、名前 1 行・アイコン・色・動画で投稿する（日付は出さない）", async () => {
    let avatarCalls = 0;
    const { run, posts } = setup({
      avatar: async () => {
        avatarCalls++;
        return { data: JPEG, ext: "jpg" as const };
      },
    });
    expect(await run()).toEqual({ result: "posted", discordMessageId: "discord-1" });
    expect(posts.length).toBe(1);
    const p = posts[0];
    expect(p.channelId).toBe("100000000000000004");
    expect(Object.keys(p).sort()).toEqual(["authorId", "authorName", "avatar", "channelId", "color", "layout", "nonce", "video"]);
    expect(p.authorId).toBe("u-friend");
    expect([p.authorName, p.color]).toEqual(["たろう", 0x65ea7b]);
    expect(p.avatar).toEqual({ name: "avatar.jpg", data: JPEG });
    expect(p.video.name).toBe("setlog-20261118-2205-msg-1.mp4");
    expect(p.video.data.equals(MP4)).toBe(true);
    expect(avatarCalls).toBe(1);
  });

  it("名前が引けなければ senderName、それも無ければ仮の名前。アイコン・色は無しで投稿する", async () => {
    const a = setup({ profile: async () => undefined }, { senderName: "はなこ" });
    await a.run();
    expect(a.posts[0].authorName).toBe("はなこ");
    const b = setup({
      profile: async () => {
        throw new Error("x");
      },
    });
    await b.run();
    expect(b.posts[0].authorName).toBe("メンバー");
    // REST の senderName は実際には空文字で返る
    const c = setup({ profile: async () => ({ name: "" }) }, { senderName: "" });
    await c.run();
    expect(c.posts[0].authorName).toBe("メンバー");
  });

  it("写真も復号して、拡張子を合わせて同じカードで投稿する", async () => {
    const me = keypair();
    const JPG = Buffer.concat([JPEG, randomBytes(16)]);
    const { clip, bytes } = makeEncryptedClip(me, JPG, {});
    // 写真は contentType・media.mimeType が image/jpeg。暗号の AAD も image/jpeg で作る
    const photo = makeEncryptedClip(me, JPG, { contentType: "image/jpeg", media: { ...clip.media, mimeType: "image/jpeg" } }, "image/jpeg");
    void bytes;
    const posts: { name: string; size: number }[] = [];
    const h = createClipHandler({
      keyring: new Map([["kid-me", me.priv]]),
      myUserId: "u-me",
      fetchMedia: async () => photo.bytes,
      post: async (_c, p) => {
        if (p.layout !== "clip") throw new Error("x");
        posts.push({ name: p.video.name, size: p.video.data.length });
        return "d";
      },
      profile: async () => ({ name: "たろう" }),
      avatar: async () => undefined,
      notify: async () => {},
    });
    expect((await h({ kind: "photo", group, message: photo.clip as unknown as MessageHead }))?.result).toBe("posted");
    expect(posts[0].name).toMatch(/\.jpg$/);
    expect(posts[0].size).toBe(JPG.length);
  });

  /** HEIC の写真を暗号化して、それを返すハンドラを作る。 */
  function heicSetup(over: Partial<ClipDeps> = {}, content?: Buffer) {
    const me = keypair();
    const HEIC = content ?? Buffer.concat([Buffer.from("\0\0\0\x24ftypheic"), randomBytes(32)]);
    const base = makeEncryptedClip(me, HEIC, {});
    const photo = makeEncryptedClip(me, HEIC, { type: "snap", contentType: "image/heic", media: { ...base.clip.media, mimeType: "image/heic" } }, "image/heic");
    const posts: ClipCardPost[] = [];
    const notes: string[] = [];
    const h = createClipHandler({
      keyring: new Map([["kid-me", me.priv]]),
      myUserId: "u-me",
      fetchMedia: async () => photo.bytes,
      post: async (_c, p) => {
        if (p.layout !== "clip") throw new Error("x");
        posts.push(p);
        return "d";
      },
      profile: async () => ({ name: "たろう" }),
      avatar: async () => undefined,
      notify: async (t) => {
        notes.push(t);
      },
      ...over,
    });
    const run = () => h({ kind: "photo", group, message: photo.clip as unknown as MessageHead });
    return { run, posts, notes, HEIC };
  }

  it("HEIC の写真は JPEG に変換して画像の枠で投稿する（Discord は HEIC を表示できない。2026-11-23 実例）", async () => {
    const JPG = Buffer.concat([JPEG, randomBytes(16)]);
    const calls: { image: Buffer; mime: string }[] = [];
    const { run, posts, HEIC } = heicSetup({
      toJpeg: async (image, mime) => {
        calls.push({ image, mime });
        return JPG;
      },
    });
    expect((await run())?.result).toBe("posted");
    expect(calls).toEqual([{ image: HEIC, mime: "image/heic" }]);
    expect(posts[0].video.name).toMatch(/\.jpg$/);
    expect(posts[0].video.data).toEqual(JPG);
    expect(posts[0].asFile).toBeUndefined();
  });

  it("JPEG に変換できなければ元の .heic をファイルの部品で投稿し、#bot-status には 1 回だけ知らせる", async () => {
    const { run, posts, notes, HEIC } = heicSetup({
      toJpeg: async () => {
        throw new Error("could not decode");
      },
    });
    expect((await run())?.result).toBe("posted");
    expect((await run())?.result).toBe("posted");
    expect(posts.map((p) => p.video.name)).toEqual([expect.stringMatching(/\.heic$/), expect.stringMatching(/\.heic$/)]);
    expect(posts[0].video.data).toEqual(HEIC);
    // 画像の枠に入れると「画像を読み込めませんでした」になるので、ファイルで出す
    expect(posts.map((p) => p.asFile)).toEqual([true, true]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/JPEG/);
    expect(notes[0]).toMatch(/could not decode/);
  });

  it("HEIC と名乗って中身が JPEG なら、変換せずに .jpg で画像の枠に出す", async () => {
    const JPG = Buffer.concat([JPEG, randomBytes(16)]);
    let calls = 0;
    const { run, posts } = heicSetup(
      {
        toJpeg: async () => {
          calls++;
          return Buffer.from("x");
        },
      },
      JPG,
    );
    await run();
    expect(calls).toBe(0);
    expect(posts[0].video.name).toMatch(/\.jpg$/);
    expect(posts[0].video.data).toEqual(JPG);
    expect(posts[0].asFile).toBeUndefined();
  });

  it("変換器が無ければ HEIC はファイルの部品で投稿する", async () => {
    const { run, posts } = heicSetup();
    await run();
    expect(posts[0].video.name).toMatch(/\.heic$/);
    expect(posts[0].asFile).toBe(true);
  });

  it("削除済みは投稿せず skipped", async () => {
    const { run, posts } = setup({}, { isDeleted: true });
    expect(await run()).toEqual({ result: "skipped" });
    expect(posts).toEqual([]);
  });

  it("kid の鍵が無ければ failed で記録して通知する", async () => {
    const { run, notes } = setup({ keyring: new Map() });
    expect(await run()).toEqual({ result: "failed" });
    expect(notes[0]).toMatch(/could not be decrypted/);
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
    expect(notes[0]).toMatch(/Retrying every 5 minutes/);
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

describe("メンバーのプロフィール", () => {
  const P = (userId: string, name: string, extra = {}) => ({ userId, name, avatarUrl: null, ...extra });
  const noImage = async () => Buffer.alloc(0);

  it("名前・アイコンのパス・色を引く", async () => {
    const dir = createMemberDirectory(async () => [P("a", "A", { avatarUrl: "ap/x.heic", tintColor: "#6565EAEA7B7BFFFF" })], noImage);
    expect(await dir.profile("a")).toEqual({ name: "A", avatarPath: "ap/x.heic", color: 0x65ea7b });
  });

  it("初めて見る userId はすぐ取り直す（新しく入った友達）", async () => {
    let calls = 0;
    const dir = createMemberDirectory(async () => {
      calls++;
      return calls === 1 ? [P("a", "A")] : [P("a", "A"), P("b", "B")];
    }, noImage);
    expect((await dir.profile("a"))?.name).toBe("A");
    expect((await dir.profile("a"))?.name).toBe("A");
    expect(calls).toBe(1);
    expect((await dir.profile("b"))?.name).toBe("B");
    expect(calls).toBe(2);
  });

  it("取り直しても見つからない userId は、間隔をあけるまで取り直さない", async () => {
    let calls = 0;
    let t = 0;
    const dir = createMemberDirectory(
      async () => {
        calls++;
        return [P("a", "A")];
      },
      noImage,
      { minRefreshMs: 100, now: () => t },
    );
    expect(await dir.profile("x")).toBeUndefined();
    expect(await dir.profile("x")).toBeUndefined();
    expect(calls).toBe(1);
    t = 150;
    await dir.profile("x");
    expect(calls).toBe(2);
  });

  it("取得に失敗しても投げない", async () => {
    const dir = createMemberDirectory(async () => {
      throw new Error("x");
    }, noImage);
    expect(await dir.profile("a")).toBeUndefined();
  });

  it("アイコンは中身で形式を見て、パスごとに覚える。一時的な失敗は覚えない", async () => {
    let calls = 0;
    let flaky = 0;
    const dir = createMemberDirectory(async () => [], async (path) => {
      calls++;
      if (path === "flaky" && ++flaky === 1) throw new Error("503");
      return path === "heic" ? Buffer.from("....ftypheic") : JPEG;
    });
    expect((await dir.avatar("a.heic"))?.ext).toBe("jpg");
    await dir.avatar("a.heic");
    expect(calls).toBe(1);
    expect(await dir.avatar("heic")).toBeUndefined();
    expect(await dir.avatar("flaky")).toBeUndefined();
    expect((await dir.avatar("flaky"))?.ext).toBe("jpg");
  });

  it("sniffImage は JPEG・PNG・WebP・GIF だけを通す", () => {
    expect(sniffImage(JPEG)).toBe("jpg");
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(Buffer.from("RIFF0000WEBP"))).toBe("webp");
    expect(sniffImage(Buffer.from("GIF89a"))).toBe("gif");
    expect(sniffImage(Buffer.from("....ftypheic"))).toBeUndefined();
  });
});

describe("レビューで直した点", () => {
  it("名前を 1 行・64 文字にする（embed の author は Markdown を解釈しないのでエスケープしない）", () => {
    expect(displayName("# 見出し\n[公式](x)")).toBe("# 見出し [公式](x)");
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
    const { run, posts } = setup({ profile: () => new Promise(() => {}), nameTimeoutMs: 20 });
    await run();
    expect(posts[0].authorName).toBe("メンバー");
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
