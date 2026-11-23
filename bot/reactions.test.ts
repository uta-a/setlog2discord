import { describe, expect, it } from "vitest";
import { SetlogAuthError, SetlogHttpError } from "../lib/setlog/client";
import { createReactionSync, type ReactionSyncDeps } from "./reactions";

function setup(over: Partial<ReactionSyncDeps> = {}) {
  const calls: { action: string; p: { conversationId: string; messageId: string; text: string } }[] = [];
  const notices: string[] = [];
  const table: Record<string, { messageId: string; conversationId: string }> = {
    "d-clip": { messageId: "m-clip", conversationId: "conv-collection" },
  };
  const sync = createReactionSync({
    lookup: (id) => table[id],
    addReaction: async (p) => {
      calls.push({ action: "add", p });
    },
    removeReaction: async (p) => {
      calls.push({ action: "remove", p });
    },
    notify: async (t) => {
      notices.push(t);
    },
    isHalted: () => false,
    ...over,
  });
  return { sync, calls, notices };
}

describe("createReactionSync", () => {
  it("友達の投稿に付けた・外した絵文字を、その投稿の会話とメッセージに送る", async () => {
    const { sync, calls, notices } = setup();
    await sync("d-clip", "😂", "add");
    await sync("d-clip", "😂", "remove");
    expect(calls).toEqual([
      { action: "add", p: { conversationId: "conv-collection", messageId: "m-clip", text: "😂" } },
      { action: "remove", p: { conversationId: "conv-collection", messageId: "m-clip", text: "😂" } },
    ]);
    expect(notices).toEqual([]);
  });

  it("友達の投稿でなければ黙って無視する", async () => {
    const { sync, calls, notices } = setup();
    await sync("d-my-own-or-status", "😂", "add");
    expect(calls).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("失敗したら理由を #bot-status に知らせ、送り直さない", async () => {
    let n = 0;
    const s = setup({
      addReaction: async () => {
        n++;
        throw new SetlogHttpError(500, "/chat/message/addReaction", "body");
      },
      removeReaction: async () => {
        throw new SetlogAuthError();
      },
    });
    await s.sync("d-clip", "❤️", "add");
    await s.sync("d-clip", "❤️", "remove");
    expect(n).toBe(1);
    expect(s.notices).toEqual([
      "Could not add the reaction ❤️ on setlog (HTTP 500).",
      "Could not remove the reaction ❤️ on setlog (setlog token has expired).",
    ]);
  });

  it("受信を止めている間は送らずに知らせる", async () => {
    const s = setup({ isHalted: () => true });
    await s.sync("d-clip", "✨", "add");
    expect(s.calls).toEqual([]);
    expect(s.notices[0]).toMatch(/receiving is stopped/);
  });
});
