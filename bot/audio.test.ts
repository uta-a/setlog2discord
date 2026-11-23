import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AudioConvertError, canConvertToMp3, createMp3Converter, looksLikeMp3 } from "./audio";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const work = mkdtempSync(join(tmpdir(), "audio-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** ffmpeg で m4a を作る。ffmpeg の mp4 は既定で moov が末尾（iPhone の録音と同じく、標準入力からは読めない形）。 */
function makeM4a(seconds: number): Buffer {
  const path = join(work, `sine-${seconds}.m4a`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac", "-b:a", "128k", path]);
  return readFileSync(path);
}

describe("mp3 への変換", () => {
  it("変換するのは m4a・aac だけ", () => {
    expect(canConvertToMp3("audio/mp4")).toBe(true);
    expect(canConvertToMp3("audio/aac")).toBe(true);
    expect(canConvertToMp3("audio/mpeg")).toBe(false);
    expect(canConvertToMp3("video/mp4")).toBe(false);
  });

  it("mp3 の頭かどうかを見分ける", () => {
    expect(looksLikeMp3(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200)]))).toBe(true);
    expect(looksLikeMp3(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(200)]))).toBe(true);
    expect(looksLikeMp3(Buffer.alloc(200))).toBe(false);
    expect(looksLikeMp3(Buffer.from("ID3"))).toBe(false);
  });

  it("対象外の mime は ffmpeg を起動せずに断る", async () => {
    await expect(createMp3Converter({ ffmpegPath: "/nonexistent" })(Buffer.alloc(10), "audio/mpeg")).rejects.toThrow(/unsupported/);
  });

  it("ffmpeg が無ければ AudioConvertError（入れていないと分かる文言）", async () => {
    const tmpRoot = mkdtempSync(join(work, "root-"));
    const p = createMp3Converter({ ffmpegPath: join(work, "no-such-ffmpeg"), tmpRoot })(Buffer.alloc(10), "audio/mp4");
    await expect(p).rejects.toBeInstanceOf(AudioConvertError);
    await expect(p).rejects.toThrow(/not installed/);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)("moov が末尾の長い m4a も mp3 にでき、一時ファイルは残らない", async () => {
    const tmpRoot = mkdtempSync(join(work, "root-"));
    const mp3 = await createMp3Converter({ tmpRoot })(makeM4a(60), "audio/mp4");
    expect(looksLikeMp3(mp3)).toBe(true);
    const out = join(work, "out.mp3");
    writeFileSync(out, mp3);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
    expect(Number(probe.stdout.toString())).toBeGreaterThan(59);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)("壊れた入力は AudioConvertError で、一時ファイルは残らない", async () => {
    const tmpRoot = mkdtempSync(join(work, "root-"));
    await expect(createMp3Converter({ tmpRoot })(randomBytes(4096), "audio/mp4")).rejects.toBeInstanceOf(AudioConvertError);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)("出力が上限を超えたら止める", async () => {
    const p = createMp3Converter({ maxBytes: 1024 })(makeM4a(5), "audio/mp4");
    await expect(p).rejects.toThrow(/too large/);
  });
});
