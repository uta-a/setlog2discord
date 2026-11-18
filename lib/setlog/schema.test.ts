/**
 * fixtures（動的解析の実レスポンスを伏せ字にしたもの）が
 * スキーマを通ることを確認する。形が変わったら parse が落ちる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CollectionsResponseSchema,
  CalendarResponseSchema,
  MessagesResponseSchema,
  ProfileResponseSchema,
  LoginResponseSchema,
} from "./schema";

const load = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/${name}.json`, import.meta.url)), "utf-8"),
  );

describe("setlog スキーマ × fixtures", () => {
  it("groups.list（collections）", () => {
    const r = CollectionsResponseSchema.parse(load("groups.list"));
    expect(r.collections.length).toBe(2);
    expect(r.collections.map((c) => c.roomType).sort()).toEqual(["log", "vlog"]);
    expect(r.lastEvaluatedKey).toBeNull();
  });

  it("collections：tintColor が無い・lastName が null・roomType が無いグループも通る（2026-11-18 新アカウントで観測）", () => {
    const raw = load("groups.list");
    const g = raw.collections[0];
    delete g.roomType;
    delete g.participants[0].tintColor;
    g.participants[0].lastName = null;
    const r = CollectionsResponseSchema.parse(raw);
    expect(r.collections[0].roomType).toBeUndefined();
    expect(r.collections[0].participants[0].lastName).toBeNull();
  });

  it("calendar.month（days 配列のみ）", () => {
    const r = CalendarResponseSchema.parse(load("calendar.month"));
    expect(r.days).toEqual([3, 4]);
  });

  it("days.past（media は単一オブジェクト）", () => {
    const r = MessagesResponseSchema.parse(load("days.past"));
    expect(r.messages.length).toBe(1);
    const m = r.messages[0];
    expect(Array.isArray(m.media)).toBe(false);
    expect(m.media.mimeType).toBe("video/mp4");
    expect(m.media.dimensions).toEqual({ width: 1280, height: 720 });
    expect(m.keys.length).toBeGreaterThanOrEqual(1);
  });

  it("days.today（空の日）", () => {
    const r = MessagesResponseSchema.parse(load("days.today"));
    expect(r.messages).toEqual([]);
  });

  it("user.profile（token なし）", () => {
    const r = ProfileResponseSchema.parse(load("user.profile"));
    expect(r.user.token).toBeUndefined();
  });

  it("auth.login（token あり）", () => {
    const r = LoginResponseSchema.parse(load("auth.login"));
    expect(typeof r.user.token).toBe("string");
  });
});
