import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ClipDecryptError,
  MediaFetchError,
  clipTimeText,
  parseTintColor,
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

describe("clipTimeText", () => {
  it("JST の暦どおりに分まで書く（04:00 区切りにしない）", () => {
    expect(clipTimeText(Date.UTC(2026, 10, 18, 13, 5))).toBe("11/18（水）22:05");
    expect(clipTimeText(Date.UTC(2026, 10, 18, 17, 30))).toBe("11/19（木）2:30");
  });
});

describe("parseTintColor", () => {
  it("各成分 16 ビットの形と、#RRGGBB・#RRGGBBAA を 0xRRGGBB にする", () => {
    expect(parseTintColor("#6565EAEA7B7BFFFF")).toBe(0x65ea7b);
    expect(parseTintColor("#11d5f3")).toBe(0x11d5f3);
    expect(parseTintColor("#11d5f3ff")).toBe(0x11d5f3);
  });
  it("読めなければ undefined", () => {
    expect(parseTintColor(undefined)).toBeUndefined();
    expect(parseTintColor(null)).toBeUndefined();
    expect(parseTintColor("red")).toBeUndefined();
    expect(parseTintColor("#123")).toBeUndefined();
  });
});

describe("レビューで直した点", () => {
  const res = (status: number, body: Uint8Array = new Uint8Array(), headers: Record<string, string> = {}) =>
    (async () => new Response(status === 200 ? body : "x", { status, headers })) as unknown as typeof fetch;

  it("CDN の 403・404・410 は再試行しない側（ClipDecryptError）", async () => {
    for (const st of [403, 404, 410]) await expect(fetchMedia("a", { fetchImpl: res(st) })).rejects.toThrow(ClipDecryptError);
  });

  it("URL として読めない path は ClipDecryptError", () => {
    expect(() => mediaUrl("http://[")).toThrow(ClipDecryptError);
  });

  it("本体が content-length より短ければ再試行する側（MediaFetchError）", async () => {
    await expect(
      fetchMedia("a", { fetchImpl: res(200, new Uint8Array(5), { "content-length": "10" }) }),
    ).rejects.toThrow(MediaFetchError);
  });

  it("受信の途中で上限を超えたら止める", async () => {
    const f = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(8));
          },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchMedia("a", { fetchImpl: f, maxBytes: 20 })).rejects.toThrow(ClipDecryptError);
  });

  it("自分宛のエントリが複数あれば、手元に鍵がある kid のものを使う", () => {
    const me = keypair();
    const { clip, bytes } = makeEncryptedClip(me, MP4);
    const stale = { ...clip.keys[0], kid: "kid-gone" };
    const out = decryptClip({ ...clip, keys: [stale, clip.keys[0]] }, bytes, new Map([["kid-me", me.priv]]), "u-me");
    expect(out.equals(MP4)).toBe(true);
  });
});
