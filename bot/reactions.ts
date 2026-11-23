/**
 * Discord で友達の投稿に付け外ししたリアクションを setlog に同期する（設計書7.5）。**友達に見える書き込み。**
 *
 * - 対象は Bot が投稿した友達のメッセージだけ（状態ストアの posted）。自分の発言・Bot の通知などは黙って無視する
 * - setlog の会話はその投稿を記録した行のもの（グループの chat 側とは限らない。クリップは collection 側）
 * - 失敗したら #bot-status に知らせる。自動で送り直さない（応答が失われただけなら二重に付くため）
 * - 付けてすぐ外したときも順番どおりに届く（SetlogClient が直列に送る）
 */
import { SetlogAuthError, SetlogHttpError } from "../lib/setlog/client";
import { log } from "./log";
import type { Notifier } from "./status";

export type ReactionAction = "add" | "remove";

export type ReactionSyncDeps = {
  /** Bot が投稿した友達のメッセージを Discord のメッセージ ID で引く。 */
  lookup: (discordMessageId: string) => { messageId: string; conversationId: string } | undefined;
  addReaction: (p: { conversationId: string; messageId: string; text: string }) => Promise<void>;
  removeReaction: (p: { conversationId: string; messageId: string; text: string }) => Promise<void>;
  notify: Notifier;
  /** 受信を止めている（トークン失効など）なら true。 */
  isHalted: () => boolean;
};

export type ReactionSync = (discordMessageId: string, emoji: string, action: ReactionAction) => Promise<void>;

export function createReactionSync(deps: ReactionSyncDeps): ReactionSync {
  return async (discordMessageId, emoji, action) => {
    const target = deps.lookup(discordMessageId);
    if (!target) return;
    const verb = action === "add" ? "add" : "remove";
    if (deps.isHalted()) {
      void deps.notify(`Could not ${verb} the reaction ${emoji} on setlog: receiving is stopped (see above).`);
      return;
    }
    const p = { conversationId: target.conversationId, messageId: target.messageId, text: emoji };
    try {
      if (action === "add") await deps.addReaction(p);
      else await deps.removeReaction(p);
      log.info(`setlog のリアクションを${action === "add" ? "付けた" : "外した"}（msg=${target.messageId.slice(0, 8)}）`);
    } catch (e) {
      const reason =
        e instanceof SetlogAuthError ? "setlog token has expired" : e instanceof SetlogHttpError ? `HTTP ${e.status}` : "setlog unreachable";
      log.warn(`setlog のリアクションの同期に失敗（${action}）: ${e instanceof Error ? e.message : String(e)}`);
      void deps.notify(`Could not ${verb} the reaction ${emoji} on setlog (${reason}).`);
    }
  };
}
