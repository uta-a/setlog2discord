/**
 * Bot の設定（設計書6章）。
 *
 * - 秘密（トークン）は環境変数から読む
 * - ID 類（guild・チャンネル・自分のユーザー ID）と、グループとチャンネルの対応は bot.config.json から読む
 *
 * エラーメッセージには値を出さず、項目名だけを出す（トークンをログに残さないため）。
 */
import { z } from "zod";

const Snowflake = z.string().regex(/^\d{17,20}$/, "Discord の ID（数字 17〜20 桁）ではない");

const GroupSchema = z.object({
  /** 表示用の名前（ログと通知にだけ使う） */
  name: z.string().min(1),
  /** setlog のクリップ側（collection）の conversationId */
  conversationId: z.string().min(1),
  /** setlog のチャット側の conversationId。省略時は conversationId と同じ（設計書6章） */
  chatConversationId: z.string().min(1).optional(),
  clipsChannelId: Snowflake,
  chatChannelId: Snowflake,
});

const FileSchema = z.object({
  guildId: Snowflake,
  /** 自分の Discord ユーザー ID。setlog への送信はこのユーザーの発言だけ（設計書7.3） */
  ownerUserId: Snowflake,
  statusChannelId: Snowflake,
  groups: z.array(GroupSchema).min(1),
});

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  SETLOG_TOKEN: z.string().min(1),
  SETLOG_USER_ID: z.string().min(1),
  SETLOG_X_API_KEY: z.string().min(1),
});

export type GroupConfig = z.infer<typeof GroupSchema> & { chatConversationId: string };

export type BotConfig = Omit<z.infer<typeof FileSchema>, "groups"> & {
  discordToken: string;
  setlog: { token: string; userId: string; apiKey: string };
  groups: GroupConfig[];
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function describe(source: string, error: z.ZodError): string {
  const lines = error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `${source} が不正:\n${lines.join("\n")}`;
}

/** 設定ファイルの中身と環境変数から BotConfig を組む。 */
export function loadConfig(env: Record<string, string | undefined>, fileText: string): BotConfig {
  let json: unknown;
  try {
    json = JSON.parse(fileText);
  } catch {
    throw new ConfigError("bot.config.json が JSON として読めない");
  }
  const file = FileSchema.safeParse(json);
  if (!file.success) throw new ConfigError(describe("bot.config.json", file.error));
  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) throw new ConfigError(describe("環境変数", envParsed.error));

  const groups = file.data.groups.map((g) => ({
    ...g,
    chatConversationId: g.chatConversationId ?? g.conversationId,
  }));

  // 同じグループのクリップとチャットは同じチャンネルにしてよい。status や別グループとの共有は不可
  const channelIds = groups.flatMap((g) => [...new Set([g.clipsChannelId, g.chatChannelId])]);
  const all = [file.data.statusChannelId, ...channelIds];
  const dup = all.find((id, i) => all.indexOf(id) !== i);
  if (dup) throw new ConfigError(`同じチャンネル ID が複数の用途に使われている: ${dup}`);

  const e = envParsed.data;
  return {
    ...file.data,
    groups,
    discordToken: e.DISCORD_TOKEN,
    setlog: { token: e.SETLOG_TOKEN, userId: e.SETLOG_USER_ID, apiKey: e.SETLOG_X_API_KEY },
  };
}

/** 設定に出てくるチャンネル ID と用途の一覧（起動時の存在確認に使う）。 */
export function configuredChannels(config: BotConfig): { id: string; purpose: string }[] {
  return [
    { id: config.statusChannelId, purpose: "bot-status" },
    ...config.groups.flatMap((g) =>
      g.clipsChannelId === g.chatChannelId
        ? [{ id: g.clipsChannelId, purpose: `${g.name} のクリップとチャット` }]
        : [
            { id: g.clipsChannelId, purpose: `${g.name} のクリップ` },
            { id: g.chatChannelId, purpose: `${g.name} のチャット` },
          ],
    ),
  ];
}
