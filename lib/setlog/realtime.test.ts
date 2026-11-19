import { describe, expect, it } from "vitest";
import { messageKind, parseFrame, parseMessageHead } from "./realtime";

const text = {
  conversationId: "conv-1",
  messageId: "m-1",
  senderId: "u-friend",
  messageType: "text",
  type: "chat",
  timestamp: 1763470000000,
  keys: [],
  contentType: "text/plain",
  envelope: { v: 1, aadB64: "x", combinedB64: "y", alg: "CHACHA20-POLY1305" },
};

describe("parseFrame", () => {
  it("newMessage はメッセージ本体を返し、余分な項目も残す", () => {
    const f = parseFrame(JSON.stringify({ action: "newMessage", data: text }));
    expect(f.kind).toBe("message");
    if (f.kind !== "message") return;
    expect(f.message.messageId).toBe("m-1");
    expect((f.message as Record<string, unknown>).envelope).toEqual(text.envelope);
  });

  it("newMessage 以外の action はその名前だけを返す", () => {
    expect(parseFrame(JSON.stringify({ action: "typing", data: { conversationId: "c" } }))).toEqual({
      kind: "other",
      action: "typing",
    });
  });

  it("newMessage の形が違えば action と欠けたキー名を返し、値は出さない", () => {
    const { messageId: _drop, ...rest } = text;
    const f = parseFrame(JSON.stringify({ action: "newMessage", data: { ...rest, secret: "本文" } }));
    expect(f.kind).toBe("invalid");
    if (f.kind !== "invalid") return;
    expect(f.action).toBe("newMessage");
    expect(f.detail).toMatch(/messageId/);
    expect(JSON.stringify(f)).not.toMatch(/本文|u-friend/);
  });

  it("JSON でなければ invalid", () => {
    expect(parseFrame("not json").kind).toBe("invalid");
  });

  it("action が無ければ invalid", () => {
    expect(parseFrame(JSON.stringify({ data: {} })).kind).toBe("invalid");
  });
});

describe("parseMessageHead", () => {
  it("REST のメッセージ（senderName・isDeleted 付き）も通る", () => {
    const r = parseMessageHead({ ...text, senderName: "友達", isDeleted: false });
    expect(r.success).toBe(true);
  });
});

describe("messageKind", () => {
  it("contentType で clip / text / other に分ける", () => {
    expect(messageKind({ contentType: "video/mp4" })).toBe("clip");
    // iPhone から撮ったクリップは video/quicktime で届く（2026-11-19 実測）
    expect(messageKind({ contentType: "video/quicktime" })).toBe("clip");
    expect(messageKind({ contentType: "text/plain" })).toBe("text");
    expect(messageKind({ contentType: "image/jpeg" })).toBe("photo");
    expect(messageKind({ contentType: "image/png" })).toBe("photo");
    // 音声メッセージは type=snap・audio/mp4 で届く（2026-11-19 実測）
    expect(messageKind({ contentType: "audio/mp4" })).toBe("audio");
    expect(messageKind({ contentType: "audio/aac" })).toBe("audio");
    expect(messageKind({ contentType: "application/pdf" })).toBe("other");
  });
});
