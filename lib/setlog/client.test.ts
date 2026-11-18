import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SetlogClient,
  SetlogAuthError,
  SetlogSchemaError,
  dayInterval,
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
});
