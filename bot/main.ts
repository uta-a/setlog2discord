/**
 * Bot のエントリポイント。
 *
 * 起動時に設定を読み、Discord に接続し、次を確かめてから #bot-status に起動を通知する。
 * - 設定した guild 以外に入っていたら退出する（以後も guildCreate で即退出）
 * - 設定したチャンネルが実在し、送信できる
 * 確認が通ったら setlog の受信（B1）を始める。
 *
 * 使い方: pnpm start
 *   環境変数 DISCORD_TOKEN・SETLOG_TOKEN・SETLOG_USER_ID・SETLOG_X_API_KEY、設定ファイル bot.config.json、
 *   鍵バックアップ .secrets.keybackup.json とパスフレーズ .secrets.passphrase（BOT_KEY_BACKUPS・BOT_PASSPHRASE_FILE で変更可）。
 *   設定ファイルの場所は BOT_CONFIG、状態ストアの場所は BOT_STATE（既定 data/state.sqlite）で変えられる。
 */
import { readFileSync } from "node:fs";
import { ChannelType, Client, DiscordAPIError, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { AttachmentTooLargeError, type PostClip } from "./clips";
import { ConfigError, configuredChannels, loadConfig, type BotConfig } from "./config";
import { channelProblems, guildsToLeave, type ChannelInfo } from "./guard";
import { loadKeyring } from "./keys";
import { log } from "./log";
import { startReceiver, type Receiver } from "./receiver";
import { createNotifier } from "./status";

function readConfig(): BotConfig {
  const path = process.env.BOT_CONFIG ?? "bot.config.json";
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    throw new ConfigError(`設定ファイルが読めない: ${path}（bot.config.example.json をコピーして作る）`);
  }
  return loadConfig(process.env, text);
}

async function channelInfo(client: Client, id: string): Promise<ChannelInfo | null> {
  try {
    const ch = await client.channels.fetch(id);
    if (!ch) return null;
    const guildId = "guildId" in ch ? ch.guildId : null;
    const isText = ch.type === ChannelType.GuildText;
    let canSend = false;
    if (isText && client.user) {
      const perms = ch.permissionsFor(client.user);
      canSend = !!perms?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
      ]);
    }
    return { guildId, isText, canSend };
  } catch {
    return null;
  }
}

/** Discord の「添付が大きすぎる」（HTTP 413・JSON コード 40005）。 */
function isTooLarge(e: unknown): boolean {
  return e instanceof DiscordAPIError && (e.status === 413 || e.code === 40005);
}

function clipPoster(client: Client): PostClip {
  return async (channelId, content, file) => {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isSendable()) throw new Error("clips チャンネルに送信できない");
    try {
      const msg = await ch.send({
        content,
        files: [{ attachment: file.data, name: file.name }],
        allowedMentions: { parse: [] },
      });
      return msg.id;
    } catch (e) {
      if (isTooLarge(e)) throw new AttachmentTooLargeError();
      throw e;
    }
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = readConfig();
  const keyring = loadKeyring(process.env);
  log.info(`鍵を復元（${keyring.size} 件）`);
  let receiver: Receiver | null = null;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const notify = createNotifier(client, config.statusChannelId);

  client.on(Events.GuildCreate, async (guild) => {
    if (guild.id === config.guildId) return;
    log.warn(`設定外の guild に追加されたので退出する: ${guild.id}`);
    await guild.leave().catch((e) => log.error(`退出に失敗: ${String(e)}`));
  });

  client.once(Events.ClientReady, async (c) => {
    log.info(`Discord に接続: ${c.user.tag}`);

    for (const id of guildsToLeave([...c.guilds.cache.keys()], config.guildId)) {
      log.warn(`設定外の guild から退出する: ${id}`);
      await c.guilds.cache.get(id)?.leave().catch((e) => log.error(`退出に失敗: ${String(e)}`));
    }
    if (!c.guilds.cache.has(config.guildId)) {
      log.error("設定した guild に Bot が参加していない。招待してから再起動する");
      await shutdown(1);
      return;
    }

    const channels = await Promise.all(
      configuredChannels(config).map(async (ch) => ({ ...ch, info: await channelInfo(c, ch.id) })),
    );
    const problems = channelProblems(channels, config.guildId);
    if (problems.length > 0) {
      for (const p of problems) log.error(p);
      await notify(`設定の確認で問題が見つかった:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      await shutdown(1);
      return;
    }

    log.info(`準備完了（グループ ${config.groups.length} 件）`);
    await notify(`起動しました（グループ ${config.groups.length} 件）`);
    receiver = startReceiver(config, notify, {
      statePath: process.env.BOT_STATE ?? "data/state.sqlite",
      startedAt,
      keyring,
      postClip: clipPoster(c),
    });
  });

  let stopping = false;
  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    await receiver?.stop().catch((e) => log.error(`受信の停止に失敗: ${String(e)}`));
    if (client.isReady() && code === 0) await notify("停止します");
    await client.destroy();
    process.exit(code);
  }
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  await client.login(config.discordToken);
}

main().catch((e) => {
  // ConfigError・KeyringError は値を含まない。それ以外もメッセージだけを出す
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
