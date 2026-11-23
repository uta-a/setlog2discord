/**
 * 音声メッセージを mp3 に変換する（2026-11-23 に追加。設計書7.1）。
 *
 * setlog の音声は m4a（audio/mp4）で、Discord はカードのファイルの部品に m4a を入れてもプレイヤーを出さず、
 * ファイルのリンクになる。mp3 ならその場で再生できるので、ffmpeg で mp3 にしてから投稿する。
 *
 * - ffmpeg はサーバーに入れておく（deploy.md）。無い・変換できないときは投げ、呼び出し側が元のファイルのまま投稿する
 * - 入力は友達が送った未信頼のデータ。shell は使わず固定の引数で起動し、入力の形式を mime から決めて固定する。
 *   入力のファイルから別のファイルや URL を読みに行かないよう、プロトコルは file だけを許す。時間と出力の大きさに上限を付ける
 * - m4a は moov が末尾にあると標準入力からは読めない（長い音声で実測 2026-11-23）ので、入力は一時ファイルに書く。
 *   出力も、標準出力だと mp3 の頭に長さの情報（Xing ヘッダー）が入らずプレイヤーの長さがずれるので、ファイルに書く。
 *   一時ファイルは本人だけが読める場所（0700 のディレクトリ。Bot は UMask 0077 で動く）に作り、終わったら必ず消す
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 変換できなかった（ffmpeg が無い、入力が壊れている、時間切れ、大きすぎる）。 */
export class AudioConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioConvertError";
  }
}

/** 変換する音声の mime と、ffmpeg に指定する入力の形式。ここに無いものは変換しない。 */
const INPUT_FORMAT: Record<string, string> = {
  "audio/mp4": "mov",
  "audio/x-m4a": "mov",
  "audio/aac": "aac",
};

/** mp3 に変換できる（変換が要る）音声か。 */
export function canConvertToMp3(mimeType: string): boolean {
  return mimeType in INPUT_FORMAT;
}

export type Mp3Converter = (audio: Buffer, mimeType: string) => Promise<Buffer>;

export function createMp3Converter(
  opts: { ffmpegPath?: string; timeoutMs?: number; maxBytes?: number; tmpRoot?: string } = {},
): Mp3Converter {
  const ffmpeg = opts.ffmpegPath ?? "ffmpeg";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;

  return async (audio, mimeType) => {
    const format = INPUT_FORMAT[mimeType];
    if (!format) throw new AudioConvertError(`unsupported audio type: ${mimeType}`);
    const dir = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), "setlog-audio-"));
    try {
      const input = join(dir, "in");
      const output = join(dir, "out.mp3");
      await writeFile(input, audio, { mode: 0o600 });
      await run(
        ffmpeg,
        // prettier-ignore
        [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          // 入力の途中で壊れていたら、壊れた mp3 を出さずに失敗させる
          "-xerror",
          "-protocol_whitelist", "file",
          "-f", format, "-i", input,
          "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "4",
          // ディスクに書く量の歯止め。打ち切られた出力は上限より大きいので、下の大きさの確認で断る
          "-fs", String(maxBytes + 1024 * 1024),
          "-f", "mp3", output,
        ],
        timeoutMs,
      );
      const size = (await stat(output)).size;
      if (size > maxBytes) throw new AudioConvertError(`converted audio is too large (over ${maxBytes} B)`);
      const out = await readFile(output);
      if (!looksLikeMp3(out)) throw new AudioConvertError("ffmpeg produced no audio");
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** 出力の頭が ID3 タグか MPEG の音声フレームか（ffmpeg が失敗しても終了コード 0 で空に近い出力を返すことがあるため）。 */
export function looksLikeMp3(b: Buffer): boolean {
  if (b.length < 128) return false;
  if (b.subarray(0, 3).toString("latin1") === "ID3") return true;
  return b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    let failure: AudioConvertError | undefined;
    const stop = (e: AudioConvertError) => {
      failure ??= e;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new AudioConvertError(`ffmpeg timed out after ${timeoutMs} ms`)), timeoutMs);
    // エラーの文言だけを拾う（長すぎる分は捨てる）
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 500) stderr += c.toString("utf-8");
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new AudioConvertError(e.code === "ENOENT" ? "ffmpeg is not installed" : `ffmpeg could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) {
        const detail = stderr.trim().split("\n").pop()?.slice(0, 200) ?? "";
        return reject(new AudioConvertError(`ffmpeg exited with ${code}${detail ? `: ${detail}` : ""}`));
      }
      resolve();
    });
  });
}
