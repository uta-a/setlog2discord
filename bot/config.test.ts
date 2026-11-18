import { describe, expect, it } from "vitest";
import { ConfigError, configuredChannels, loadConfig } from "./config";

const file = {
  guildId: "100000000000000001",
  ownerUserId: "100000000000000002",
  statusChannelId: "100000000000000003",
  groups: [
    {
      name: "友達",
      conversationId: "conv-1",
      clipsChannelId: "100000000000000004",
      chatChannelId: "100000000000000005",
    },
  ],
};
const env = { DISCORD_TOKEN: "secret-token-value" };

describe("loadConfig", () => {
  it("chatConversationId を省略すると conversationId と同じになる", () => {
    const c = loadConfig(env, JSON.stringify(file));
    expect(c.groups[0].chatConversationId).toBe("conv-1");
    expect(c.discordToken).toBe("secret-token-value");
  });

  it("chatConversationId を指定すればそれを使う", () => {
    const f = { ...file, groups: [{ ...file.groups[0], chatConversationId: "conv-chat" }] };
    expect(loadConfig(env, JSON.stringify(f)).groups[0].chatConversationId).toBe("conv-chat");
  });

  it("トークンが無ければ項目名だけを出して失敗する", () => {
    expect(() => loadConfig({}, JSON.stringify(file))).toThrow(/DISCORD_TOKEN/);
  });

  it("エラーメッセージにトークンの値を含めない", () => {
    const bad = { ...file, guildId: "not-a-snowflake" };
    try {
      loadConfig(env, JSON.stringify(bad));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String(e)).toMatch(/guildId/);
      expect(String(e)).not.toMatch(/secret-token-value/);
    }
  });

  it("JSON でなければ失敗する", () => {
    expect(() => loadConfig(env, "{")).toThrow(ConfigError);
  });

  it("グループが空なら失敗する", () => {
    expect(() => loadConfig(env, JSON.stringify({ ...file, groups: [] }))).toThrow(/groups/);
  });

  it("同じチャンネルを複数の用途に使うと失敗する", () => {
    const f = { ...file, groups: [{ ...file.groups[0], chatChannelId: file.statusChannelId }] };
    expect(() => loadConfig(env, JSON.stringify(f))).toThrow(/100000000000000003/);
  });
});

describe("configuredChannels", () => {
  it("status とグループごとの 2 チャンネルを並べる", () => {
    const c = loadConfig(env, JSON.stringify(file));
    expect(configuredChannels(c).map((x) => x.id)).toEqual([
      "100000000000000003",
      "100000000000000004",
      "100000000000000005",
    ]);
  });
});
