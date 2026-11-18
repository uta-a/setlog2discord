import { describe, expect, it } from "vitest";
import { channelProblems, guildsToLeave } from "./guard";

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
    expect(problems[0]).toMatch(/見つからない/);
    expect(problems[1]).toMatch(/guild/);
    expect(problems[2]).toMatch(/テキスト/);
    expect(problems[3]).toMatch(/送信/);
  });
});
