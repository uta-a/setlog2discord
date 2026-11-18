/**
 * 実データでライブラリの復号を検証する統合テスト。
 * .secrets.*（gitignore 済み）と captures/direct の実キャプチャが揃っているときだけ走る。
 * 無ければ skip（CI や他環境では走らない）。
 *
 * 流れ：パスフレーズ → 秘密鍵復元 → content key アンラップ → メディア復号 → mp4 確認。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  recoverPrivateKeyFromBackup,
  unwrapContentKey,
  decryptMedia,
  decryptText,
  type KeyBackup,
} from "./crypto";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const PASS = `${repo}.secrets.passphrase`;
const BACKUP = `${repo}.secrets.keybackup.json`;
const CLIP = `${repo}.secrets.clip.bin`;
const SELF = "5947ea73-b26b-5abc-9f15-67122c722f24";

function findTodayCapture(): string | null {
  const dir = `${repo}captures/direct`;
  if (!existsSync(dir)) return null;
  // today-*.json のうち、自分宛クリップが入っているものを選ぶ
  for (const n of readdirSync(dir)) {
    if (!n.startsWith("today-") || !n.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(`${dir}/${n}`, "utf-8"));
      const ms = d.messages ?? [];
      if (ms.some((m: { keys?: { uid: string }[] }) => m.keys?.some((k) => k.uid === SELF))) {
        return `${dir}/${n}`;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

const ready = existsSync(PASS) && existsSync(BACKUP) && existsSync(CLIP) && !!findTodayCapture();

describe.skipIf(!ready)("実クリップ復号（ライブラリ経由）", () => {
  it("パスフレーズから mp4 まで通る", () => {
    const passphrase = readFileSync(PASS, "utf-8").trim();
    const { backup } = JSON.parse(readFileSync(BACKUP, "utf-8")) as { backup: KeyBackup };
    const { privateKey } = recoverPrivateKeyFromBackup(backup, passphrase);

    const day = JSON.parse(readFileSync(findTodayCapture()!, "utf-8"));
    const msg = day.messages[day.messages.length - 1];
    const entry = msg.keys.find((k: { uid: string }) => k.uid === SELF);
    expect(entry).toBeTruthy();

    const contentKey = unwrapContentKey(entry, privateKey, msg.conversationId, msg.senderId);
    expect(contentKey.length).toBe(32);

    const fileBytes = readFileSync(CLIP);
    const mp4 = decryptMedia(contentKey, fileBytes, msg.conversationId, msg.messageId, msg.senderId, [
      msg.media.mimeType,
      msg.contentType,
      "application/octet-stream",
      "video/quicktime",
      "video/mp4",
    ]);
    // ftyp box を確認（mp4）
    expect(mp4.subarray(4, 8).toString("ascii")).toBe("ftyp");
  });

  it("実テキストメッセージを復号できる（dev-msgs があるとき）", () => {
    const f = `${repo}captures/direct/dev-msgs.json`;
    if (!existsSync(f)) return; // 無ければスキップ相当
    const passphrase = readFileSync(PASS, "utf-8").trim();
    const { backup } = JSON.parse(readFileSync(BACKUP, "utf-8")) as { backup: KeyBackup };
    const { privateKey } = recoverPrivateKeyFromBackup(backup, passphrase);
    const msgs = JSON.parse(readFileSync(f, "utf-8")).messages as {
      envelope?: unknown;
      contentType?: string;
    }[];
    const text = msgs.find((m) => m.envelope && m.contentType === "text/plain");
    if (!text) return;
    const out = decryptText(text as never, privateKey, SELF);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
