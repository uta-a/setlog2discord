/**
 * 友達の名前で投稿するための Webhook（2026-11-19 に追加）。
 *
 * Discord の通知には投稿者の名前が出る。Bot のまま投稿すると「setlog」としか出ず誰の投稿か分からないので、
 * 投稿先のチャンネルごとに Bot が作った Webhook を 1 つ持ち、username を友達の名前にして投稿する。
 *
 * - Webhook は Bot（アプリ）が作ったもの（applicationId が Bot）だけを使う。無ければ作る（Manage Webhooks の権限が要る）
 * - 権限が無いなど Webhook を使えないチャンネルでは、これまでどおり Bot として投稿する（呼び出し側）
 * - Webhook は Discord の返信を作れないので、返信は返信先へのリンクの 1 行で示す（replyLine）
 * - Webhook の URL（トークン）はログに出さない
 */
import { ChannelType, type Client, type Webhook } from "discord.js";
import { FALLBACK_NAME } from "./posting";
import { log } from "./log";

const HOOK_NAME = "setlog";
const USERNAME_MAX = 80;

/** Webhook の username にする。Discord が使わせない語（discord・clyde）は間にゼロ幅の文字を入れて崩す。 */
export function webhookUsername(name: string): string {
  const base = name.trim() || FALLBACK_NAME;
  const safe = base.replace(/discord/gi, (w) => `${w[0]}​${w.slice(1)}`).replace(/clyde/gi, (w) => `${w[0]}​${w.slice(1)}`);
  return [...safe].slice(0, USERNAME_MAX).join("");
}

/** 返信先のメッセージへのリンクの 1 行（小さい字）。 */
export function replyLine(guildId: string, channelId: string, messageId: string): string {
  return `-# 返信: https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export type WebhookDirectory = {
  get(channelId: string): Promise<Webhook | null>;
  /** Webhook が消されていたときに呼ぶ（次は探し直す）。 */
  forget(channelId: string): void;
};

/** チャンネルごとの Webhook を探すか作り、覚えておく。使えなければ null（理由は 1 回だけ onUnavailable に渡す）。 */
export function createWebhookDirectory(client: Client, onUnavailable: (channelId: string, reason: string) => void): WebhookDirectory {
  const cache = new Map<string, Promise<Webhook | null>>();
  const reported = new Set<string>();

  async function resolve(channelId: string): Promise<Webhook | null> {
    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch || ch.type !== ChannelType.GuildText) throw new Error("not a text channel");
      const hooks = await ch.fetchWebhooks();
      const mine = hooks.find((h) => h.applicationId === client.user?.id && h.token);
      if (mine) return mine;
      const created = await ch.createWebhook({ name: HOOK_NAME, reason: "setlog bot: post as the friend's name" });
      log.info(`Webhook を作成（チャンネル ${channelId}）`);
      return created;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn(`Webhook を使えない（チャンネル ${channelId}）: ${reason}`);
      if (!reported.has(channelId)) {
        reported.add(channelId);
        onUnavailable(channelId, reason);
      }
      // 権限を足したら使えるよう、失敗は覚えない
      cache.delete(channelId);
      return null;
    }
  }

  return {
    get(channelId) {
      let p = cache.get(channelId);
      if (!p) {
        p = resolve(channelId);
        cache.set(channelId, p);
      }
      return p;
    },
    forget(channelId) {
      cache.delete(channelId);
    },
  };
}
