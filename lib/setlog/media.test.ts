import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ClipDecryptError,
  MediaFetchError,
  clipTimeLabel,
  decryptClip,
  fetchMedia,
  mediaUrl,
} from "./media";
import { keypair, makeEncryptedClip } from "./test-helpers";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), randomBytes(64)]);

describe("decryptClip", () => {
  it("自分宛のエントリの kid で鍵を選んで mp4 に戻す", () => {
    const me = keypair();
    const { clip, bytes } = makeEncryptedClip(me, MP4);
    const out = decryptClip(clip, bytes, new Map([["kid-old", keypair().priv], ["kid-me", me.priv]]), "u-me");
    expect(out.equals(MP4)).toBe(true);
  });

  it("自分宛のエントリが無ければ ClipDecryptError", () => {
    const me = keypair();
    const { clip, bytes } = makeEncryptedClip(me, MP4);
    expect(() => decryptClip(clip, bytes, new Map([["kid-me", me.priv]]), "u-other")).toThrow(ClipDecryptError);
  });

  it("kid の鍵が手元に無ければ ClipDecryptError", () => {
    const me = keypair();
    const { clip, bytes } = makeEncryptedClip(me, MP4);
    expect(() => decryptClip(clip, bytes, new Map([["kid-x", me.priv]]), "u-me")).toThrow(/kid=/);
  });

  it("鍵が違えば ClipDecryptError", () => {
    const me = keypair();
    const { clip, bytes } = makeEncryptedClip(me, MP4);
    expect(() => decryptClip(clip, bytes, new Map([["kid-me", keypair().priv]]), "u-me")).toThrow(ClipDecryptError);
  });
});

describe("mediaUrl", () => {
  it("CDN の下の URL を作る", () => {
    expect(mediaUrl("ap/uploads/u/1-x").href).toBe("https://media.newchatapi.com/ap/uploads/u/1-x");
  });

  it("CDN 以外を指す path は拒否する", () => {
    expect(() => mediaUrl("//evil.example/x")).toThrow(ClipDecryptError);
    expect(() => mediaUrl("https://evil.example/x")).toThrow(ClipDecryptError);
  });
});

describe("fetchMedia", () => {
  const ok = (body: Buffer, headers: Record<string, string> = {}) =>
    (async () => new Response(new Uint8Array(body), { status: 200, headers })) as unknown as typeof fetch;

  it("認証ヘッダーを付けずに取得する", async () => {
    let seen: RequestInit | undefined;
    const f = (async (_u: URL, init: RequestInit) => {
      seen = init;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    expect([...(await fetchMedia("a/b", { fetchImpl: f }))]).toEqual([1, 2, 3]);
    expect(seen?.headers).toBeUndefined();
  });

  it("HTTP エラーと通信の失敗は MediaFetchError", async () => {
    const e500 = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchMedia("a", { fetchImpl: e500 })).rejects.toThrow(MediaFetchError);
    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchMedia("a", { fetchImpl: boom })).rejects.toThrow(MediaFetchError);
  });

  it("上限を超えたら ClipDecryptError（再試行しない側）", async () => {
    await expect(fetchMedia("a", { fetchImpl: ok(Buffer.alloc(20)), maxBytes: 10 })).rejects.toThrow(ClipDecryptError);
    await expect(
      fetchMedia("a", { fetchImpl: ok(Buffer.alloc(5), { "content-length": "999" }), maxBytes: 10 }),
    ).rejects.toThrow(ClipDecryptError);
  });
});

describe("clipTimeLabel", () => {
  it("JST の暦どおりに書く（04:00 区切りにしない）", () => {
    expect(clipTimeLabel(Date.UTC(2026, 10, 18, 13, 5))).toBe("11/18（水）22時台");
    expect(clipTimeLabel(Date.UTC(2026, 10, 18, 17, 30))).toBe("11/19（木）2時台");
  });
});
