import { describe, expect, it } from "vitest";
import { canConvertToJpeg, createJpegConverter, ImageConvertError, looksLikeJpeg } from "./image";

/** macOS の sips で作った 32×48 の HEIC（552 B）。 */
const HEIC = Buffer.from(
  "AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOZpcHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAIAAAADAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAUIEHAgxOIe5FlU3AgIGAIogABAAlEAcBhcshAUyQAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAboAAABuAAAAAW1kYXQAAAAAAAAAfgAAAGooAa+jwIBGfRwPOv76b+9Rrb6DOB9Y3WJ+QAR/XiD/fuZPiCllonTXsbkeylRTiw9eMTlutfpqP8X5Yp/+fMf/wBOzplkz/UT2feKGbtrIM5sHweOESqBAf401t+GswKGBhkD2mA7Iuen4",
  "base64",
);

/** JPEG の SOF から幅と高さを読む。 */
function jpegSize(b: Buffer): { width: number; height: number } | undefined {
  for (let i = 2; i + 9 < b.length; ) {
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return undefined;
}

describe("HEIC → JPEG の変換", () => {
  it("HEIC を同じ大きさの JPEG にする", async () => {
    const out = await createJpegConverter()(HEIC, "image/heic");
    expect(looksLikeJpeg(out)).toBe(true);
    expect(jpegSize(out)).toEqual({ width: 32, height: 48 });
  });

  it("壊れた入力は ImageConvertError", async () => {
    const broken = Buffer.concat([HEIC.subarray(0, 40), Buffer.alloc(200)]);
    await expect(createJpegConverter()(broken, "image/heic")).rejects.toBeInstanceOf(ImageConvertError);
  });

  it("出力が上限を超えたら ImageConvertError", async () => {
    await expect(createJpegConverter({ maxBytes: 10 })(HEIC, "image/heic")).rejects.toThrow(/too large/);
  });

  it("変換するのは HEIC・HEIF だけ", async () => {
    expect(["image/heic", "image/heif", "image/jpeg", "image/png"].map(canConvertToJpeg)).toEqual([true, true, false, false]);
    await expect(createJpegConverter()(HEIC, "image/jpeg")).rejects.toBeInstanceOf(ImageConvertError);
  });
});
