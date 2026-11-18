/**
 * #bot-status への通知（設計書9章）。
 * 通知の失敗で Bot 本体を止めないよう、送信エラーはログに残して握りつぶす。
 * 呼び出し側は、トークン・パスフレーズ・メッセージ本文を渡さないこと。
 */
import type { Client } from "discord.js";
import { log } from "./log";

export type Notifier = (text: string) => Promise<void>;

export function createNotifier(client: Client, channelId: string): Notifier {
  return async (text) => {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isSendable()) {
        log.warn("status チャンネルに送信できない");
        return;
      }
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (e) {
      log.warn(`status 通知に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
