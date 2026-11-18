/**
 * Bot のスラッシュコマンド（bot/commands.ts）を、設定した guild にだけ登録し直す。
 * Bot の起動時には登録しないので、コマンドの中身を変えたときだけこれを実行する。
 *
 * 使い方（リポジトリルートで。.env.local と bot.config.json があること）:
 *   pnpm exec tsx --env-file=.env.local tools/register-commands.ts
 */
import { readFileSync } from "node:fs";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { COMMANDS } from "../bot/commands";
import { loadConfig } from "../bot/config";

const config = loadConfig(process.env, readFileSync(process.env.BOT_CONFIG ?? "bot.config.json", "utf-8"));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  try {
    const guild = await c.guilds.fetch(config.guildId);
    const set = await guild.commands.set(COMMANDS);
    console.log(`登録した: ${[...set.values()].map((x) => `/${x.name}`).join(", ")}`);
  } catch (e) {
    console.error(`登録に失敗: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    await c.destroy();
  }
});

await client.login(config.discordToken);
