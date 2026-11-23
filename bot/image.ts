/**
 * HEIC の写真を JPEG に変換する（2026-11-23 に追加。設計書7.1）。
 *
 * 写真は image/heic で届くことがある（2026-11-23 に 1 件届いた。送った端末は分からない）。Discord は HEIC を表示できず、カードの画像の枠に
 * 入れると「画像を読み込めませんでした」になるので、JPEG にしてから投稿する。
 *
 * - 変換は heic-convert（heic-decode が libheif-js の wasm 版を読む）で、プロセスの中で行う。サーバーに追加のソフトは要らない
 * - 入力は友達が送った未信頼のデータ。wasm の中で読むのでファイルや外部には触れない。
 *   出力が JPEG の頭で始まることと、大きさの上限を確かめる
 * - 変換中はイベントループを止める（720×1280 で約 150ms。実測 2026-11-23）。setlog の写真はこの程度の大きさなので許容する
 * - 実物（720×1280）を変換した JPEG は、寸法が media.dimensions と一致した（その写真に回転の指定があったかは見ていない）
 */
import heicConvert from "heic-convert";

/** 変換できなかった（入力が壊れている、出力が大きすぎる）。 */
export class ImageConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageConvertError";
  }
}

/** JPEG に変換する（変換が要る）画像の mime。 */
const CONVERTIBLE = new Set(["image/heic", "image/heif"]);

/** JPEG に変換できる（変換が要る）画像か。 */
export function canConvertToJpeg(mimeType: string): boolean {
  return CONVERTIBLE.has(mimeType);
}

export type JpegConverter = (image: Buffer, mimeType: string) => Promise<Buffer>;

export function createJpegConverter(opts: { maxBytes?: number; quality?: number } = {}): JpegConverter {
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const quality = opts.quality ?? 0.9;
  return async (image, mimeType) => {
    if (!canConvertToJpeg(mimeType)) throw new ImageConvertError(`unsupported image type: ${mimeType}`);
    let out: Buffer;
    try {
      out = Buffer.from(await heicConvert({ buffer: image, format: "JPEG", quality }));
    } catch (e) {
      throw new ImageConvertError(`could not decode the HEIC image: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (out.length > maxBytes) throw new ImageConvertError(`converted image is too large (over ${maxBytes} B)`);
    if (!looksLikeJpeg(out)) throw new ImageConvertError("the converter produced no JPEG");
    return out;
  };
}

/** 頭が JPEG の SOI と次のマーカーか。 */
export function looksLikeJpeg(b: Buffer): boolean {
  return b.length >= 128 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
