import { describe, expect, it } from "vitest";
import { replyLine, webhookUsername } from "./webhooks";

describe("webhookUsername", () => {
  it("友達の名前をそのまま使う", () => {
    expect(webhookUsername("たろう")).toBe("たろう");
  });

  it("Discord が Webhook の名前に使わせない語（discord・clyde）を崩し、80 文字で切る", () => {
    expect(webhookUsername("Discord好き")).not.toMatch(/discord/i);
    expect(webhookUsername("clyde")).not.toMatch(/clyde/i);
    expect([...webhookUsername("あ".repeat(100))].length).toBe(80);
  });

  it("空なら既定の名前", () => {
    expect(webhookUsername("   ")).toBe("メンバー");
  });
});

describe("replyLine", () => {
  it("返信先のメッセージへのリンクを小さい字の 1 行で作る（Webhook は Discord の返信を作れないため）", () => {
    expect(replyLine("1", "2", "3")).toBe("-# 返信: https://discord.com/channels/1/2/3");
  });
});
