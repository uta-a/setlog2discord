/**
 * Discord の添付（自分が chat チャンネルに送った画像・動画）を取得する（設計書7.4）。
 *
 * - URL は Discord から来た値だが、念のため Discord の CDN（https）であることを確かめる。リダイレクトはたどらない
 * - 上限を超える本体は途中で打ち切る（宣言された content-length と実際の長さの両方で見る）
 * - 失敗の理由は SendError にする（Discord の返信にそのまま出る。URL は入れない。署名付きのため）
 */
import { SendError } from "./sender";

/** 添付を配る Discord の CDN。 */
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function isDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export async function downloadAttachment(
  url: string,
  opts: { maxBytes: number; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<Buffer> {
  if (!isDiscordCdnUrl(url)) throw new SendError("the attachment is not on Discord's CDN");
  const failed = () => new SendError("could not download the attachment from Discord");
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  } catch {
    throw failed();
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw failed();
  }
  const tooLarge = () => new SendError(`file too large (max ${opts.maxBytes / 1024 / 1024} MB)`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > opts.maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) throw tooLarge();
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader?.cancel().catch(() => {});
    if (e instanceof SendError) throw e;
    throw failed();
  }
  if (declared > 0 && total !== declared) throw failed();
  return Buffer.concat(chunks);
}
