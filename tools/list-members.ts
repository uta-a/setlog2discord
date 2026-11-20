/**
 * 設定したグループのメンバーの名前と setlog のユーザー ID を表示する。
 * bot.config.json の ignoredSenderIds（投稿を Discord に流さない人）を書くときに使う。
 *
 * 使い方（リポジトリルートで。.env.local（サーバーでは .env）と bot.config.json があること）:
 *   pnpm list-members
 *
 * 表示するのは名前とユーザー ID だけ（トークンは出さない）。
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../bot/config";
import { SetlogClient } from "../lib/setlog/client";

const config = loadConfig(process.env, readFileSync(process.env.BOT_CONFIG ?? "bot.config.json", "utf-8"));
const setlog = new SetlogClient({ apiKey: config.setlog.apiKey, token: config.setlog.token });
const ignored = new Set(config.ignoredSenderIds);
const configured = new Set(config.groups.flatMap((g) => [g.conversationId, g.chatConversationId]));

const collections = await setlog.getCollections();
const targets = collections.filter((c) => configured.has(c.id));
if (targets.length === 0) console.log("設定したグループが見つからない（参加しているグループを全部出す）");
for (const c of targets.length > 0 ? targets : collections) {
  console.log(`\n${c.name}（${c.id}）`);
  for (const p of c.participants) {
    const mark = p.userId === config.setlog.userId ? "  ← Bot 自身" : ignored.has(p.userId) ? "  ← 除外中" : "";
    console.log(`  ${p.userId}  ${[p.name, p.lastName].filter(Boolean).join(" ")}${mark}`);
  }
}
