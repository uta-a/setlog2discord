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
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  ContainerBuilder,
  EmbedBuilder,
  escapeMarkdown,
  MessageFlags,
  MessageReferenceType,
  type MessageCreateOptions,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  Partials,
  PermissionFlagsBits,
  type User,
  type Webhook,
} from "discord.js";
import { RECONNECT_COMMAND } from "./commands";
import { AttachmentTooLargeError, type PostEmbed } from "./posting";
import { ConfigError, configuredChannels, loadConfig, type BotConfig } from "./config";
import { canUseCommand, channelProblems, guildsToLeave, reactionEmoji, sendTarget, type ChannelInfo } from "./guard";
import { downloadAttachment } from "./attachments";
import { MAX_MEDIA_BYTES, SendError, type OutgoingPart } from "./sender";
import { loadKeyring } from "./keys";
import { log } from "./log";
import type { ReactionAction } from "./reactions";
import { startReceiver, type Receiver } from "./receiver";
import { createNotifier } from "./status";
import { createWebhookDirectory, discordChannelHooks, replyLine, webhookUsername, type WebhookDirectory } from "./webhooks";

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
        PermissionFlagsBits.EmbedLinks,
        // 送れなかったときに元の発言へ返信するため
        PermissionFlagsBits.ReadMessageHistory,
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

/** 投稿の左の色。tintColor が無い人の既定色。 */
const DEFAULT_COLOR = 0x8a8f98;

/** Discord の「Webhook が無い」（JSON コード 10015）。 */
function isUnknownWebhook(e: unknown): boolean {
  return e instanceof DiscordAPIError && e.code === 10015;
}

/**
 * クリップ（カードの中に名前と動画）とテキスト（embed）を投稿する。
 * 通知に友達の名前が出るよう、Webhook が使えれば username を友達の名前にして Webhook で投稿する（webhooks.ts）。
 * 使えなければ Bot として投稿する。
 */
function embedPoster(client: Client, hooks: WebhookDirectory<Webhook>): PostEmbed {
  return async (channelId, post, nonce) => {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isSendable()) throw new Error("投稿先のチャンネルに送信できない");
    const common = { allowedMentions: { parse: [], repliedUser: false } } as const;
    let payload: Omit<MessageCreateOptions, "nonce" | "reply" | "stickers" | "forward" | "sharedClientTheme">;
    let replyTo: string | undefined;
    if (post.layout === "clip") {
      // 名前は友達が自由に付けられるので、書式・リンクとして解釈させない
      const name = escapeMarkdown(post.authorName, { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
      const card = new ContainerBuilder().setAccentColor(post.color ?? DEFAULT_COLOR);
      // アイコンはカードの中に出さない（Webhook の投稿者のアイコンになるので。2026-11-19 に決めた）
      card.addTextDisplayComponents((t) => t.setContent(`**${name}**`));
      if (post.caption) {
        // 動画のタイトル（setlog のキャプション）は名前の下、動画の上に見出しで出す。友達が自由に書けるので書式として解釈させない
        const title = post.caption
          .split("\n")
          .map((line) => `### ${escapeMarkdown(line, { heading: true, maskedLink: true, bulletedList: true, numberedList: true })}`)
          .join("\n");
        card.addTextDisplayComponents((t) => t.setContent(title));
      }
      if (post.asFile) {
        // 音声は動画・画像の枠（MediaGallery）に入らないので、ファイルの部品で出す。
        // その場で再生できるのは mp3 など（m4a はファイルのリンクになる）なので、clips.ts で mp3 に変換してある
        card.addFileComponents((f) => f.setURL(`attachment://${post.video.name}`));
      } else {
        card.addMediaGalleryComponents((g) => g.addItems((i) => i.setURL(`attachment://${post.video.name}`)));
      }
      const files = [{ attachment: post.video.data, name: post.video.name }];
      payload = {
        ...common,
        components: [card],
        files,
        flags: MessageFlags.IsComponentsV2,
      };
    } else {
      const embed = new EmbedBuilder()
        .setAuthor({ name: post.authorName })
        .setDescription(post.description)
        .setColor(post.color ?? DEFAULT_COLOR)
        .setFooter({ text: post.groupName });
      if (post.timestamp !== undefined) embed.setTimestamp(post.timestamp);
      // アイコンは embed に出さない（Webhook の投稿者のアイコンになるので）
      const files = post.video ? [{ attachment: post.video.data, name: post.video.name }] : [];
      payload = { ...common, embeds: [embed], files };
      replyTo = post.replyTo;
    }
    try {
      const hook = await hooks.get(channelId, { userId: post.authorId, avatar: post.avatar?.data });
      if (hook) {
        let body = payload;
        if (replyTo && "guildId" in ch && ch.guildId) {
          // Webhook は Discord の返信を作れないので、返信先へのリンクを本文の上に足す
          const [embed] = payload.embeds as EmbedBuilder[];
          const line = replyLine(ch.guildId, channelId, replyTo);
          body = { ...payload, embeds: [EmbedBuilder.from(embed).setDescription(`${line}\n${embed.data.description ?? ""}`)] };
        }
        try {
          // Webhook には nonce が無いので、応答が失われて送り直すと二重に投稿されうる（頻度は低いので許容する）
          return (await hook.send({ ...body, username: webhookUsername(post.authorName), withComponents: post.layout === "clip" })).id;
        } catch (e) {
          if (!isUnknownWebhook(e)) throw e;
          // Webhook が消されていた。次は探し直し、今回は Bot として投稿する
          hooks.forget(channelId);
        }
      }
      // 応答が失われて送り直したときに、Discord 側で同じメッセージの二重投稿を弾く
      return (
        await ch.send({
          ...payload,
          nonce,
          enforceNonce: true,
          reply: replyTo ? { messageReference: replyTo, failIfNotExists: false } : undefined,
        })
      ).id;
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
  // 発言の本文を読むので MessageContent が要る（Developer Portal で有効にしておく。設計書6章）。
  // リアクションの同期（設計書7.5）には GuildMessageReactions が要る。再起動前の投稿はキャッシュに無いので、
  // Partials を有効にして、キャッシュに無いメッセージへのリアクションも受け取る（使うのは ID と絵文字だけ）
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });
  const notify = createNotifier(client, config.statusChannelId);

  // Discord → setlog（B4）。送るのは chat チャンネルでの自分の発言だけ。失敗したときだけ返信で知らせる
  client.on(Events.MessageCreate, async (msg) => {
    const group = sendTarget(
      {
        guildId: msg.guildId,
        channelId: msg.channelId,
        authorId: msg.author.id,
        isBot: msg.author.bot,
        isWebhook: msg.webhookId !== null,
        isSystem: msg.system,
      },
      config,
    );
    if (!group) return;
    const fail = (reason: string) =>
      msg
        .reply({ content: `Not sent: ${reason}`, allowedMentions: { parse: [], repliedUser: false } })
        .catch((e) => log.warn(`失敗の返信に失敗: ${e instanceof Error ? e.message : String(e)}`));
    if (msg.stickers.size > 0) {
      await fail("stickers cannot be sent (text, images and videos can)");
      return;
    }
    if (!receiver) {
      await fail("the bot is still starting up");
      return;
    }
    // Discord の返信は setlog の返信にする（転送は返信ではないので、参照を持っていても使わない）
    const replyTo =
      msg.reference?.type === MessageReferenceType.Default ? (msg.reference.messageId ?? undefined) : undefined;
    // メンションは <@id> ではなく表示名にして送る。添付だけの発言ならテキストは送らない
    const text = msg.cleanContent.trim();
    const parts: OutgoingPart[] = [
      ...(text || msg.attachments.size === 0 ? [{ kind: "text" as const, text: msg.cleanContent }] : []),
      ...msg.attachments.map(
        (a): OutgoingPart => ({
          kind: "media",
          name: a.name,
          // Discord は「image/jpeg; charset=...」のように付けることがあるので、MIME の部分だけを見る
          mimeType: a.contentType?.split(";")[0].trim() ?? null,
          size: a.size,
          width: a.width,
          height: a.height,
          load: () => downloadAttachment(a.url, { maxBytes: MAX_MEDIA_BYTES }),
        }),
      ),
    ];
    try {
      await receiver.send(group.chatConversationId, parts, msg.id, replyTo);
    } catch (e) {
      if (e instanceof SendError) await fail(e.message);
      else {
        log.error(`送信で想定外のエラー: ${e instanceof Error ? e.message : String(e)}`);
        await fail("unexpected error");
      }
    }
  });

  // Discord → setlog のリアクション（設計書7.5）。友達の投稿への自分のリアクションだけを同期する
  const onReaction = (action: ReactionAction) => async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    const emoji = reactionEmoji(
      {
        guildId: reaction.message.guildId,
        channelId: reaction.message.channelId,
        userId: user.id,
        emojiId: reaction.emoji.id,
        emojiName: reaction.emoji.name,
      },
      config,
    );
    if (!emoji || !receiver) return;
    try {
      await receiver.react(reaction.message.id, emoji, action);
    } catch (e) {
      log.error(`リアクションの同期で想定外のエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  client.on(Events.MessageReactionAdd, onReaction("add"));
  client.on(Events.MessageReactionRemove, onReaction("remove"));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== RECONNECT_COMMAND.name) return;
    try {
      if (!canUseCommand({ guildId: interaction.guildId, userId: interaction.user.id }, config)) {
        await interaction.reply({ content: "You cannot use this command.", flags: MessageFlags.Ephemeral });
        return;
      }
      const r = receiver?.reconnect() ?? "not-connected";
      const text = {
        reconnecting: "Reconnected to setlog. Fetching any missed messages.",
        "not-connected": "Not connected to setlog (retrying automatically).",
        halted: "Receiving is stopped (see #bot-status).",
      }[r];
      log.info(`/reconnect: ${r}`);
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    } catch (e) {
      log.warn(`/reconnect の応答に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

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
      await notify(`Configuration problems found:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      await shutdown(1);
      return;
    }

    log.info(`準備完了（グループ ${config.groups.length} 件）`);
    await notify(`Started (${config.groups.length} group(s))`);
    receiver = startReceiver(config, notify, {
      statePath: process.env.BOT_STATE ?? "data/state.sqlite",
      startedAt,
      keyring,
      post: embedPoster(
        c,
        createWebhookDirectory((channelId) => discordChannelHooks(c, channelId), (channelId) =>
          void notify(`Cannot use a webhook in <#${channelId}> (grant the bot Manage Webhooks). Posting as the bot, so notifications will not show the sender's name.`),
        ),
      ),
    });
  });

  let stopping = false;
  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    await receiver?.stop().catch((e) => log.error(`受信の停止に失敗: ${String(e)}`));
    if (client.isReady() && code === 0) await notify("Stopping");
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
