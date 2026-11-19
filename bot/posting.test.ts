import { describe, expect, it } from "vitest";
import { captionText } from "./posting";

describe("captionText", () => {
  it("空でないキャプションを行ごとにつなぐ（setlog のキャプションは平文）", () => {
    const media = {
      captions: [
        { style: 0, text: " 海 ", time: "", translation: "{0, 0}" },
        { style: 0, text: "", time: "", translation: "{0, 0}" },
        { style: 0, text: "最高", time: "", translation: "{0, 0}" },
      ],
    };
    expect(captionText(media)).toBe("海\n最高");
  });

  it("キャプションが無い・空・形が違うときは undefined（クリップの投稿は止めない）", () => {
    expect(captionText({})).toBeUndefined();
    expect(captionText({ captions: [{ text: "  " }] })).toBeUndefined();
    expect(captionText({ captions: "x" })).toBeUndefined();
    expect(captionText({ captions: [{ text: 1 }, null] })).toBeUndefined();
    expect(captionText(undefined)).toBeUndefined();
  });

  it("制御文字を除き、行の中の改行は空白にし、長すぎれば切る", () => {
    expect(captionText({ captions: [{ text: "a\u0000b‮c\nd" }] })).toBe("a b c d");
    expect([...(captionText({ captions: [{ text: "あ".repeat(500) }] }) ?? "")].length).toBe(200);
  });
});
