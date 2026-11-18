import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { toDateHour, toDayView, toGroup } from "./transform";
import { CollectionsResponseSchema, MessagesResponseSchema } from "./schema";

const load = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/${name}.json`, import.meta.url)), "utf-8"),
  );

// JST の壁時計時刻 → UTC ミリ秒（UTC+9 固定）
const jst = (y: number, mo: number, d: number, h: number, mi = 0) =>
  Date.UTC(y, mo - 1, d, h - 9, mi);

describe("toDateHour（04:00 境界）", () => {
  it("04:00 ちょうどは当日の枠 0", () => {
    expect(toDateHour(jst(2026, 11, 18, 4, 0))).toEqual({ date: "2026-11-18", hour: 0 });
  });

  it("03:59 は前日の枠 23", () => {
    expect(toDateHour(jst(2026, 11, 18, 3, 59))).toEqual({ date: "2026-11-17", hour: 23 });
  });

  it("正午は当日の枠 8", () => {
    expect(toDateHour(jst(2026, 11, 18, 12, 0))).toEqual({ date: "2026-11-18", hour: 8 });
  });

  it("23:00 は当日の枠 19", () => {
    expect(toDateHour(jst(2026, 11, 18, 23, 0))).toEqual({ date: "2026-11-18", hour: 19 });
  });

  it("00:30 は前日の枠 20", () => {
    expect(toDateHour(jst(2026, 11, 18, 0, 30))).toEqual({ date: "2026-11-17", hour: 20 });
  });

  it("月初 04:00 直前は前月末日に繰り下がる", () => {
    expect(toDateHour(jst(2026, 12, 1, 3, 0))).toEqual({ date: "2026-11-30", hour: 23 });
  });
});

describe("toDayView", () => {
  it("常に 24 枠、空の枠も埋める", () => {
    const r = MessagesResponseSchema.parse(load("days.today"));
    const dv = toDayView("g1", "2026-11-18", r.messages);
    expect(dv.slots.length).toBe(24);
    expect(dv.slots.every((s) => s.clips.length === 0)).toBe(true);
    expect(dv.slots.map((s) => s.hour)).toEqual([...Array(24).keys()]);
  });

  it("days.past のクリップが正しい日付の枠に入る", () => {
    const r = MessagesResponseSchema.parse(load("days.past"));
    // timestamp 1793787469660 の JST 日付
    const { date } = toDateHour(r.messages[0].timestamp);
    const dv = toDayView("g1", date, r.messages);
    const filled = dv.slots.filter((s) => s.clips.length > 0);
    expect(filled.length).toBe(1);
    expect(filled[0].clips[0].mimeType).toBe("video/mp4");
  });

  it("指定日と違う日のメッセージは入らない", () => {
    const r = MessagesResponseSchema.parse(load("days.past"));
    const dv = toDayView("g1", "2000-01-01", r.messages);
    expect(dv.slots.every((s) => s.clips.length === 0)).toBe(true);
  });
});

describe("toGroup", () => {
  it("参加者が自分だけ/0人ならソロ", () => {
    const r = CollectionsResponseSchema.parse(load("groups.list"));
    const self = "00000000-0000-4000-8000-000000000006";
    const groups = r.collections.map((c) => toGroup(c, self));
    expect(groups.every((g) => g.isSolo)).toBe(true);
  });
});
