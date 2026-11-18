import { describe, expect, it } from "vitest";
import { openState } from "./state";

describe("状態ストア", () => {
  it("処理済みのメッセージを記録して判定できる", () => {
    const s = openState(":memory:");
    expect(s.isProcessed("m1")).toBe(false);
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "clip", timestamp: 1000, result: "posted", discordMessageId: "d1" });
    expect(s.isProcessed("m1")).toBe(true);
    s.close();
  });

  it("同じ messageId を 2 回記録しても落ちない（最初の記録を残す）", () => {
    const s = openState(":memory:");
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "text", timestamp: 1000, result: "posted" });
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "text", timestamp: 1000, result: "failed" });
    expect(s.isProcessed("m1")).toBe(true);
    s.close();
  });

  it("cursor は会話ごとの最大の timestamp を持ち、戻らない", () => {
    const s = openState(":memory:");
    expect(s.getCursor("c1")).toBeNull();
    s.recordProcessed({ messageId: "m2", conversationId: "c1", kind: "text", timestamp: 2000, result: "posted" });
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "clip", timestamp: 1000, result: "posted" });
    expect(s.getCursor("c1")).toBe(2000);
    expect(s.getCursor("c2")).toBeNull();
    s.close();
  });

  it("ファイルに保存して開き直しても残る", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "state-test-"));
    try {
      const path = join(dir, "sub", "state.sqlite");
      const a = openState(path);
      a.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "clip", timestamp: 5, result: "skipped" });
      a.close();
      const b = openState(path);
      expect(b.isProcessed("m1")).toBe(true);
      expect(b.getCursor("c1")).toBe(5);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("会話ごとにその種類を記録したことがあるか分かる", () => {
    const s = openState(":memory:");
    expect(s.hasProcessedKind("c1", "text")).toBe(false);
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "clip", timestamp: 1, result: "posted" });
    expect(s.hasProcessedKind("c1", "text")).toBe(false);
    s.recordProcessed({ messageId: "m2", conversationId: "c1", kind: "text", timestamp: 2, result: "skipped" });
    expect(s.hasProcessedKind("c1", "text")).toBe(true);
    expect(s.hasProcessedKind("c2", "text")).toBe(false);
    s.close();
  });

  it("投稿した setlog のメッセージから Discord のメッセージ ID を引く", () => {
    const s = openState(":memory:");
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "text", timestamp: 1, result: "posted", discordMessageId: "d1" });
    s.recordProcessed({ messageId: "m2", conversationId: "c1", kind: "text", timestamp: 2, result: "failed" });
    expect(s.discordMessageIdOf("m1")).toBe("d1");
    expect(s.discordMessageIdOf("m2")).toBeUndefined();
    expect(s.discordMessageIdOf("none")).toBeUndefined();
    s.close();
  });
});
