import { describe, expect, it, vi } from "vitest";
import { downloadAttachment, isDiscordCdnUrl } from "./attachments";
import { SendError } from "./sender";

const ok = (body: Uint8Array | string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

describe("isDiscordCdnUrl", () => {
  it("Discord の CDN の https だけを通す", () => {
    expect(isDiscordCdnUrl("https://cdn.discordapp.com/attachments/1/2/a.jpg?ex=1")).toBe(true);
    expect(isDiscordCdnUrl("https://media.discordapp.net/attachments/1/2/a.jpg")).toBe(true);
    expect(isDiscordCdnUrl("http://cdn.discordapp.com/a.jpg")).toBe(false);
    expect(isDiscordCdnUrl("https://cdn.discordapp.com.evil.example/a.jpg")).toBe(false);
    expect(isDiscordCdnUrl("https://example.com/a.jpg")).toBe(false);
    expect(isDiscordCdnUrl("not a url")).toBe(false);
  });
});

describe("downloadAttachment", () => {
  const url = "https://cdn.discordapp.com/attachments/1/2/a.jpg";

  it("本体を取得する。リダイレクトはたどらない", async () => {
    let init: RequestInit | undefined;
    const f = vi.fn(async (_u: string, i?: RequestInit) => {
      init = i;
      return ok("abc", { "content-length": "3" });
    }) as unknown as typeof fetch;
    expect((await downloadAttachment(url, { maxBytes: 10, fetchImpl: f })).toString()).toBe("abc");
    expect(init?.redirect).toBe("error");
  });

  it("CDN 以外の URL は取得しない", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    await expect(downloadAttachment("https://example.com/a.jpg", { maxBytes: 10, fetchImpl: f })).rejects.toBeInstanceOf(SendError);
    expect(f).not.toHaveBeenCalled();
  });

  it("上限を超えるものは宣言でも実際の長さでも打ち切る", async () => {
    const declared = vi.fn(async () => ok("abc", { "content-length": "999" })) as unknown as typeof fetch;
    await expect(downloadAttachment(url, { maxBytes: 10, fetchImpl: declared })).rejects.toThrow(/too large/);
    const actual = vi.fn(async () => ok("x".repeat(20))) as unknown as typeof fetch;
    await expect(downloadAttachment(url, { maxBytes: 10, fetchImpl: actual })).rejects.toThrow(/too large/);
  });

  it("HTTP の失敗・通信の失敗・途中で切れた本体は、URL を含まない理由にする", async () => {
    const r404 = vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const e = await downloadAttachment(url, { maxBytes: 10, fetchImpl: r404 }).catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect(String(e)).not.toContain("cdn.discordapp.com");
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(downloadAttachment(url, { maxBytes: 10, fetchImpl: down })).rejects.toThrow(/could not download/);
    const cut = vi.fn(async () => ok("ab", { "content-length": "5" })) as unknown as typeof fetch;
    await expect(downloadAttachment(url, { maxBytes: 10, fetchImpl: cut })).rejects.toThrow(/could not download/);
  });
});
