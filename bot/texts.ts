/**
 * テキストの転送（設計書7.2）。取り込み（ingest）から text を受け取り、復号して chat チャンネルに embed で投稿する。
 *
 * - embed：author に名前とアイコン、本文にテキスト（Markdown はエスケープして書いたとおりに見せる）、
 *   左の色はその人の tintColor、フッターにグループ名、タイムスタンプに送信時刻
 * - 返信（parentId あり）は、元のメッセージを投稿済みなら Discord の返信にする。無ければ普通の投稿
 * - 失敗の扱いはクリップと同じ（posting.ts）。復号できない・形が違うものは failed、投稿の失敗は記録しない
 * - 削除済み（REST の isDeleted）は skipped
 *
 * 本文はログにも通知にも出さない。
 */
import { escapeMarkdown } from "discord.js";
import { TextDecryptError, TextPayloadSchema, decryptTextMessage } from "../lib/setlog/text";
import type { Keyring } from "../lib/setlog/media";
import { short, type HandlerResult, type IncomingMessage } from "./ingest";
import { log } from "./log";
import { createOutcomes, makeNonce, resolveAuthor, type AuthorDeps, type PostEmbed } from "./posting";
import type { Notifier } from "./status";

export type TextDeps = AuthorDeps & {
  keyring: Keyring;
  myUserId: string;
  post: PostEmbed;
  /** 投稿済みの setlog のメッセージに対応する Discord のメッセージ ID。 */
  discordMessageIdOf: (setlogMessageId: string) => string | undefined;
  notify: Notifier;
  nameTimeoutMs?: number;
};

export type TextHandler = ((m: IncomingMessage) => Promise<HandlerResult>) & { hasPending(): boolean };

/** embed の本文の上限は 4096 文字。エスケープで増える分を見て、元の文を切る。 */
const TEXT_MAX = 3800;
const EMPTY_TEXT = "（空のメッセージ）";

export const textNonce = (messageId: string) => makeNonce("text", messageId);

/** 友達のテキストを embed の本文にする。書いたとおりに見えるよう Markdown を無効にする（URL は自動でリンクになる）。 */
export function textBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return EMPTY_TEXT;
  const chars = [...trimmed];
  const cut = chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX).join("")}…` : trimmed;
  const escaped = escapeMarkdown(cut, { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
  return [...escaped].slice(0, 4096).join("");
}

export function createTextHandler(deps: TextDeps): TextHandler {
  const nameTimeoutMs = deps.nameTimeoutMs ?? 5000;
  const out = createOutcomes(deps.notify);

  const handler = async (m: IncomingMessage): Promise<HandlerResult> => {
    const id = m.message.messageId;
    const where = `${m.group.name} msg=${short(id)}`;
    if ((m.message as { isDeleted?: unknown }).isDeleted === true) {
      log.info(`削除済みのテキストを飛ばす（${where}）`);
      return out.done(id, { result: "skipped" });
    }
    const parsed = TextPayloadSchema.safeParse(m.message);
    if (!parsed.success) {
      const keys = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      return out.failed(id, `Text has an unexpected shape (${where}): ${keys}`, `text-shape:${keys}`);
    }
    const msg = parsed.data;

    let text: string;
    try {
      text = decryptTextMessage(msg, deps.keyring, deps.myUserId);
    } catch (e) {
      if (e instanceof TextDecryptError) return out.failed(id, `Text could not be decrypted (${where}): ${e.message}`);
      throw e;
    }

    const author = await resolveAuthor(deps, msg.senderId, msg.senderName, nameTimeoutMs);
    const replyTo = msg.parentId ? deps.discordMessageIdOf(msg.parentId) : undefined;
    try {
      const discordMessageId = await deps.post(
        m.group.chatChannelId,
        {
          authorName: author.name,
          description: textBody(text),
          groupName: m.group.name,
          color: author.color,
          timestamp: msg.timestamp,
          avatar: author.avatar,
          replyTo,
        },
        textNonce(id),
      );
      log.info(`テキストを転送（${where}${replyTo ? "、返信" : ""}）`);
      return out.done(id, { result: "posted", discordMessageId });
    } catch (e) {
      return out.transient(id, `Text could not be forwarded (${where}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return Object.assign(handler, { hasPending: out.hasPending });
}
