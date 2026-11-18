import { describe, expect, it } from "vitest";
import { upsertEnv } from "./env-file";

describe("upsertEnv", () => {
  it("既存のキーだけを置き換え、他の行とコメントは残す", () => {
    const before = "# setlog\nSETLOG_X_API_KEY=k\nSETLOG_TOKEN=old\nDISCORD_TOKEN=d\n";
    expect(upsertEnv(before, { SETLOG_TOKEN: "new" })).toBe(
      "# setlog\nSETLOG_X_API_KEY=k\nSETLOG_TOKEN=new\nDISCORD_TOKEN=d\n",
    );
  });

  it("無いキーは末尾に足す", () => {
    expect(upsertEnv("A=1\n", { SETLOG_USER_ID: "u" })).toBe("A=1\nSETLOG_USER_ID=u\n");
  });

  it("空のファイルにも書ける", () => {
    expect(upsertEnv("", { A: "1" })).toBe("A=1\n");
  });

  it("前方一致の別キーを書き換えない", () => {
    expect(upsertEnv("SETLOG_TOKEN_OLD=x\n", { SETLOG_TOKEN: "y" })).toBe("SETLOG_TOKEN_OLD=x\nSETLOG_TOKEN=y\n");
  });

  it("値に改行があれば拒否する（別の行を注入させない）", () => {
    expect(() => upsertEnv("", { A: "1\nB=2" })).toThrow(/改行/);
  });

  it("CRLF のファイルも 1 行ずつ扱う", () => {
    expect(upsertEnv("A=1\r\nB=2\r\n", { B: "3" })).toBe("A=1\nB=3\n");
  });
});
