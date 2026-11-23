import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SetlogClient,
  SetlogAuthError,
  SetlogSchemaError,
  SetlogHttpError,
  dayInterval,
  mediaApiBaseUrl,
} from "./client";

const load = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/${name}.json`, import.meta.url)), "utf-8");

const res = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const client = (fetchImpl: typeof fetch) =>
  new SetlogClient({ apiKey: "KEY", token: "TOKEN", minIntervalMs: 0, fetchImpl });

describe("dayInterval（JST 04:00 起点）", () => {
  it("24時間幅、start は JST 04:00", () => {
    const { start, end } = dayInterval("2026-11-18");
    expect(end - start).toBe(86_400_000);
    // JST 2026-11-18 04:00 = UTC 2026-11-17 19:00
    expect(new Date(start).toISOString()).toBe("2026-11-17T19:00:00.000Z");
  });
});

describe("SetlogClient", () => {
  it("collections を取得し検証する", async () => {
    const f = vi.fn(async () => res(load("groups.list"))) as unknown as typeof fetch;
    const r = await client(f).getCollections();
    expect(r.length).toBe(2);
  });

  it("認証ヘッダー jwt-key と x-api-key を送る", async () => {
    let seen: Headers | undefined;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers);
      return res(load("groups.list"));
    }) as unknown as typeof fetch;
    await client(f).getCollections();
    expect(seen?.get("jwt-key")).toBe("TOKEN");
    expect(seen?.get("x-api-key")).toBe("KEY");
  });

  it("401 は SetlogAuthError", async () => {
    const f = vi.fn(async () => res("unauthorized", 401)) as unknown as typeof fetch;
    await expect(client(f).getCollections()).rejects.toBeInstanceOf(SetlogAuthError);
  });

  it("スキーマ不一致は SetlogSchemaError", async () => {
    const f = vi.fn(async () => res(JSON.stringify({ wrong: true }))) as unknown as typeof fetch;
    await expect(client(f).getCollections()).rejects.toBeInstanceOf(SetlogSchemaError);
  });

  it("getDayMessages は startTimeInterval/endTimeInterval を付ける", async () => {
    let url = "";
    const f = vi.fn(async (u: string) => {
      url = u;
      return res(load("days.past"));
    }) as unknown as typeof fetch;
    const msgs = await client(f).getDayMessages("c1", "2026-11-18");
    expect(url).toContain("startTimeInterval=");
    expect(url).toContain("endTimeInterval=");
    expect(msgs.length).toBe(1);
  });

  it("getCalendar は単数 collection/ と month を使う", async () => {
    let url = "";
    const f = vi.fn(async (u: string) => {
      url = u;
      return res(load("calendar.month"));
    }) as unknown as typeof fetch;
    const r = await client(f).getCalendar("c1", 2026, 11);
    expect(url).toContain("/collection/c1/messageDaysInMonth");
    expect(url).toContain("month=11");
    expect(r.days).toEqual([3, 4]);
  });

  it("loginVerify は token を返す", async () => {
    const f = vi.fn(async () => res(load("auth.login"))) as unknown as typeof fetch;
    const user = await client(f).loginVerify("x@example.com", "000000");
    expect(typeof user.token).toBe("string");
  });

  it("sendTextMessage は返信先があるときだけ parentId を入れる", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return res(JSON.stringify({ success: true, messageId: "m1" }));
    }) as unknown as typeof fetch;
    const c = client(f);
    const base = { conversationId: "c1", messageId: "m1", envelope: { v: 1, alg: "CHACHA20-POLY1305", aadB64: "", combinedB64: "" }, keys: [] };
    await c.sendTextMessage({ ...base, parentId: "p1" });
    await c.sendTextMessage(base);
    await c.sendTextMessage({ ...base, parentId: "" });
    expect(bodies[0].parentId).toBe("p1");
    expect("parentId" in bodies[1]).toBe(false);
    expect("parentId" in bodies[2]).toBe(false);
  });

  it("getUploadUrl は ap-northeast-2 なら api-kr に暗号化済みとして頼み、key と region を返す", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return res(JSON.stringify({ uploadUrl: "https://bucket.s3.amazonaws.com/x?sig=1", region: "ap-northeast-2", key: "ap/uploads/u/1-a" }));
    }) as unknown as typeof fetch;
    const r = await client(f).getUploadUrl();
    expect(calls[0].url).toBe("https://api-kr.newchatapi.com/media/getUploadURL");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ contentType: "application/octet-stream", region: "ap-northeast-2", encrypted: true });
    expect(new Headers(calls[0].init?.headers).get("jwt-key")).toBe("TOKEN");
    expect(r).toEqual({ uploadUrl: "https://bucket.s3.amazonaws.com/x?sig=1", region: "ap-northeast-2", key: "ap/uploads/u/1-a" });
    expect(mediaApiBaseUrl("us-east-1")).toBe("https://api.newchatapi.com/media");
  });

  it("getUploadUrl は body に JSON 文字列で包まれた応答と url の名前も受ける。https でなければ投げる", async () => {
    const wrapped = JSON.stringify({ body: JSON.stringify({ url: "https://h/u", region: "r", key: "k" }) });
    const ok = vi.fn(async () => res(wrapped)) as unknown as typeof fetch;
    expect((await client(ok).getUploadUrl()).uploadUrl).toBe("https://h/u");
    const http = vi.fn(async () => res(JSON.stringify({ uploadUrl: "http://h/u", region: "r", key: "k" }))) as unknown as typeof fetch;
    await expect(client(http).getUploadUrl()).rejects.toBeInstanceOf(SetlogSchemaError);
    const none = vi.fn(async () => res(JSON.stringify({ region: "r", key: "k" }))) as unknown as typeof fetch;
    await expect(client(none).getUploadUrl()).rejects.toBeInstanceOf(SetlogSchemaError);
  });

  it("uploadMedia は setlog のトークンを付けずに octet-stream で PUT する", async () => {
    let seen: RequestInit | undefined;
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      seen = init;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await client(f).uploadMedia("https://bucket/x?sig=1", Buffer.from("cipher"));
    const h = new Headers(seen?.headers);
    expect(seen?.method).toBe("PUT");
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("jwt-key")).toBeNull();
    expect(h.get("x-api-key")).toBeNull();
    expect(seen?.redirect).toBe("error");
    const bad = vi.fn(async () => new Response("<Error>sig</Error>", { status: 403 })) as unknown as typeof fetch;
    const err = await client(bad).uploadMedia("https://bucket/x", Buffer.from("c")).catch((e) => e);
    expect(err).toBeInstanceOf(SetlogHttpError);
    expect((err as SetlogHttpError).body).toBe("");
    await expect(client(f).uploadMedia("http://bucket/x", Buffer.from("c"))).rejects.toThrow();
  });

  it("sendMediaMessage はアプリと同じ形の snap を送る（mediaCipherV=1、envelope なし）", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return res(JSON.stringify({ success: true, messageId: "m1" }));
    }) as unknown as typeof fetch;
    const c = client(f);
    const base = { conversationId: "c1", messageId: "m1", mimeType: "image/jpeg" as const, keys: [] };
    await c.sendMediaMessage({ ...base, media: { path: "ap/uploads/u/1-a", region: "ap-northeast-2", width: 720, height: 1280 }, parentId: "p1" });
    await c.sendMediaMessage({ ...base, media: { path: "p", region: "r", width: 0, height: 10 } });
    const b = bodies[0];
    expect(Object.keys(b).sort()).toEqual(
      ["contentType", "conversationId", "keys", "media", "mediaCipherV", "messageId", "parentId", "refreshesStaleKeys", "type", "uuid"].sort(),
    );
    expect(b).toMatchObject({ type: "snap", contentType: "image/jpeg", mediaCipherV: 1, parentId: "p1", refreshesStaleKeys: true });
    expect(b.media).toEqual({
      path: "ap/uploads/u/1-a",
      region: "ap-northeast-2",
      mimeType: "image/jpeg",
      dimensions: { width: 720, height: 1280 },
      permission: "allow_saving",
    });
    expect(b.uuid).not.toBe(b.messageId);
    expect("dimensions" in (bodies[1].media as object)).toBe(false);
    expect("parentId" in bodies[1]).toBe(false);
  });

  it("addReaction・removeReaction はアプリと同じ本文を送り、応答本文が空でも成功にする", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const c = client(f);
    await c.addReaction({ conversationId: "c1", messageId: "m1", text: "👍🏽" });
    await c.removeReaction({ conversationId: "c1", messageId: "m1", text: "👍🏽" });
    expect(calls[0].url).toBe("https://api.newchatapi.com/chat/message/addReaction");
    expect(calls[0].body).toMatchObject({ conversationId: "c1", messageId: "m1", text: "👍🏽", factor: 1, scale: 1 });
    expect(typeof calls[0].body.id).toBe("string");
    expect(calls[1].url).toBe("https://api.newchatapi.com/chat/message/removeReaction");
    expect(calls[1].body).toEqual({ conversationId: "c1", messageId: "m1", text: "👍🏽" });
  });

  it("addReaction の 401 は SetlogAuthError、それ以外の失敗は SetlogHttpError", async () => {
    const r401 = vi.fn(async () => res("", 401)) as unknown as typeof fetch;
    await expect(client(r401).addReaction({ conversationId: "c", messageId: "m", text: "x" })).rejects.toBeInstanceOf(SetlogAuthError);
    const r500 = vi.fn(async () => res("oops", 500)) as unknown as typeof fetch;
    await expect(client(r500).addReaction({ conversationId: "c", messageId: "m", text: "x" })).rejects.toBeInstanceOf(SetlogHttpError);
  });
});
