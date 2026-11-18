import { describe, expect, it } from "vitest";
import type { GroupConfig } from "./config";
import { createIngest, type IncomingMessage, type IngestOptions } from "./ingest";
import { openState } from "./state";

const group: GroupConfig = {
  name: "友達",
  conversationId: "conv-1",
  chatConversationId: "conv-1",
  clipsChannelId: "100000000000000004",
  chatChannelId: "100000000000000005",
};

const START = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;

function msg(id: string, over: Record<string, unknown> = {}) {
  return {
    messageId: id,
    conversationId: "conv-1",
    senderId: "u-friend",
    contentType: "text/plain",
    type: "chat",
    timestamp: START + 1000,
    ...over,
  };
}
const frame = (data: unknown) => JSON.stringify({ action: "newMessage", data });

function setup(over: Partial<IngestOptions> = {}) {
  const store = openState(":memory:");
  const seen: IncomingMessage[] = [];
  const notes: string[] = [];
  const rest: unknown[] = [];
  const ingest = createIngest({
    store,
    myUserId: "u-me",
    groups: [group],
    handler: async (m) => {
      seen.push(m);
      return { result: "posted" };
    },
    notify: async (t) => {
      notes.push(t);
    },
    fetchMessages: async () => rest,
    startedAt: START,
    now: () => START + 10 * HOUR,
    ...over,
  });
  return { store, seen, notes, rest, ingest };
}

describe("取り込み（WebSocket）", () => {
  it("友達のテキストとクリップをハンドラに渡し、記録する", async () => {
    const { ingest, seen, store } = setup();
    ingest.onFrame(frame(msg("m1")));
    ingest.onFrame(frame(msg("m2", { contentType: "video/mp4", type: "collection" })));
    await ingest.idle();
    expect(seen.map((m) => [m.kind, m.message.messageId, m.group.name])).toEqual([
      ["text", "m1", "友達"],
      ["clip", "m2", "友達"],
    ]);
    expect(store.isProcessed("m1")).toBe(true);
  });

  it("設定に無い会話・自分の発言・未対応の種類は捨てる", async () => {
    const { ingest, seen } = setup();
    ingest.onFrame(frame(msg("m1", { conversationId: "solo" })));
    ingest.onFrame(frame(msg("m2", { senderId: "u-me" })));
    ingest.onFrame(frame(msg("m3", { contentType: "image/jpeg" })));
    await ingest.idle();
    expect(seen).toEqual([]);
  });

  it("同じ messageId は 1 回しか処理しない", async () => {
    const { ingest, seen } = setup();
    ingest.onFrame(frame(msg("m1")));
    ingest.onFrame(frame(msg("m1")));
    await ingest.idle();
    expect(seen.length).toBe(1);
  });

  it("同じ会話は直列に処理する", async () => {
    const order: string[] = [];
    const { ingest } = setup({
      handler: async (m) => {
        order.push(`start ${m.message.messageId}`);
        await new Promise((r) => setTimeout(r, m.message.messageId === "m1" ? 30 : 0));
        order.push(`end ${m.message.messageId}`);
        return { result: "posted" };
      },
    });
    ingest.onFrame(frame(msg("m1")));
    ingest.onFrame(frame(msg("m2")));
    await ingest.idle();
    expect(order).toEqual(["start m1", "end m1", "start m2", "end m2"]);
  });

  it("ハンドラが undefined を返したら記録しない", async () => {
    const { ingest, store } = setup({ handler: async () => undefined });
    ingest.onFrame(frame(msg("m1")));
    await ingest.idle();
    expect(store.isProcessed("m1")).toBe(false);
    expect(store.getCursor("conv-1")).toBeNull();
  });

  it("ハンドラの例外で止まらず、記録もしない", async () => {
    let n = 0;
    const { ingest, store } = setup({
      handler: async () => {
        if (++n === 1) throw new Error("boom");
        return { result: "posted" };
      },
    });
    ingest.onFrame(frame(msg("m1")));
    ingest.onFrame(frame(msg("m2")));
    await ingest.idle();
    expect(store.isProcessed("m1")).toBe(false);
    expect(store.isProcessed("m2")).toBe(true);
  });

  it("状態ストアの例外でも後続を処理し、idle は解決する", async () => {
    const store = openState(":memory:");
    let n = 0;
    const flaky = {
      ...store,
      recordProcessed: (r: Parameters<typeof store.recordProcessed>[0]) => {
        if (++n === 1) throw new Error("disk full");
        store.recordProcessed(r);
      },
    };
    const { ingest } = setup({ store: flaky });
    ingest.onFrame(frame(msg("m1")));
    ingest.onFrame(frame(msg("m2")));
    await ingest.idle();
    expect(store.isProcessed("m1")).toBe(false);
    expect(store.isProcessed("m2")).toBe(true);
  });

  it("形が違うフレームは action ごとに 1 回だけ通知し、値は出さない", async () => {
    const { ingest, notes, seen } = setup();
    const bad = frame({ conversationId: "conv-1", senderId: "u-friend", secret: "本文" });
    ingest.onFrame(bad);
    ingest.onFrame(bad);
    ingest.onFrame(JSON.stringify({ action: "typing", data: {} }));
    await ingest.idle();
    expect(seen).toEqual([]);
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/newMessage/);
    expect(notes[0]).toMatch(/messageId/);
    expect(notes[0]).not.toMatch(/本文|u-friend/);
  });
});

describe("REST の補完", () => {
  it("初回（cursor 無し）は起動時刻より前を流さず、古い順に処理する", async () => {
    const { ingest, seen, rest } = setup();
    rest.push(msg("new2", { timestamp: START + 2000 }), msg("new1", { timestamp: START + 1000 }), msg("old", { timestamp: START - 1 }));
    await ingest.backfill();
    await ingest.idle();
    expect(seen.map((m) => m.message.messageId)).toEqual(["new1", "new2"]);
  });

  it("cursor があれば 24 時間前までさかのぼり、処理済みは飛ばす", async () => {
    const { ingest, seen, rest, store } = setup();
    store.recordProcessed({ messageId: "done", conversationId: "conv-1", kind: "text", timestamp: START, result: "posted" });
    rest.push(
      msg("done", { timestamp: START }),
      msg("late-clip", { timestamp: START - 23 * HOUR, contentType: "video/mp4" }),
      msg("too-old", { timestamp: START - 25 * HOUR }),
    );
    await ingest.backfill();
    await ingest.idle();
    expect(seen.map((m) => m.message.messageId)).toEqual(["late-clip"]);
  });

  it("テキストを 1 件も記録していない会話では、cursor があっても起動時刻より前のテキストを流さない", async () => {
    const { ingest, seen, rest, store } = setup();
    store.recordProcessed({ messageId: "clip0", conversationId: "conv-1", kind: "clip", timestamp: START, result: "posted" });
    rest.push(
      msg("old-text", { timestamp: START - HOUR }),
      msg("old-clip", { timestamp: START - HOUR, contentType: "video/mp4" }),
      msg("new-text", { timestamp: START + 1000 }),
    );
    await ingest.backfill();
    await ingest.idle();
    expect(seen.map((m) => m.message.messageId)).toEqual(["old-clip", "new-text"]);
  });

  it("テキストを記録したことがあれば、テキストも cursor の 24 時間前までさかのぼる", async () => {
    const { ingest, seen, rest, store } = setup();
    store.recordProcessed({ messageId: "t0", conversationId: "conv-1", kind: "text", timestamp: START, result: "posted" });
    rest.push(msg("old-text", { timestamp: START - HOUR }));
    await ingest.backfill();
    await ingest.idle();
    expect(seen.map((m) => m.message.messageId)).toEqual(["old-text"]);
  });

  it("自分の発言は捨てる", async () => {
    const { ingest, seen, rest } = setup();
    rest.push(msg("mine", { senderId: "u-me" }));
    await ingest.backfill();
    await ingest.idle();
    expect(seen).toEqual([]);
  });

  it("beforeTimestamp に現在時刻、limit に 40 を渡し、同じ会話は 1 回だけ叩く", async () => {
    const calls: unknown[] = [];
    const { ingest } = setup({
      groups: [group, { ...group, name: "同じ" }],
      fetchMessages: async (conv, o) => {
        calls.push([conv, o]);
        return [];
      },
    });
    await ingest.backfill();
    expect(calls).toEqual([["conv-1", { limit: 40, beforeTimestamp: START + 10 * HOUR }]]);
  });

  it("形が違う項目は飛ばして残りを処理し、1 回だけ通知する", async () => {
    const { ingest, seen, rest, notes } = setup();
    rest.push({ broken: true }, { broken: true }, msg("ok"));
    await ingest.backfill();
    await ingest.idle();
    expect(seen.map((m) => m.message.messageId)).toEqual(["ok"]);
    expect(notes.length).toBe(1);
  });

  it("取得の例外はそのまま投げる（401 の停止は呼び出し側で扱う）", async () => {
    const { ingest } = setup({
      fetchMessages: async () => {
        throw new Error("401");
      },
    });
    await expect(ingest.backfill()).rejects.toThrow("401");
  });
});
