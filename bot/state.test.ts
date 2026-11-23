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

  it("会話ごとにその種類を初めて記録したメッセージの timestamp が分かる", () => {
    const s = openState(":memory:");
    expect(s.firstProcessedTimestamp("c1", "text")).toBeNull();
    s.recordProcessed({ messageId: "a", conversationId: "c1", kind: "text", timestamp: 50, result: "posted" });
    s.recordProcessed({ messageId: "b", conversationId: "c1", kind: "text", timestamp: 20, result: "posted" });
    expect(s.firstProcessedTimestamp("c1", "text")).toBe(20);
    expect(s.firstProcessedTimestamp("c1", "clip")).toBeNull();
    s.close();
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

  it("Discord から送った発言と setlog の messageId を記録する（同じ発言の 2 回目は無視）", () => {
    const s = openState(":memory:");
    expect(s.sentMessageIdOf("d1")).toBeUndefined();
    s.recordSent({ discordMessageId: "d1", setlogMessageId: "m1", conversationId: "c1" });
    s.recordSent({ discordMessageId: "d1", setlogMessageId: "m2", conversationId: "c1" });
    expect(s.sentMessageIdOf("d1")).toBe("m1");
    s.close();
  });

  it("Discord のメッセージから setlog のメッセージを引く（投稿したものと送ったもの）", () => {
    const s = openState(":memory:");
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "clip", timestamp: 1, result: "posted", discordMessageId: "d1" });
    s.recordProcessed({ messageId: "m2", conversationId: "c1", kind: "text", timestamp: 2, result: "failed" });
    s.recordSent({ discordMessageId: "d3", setlogMessageId: "m3", conversationId: "c2" });
    expect(s.setlogMessageOf("d1")).toEqual({ messageId: "m1", conversationId: "c1" });
    expect(s.setlogMessageOf("d3")).toEqual({ messageId: "m3", conversationId: "c2" });
    expect(s.setlogMessageOf("none")).toBeUndefined();
    // 友達が自分の発言に返信したときも Discord の返信にできるよう、送った発言も引ける
    expect(s.discordMessageIdOf("m3")).toBe("d3");
    s.close();
  });

  it("リアクションの対象は Bot が投稿した友達のメッセージだけ（自分が送った発言・失敗したものは引かない）", () => {
    const s = openState(":memory:");
    s.recordProcessed({ messageId: "m1", conversationId: "c1", kind: "clip", timestamp: 1, result: "posted", discordMessageId: "d1" });
    s.recordProcessed({ messageId: "m2", conversationId: "c1", kind: "text", timestamp: 2, result: "failed" });
    s.recordSent({ discordMessageId: "d3", setlogMessageId: "m3", conversationId: "c2" });
    expect(s.postedMessageOf("d1")).toEqual({ messageId: "m1", conversationId: "c1" });
    expect(s.postedMessageOf("d3")).toBeUndefined();
    expect(s.postedMessageOf("none")).toBeUndefined();
    s.close();
  });
});
