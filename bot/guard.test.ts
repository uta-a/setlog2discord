import { describe, expect, it } from "vitest";
import { canUseCommand, channelProblems, guildsToLeave, sendTarget } from "./guard";

const G = "100000000000000001";
const ok = { guildId: G, isText: true, canSend: true };

describe("guildsToLeave", () => {
  it("設定した guild 以外をすべて返す", () => {
    expect(guildsToLeave([G, "200", "300"], G)).toEqual(["200", "300"]);
  });
  it("設定した guild だけなら空", () => {
    expect(guildsToLeave([G], G)).toEqual([]);
  });
});

describe("channelProblems", () => {
  it("問題が無ければ空", () => {
    expect(channelProblems([{ id: "1", purpose: "bot-status", info: ok }], G)).toEqual([]);
  });

  it("見つからない・別 guild・非テキスト・送信不可をそれぞれ報告する", () => {
    const problems = channelProblems(
      [
        { id: "1", purpose: "a", info: null },
        { id: "2", purpose: "b", info: { ...ok, guildId: "999" } },
        { id: "3", purpose: "c", info: { ...ok, isText: false } },
        { id: "4", purpose: "d", info: { ...ok, canSend: false } },
      ],
      G,
    );
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/not found/);
    expect(problems[1]).toMatch(/guild/);
    expect(problems[2]).toMatch(/not a text channel/);
    expect(problems[3]).toMatch(/cannot send/);
  });
});

describe("canUseCommand", () => {
  const cfg = { guildId: G, ownerUserId: "100000000000000002" };
  it("設定した guild の中の、自分だけが使える", () => {
    expect(canUseCommand({ guildId: G, userId: "100000000000000002" }, cfg)).toBe(true);
    expect(canUseCommand({ guildId: G, userId: "999" }, cfg)).toBe(false);
    expect(canUseCommand({ guildId: "200", userId: "100000000000000002" }, cfg)).toBe(false);
    expect(canUseCommand({ guildId: null, userId: "100000000000000002" }, cfg)).toBe(false);
  });
});

describe("sendTarget", () => {
  const groups = [
    { name: "a", chatChannelId: "300", chatConversationId: "conv-a" },
    { name: "b", chatChannelId: "400", chatConversationId: "conv-b" },
  ];
  const cfg = { guildId: G, ownerUserId: "100000000000000002", groups };
  const base = { guildId: G, channelId: "300", authorId: "100000000000000002", isBot: false, isWebhook: false, isSystem: false };
  it("設定した guild の chat チャンネルでの、自分の発言だけを送る", () => {
    expect(sendTarget(base, cfg)?.chatConversationId).toBe("conv-a");
    expect(sendTarget({ ...base, channelId: "400" }, cfg)?.chatConversationId).toBe("conv-b");
  });
  it("他人・Bot・Webhook・システムの発言、他のチャンネル・guild・DM は送らない", () => {
    expect(sendTarget({ ...base, authorId: "999" }, cfg)).toBeUndefined();
    expect(sendTarget({ ...base, isBot: true }, cfg)).toBeUndefined();
    expect(sendTarget({ ...base, isWebhook: true }, cfg)).toBeUndefined();
    expect(sendTarget({ ...base, isSystem: true }, cfg)).toBeUndefined();
    expect(sendTarget({ ...base, channelId: "500" }, cfg)).toBeUndefined();
    expect(sendTarget({ ...base, guildId: "200" }, cfg)).toBeUndefined();
    expect(sendTarget({ ...base, guildId: null }, cfg)).toBeUndefined();
  });
});
