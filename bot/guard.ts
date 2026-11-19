/**
 * 起動時の安全確認（設計書2章・6章・10章）。
 *
 * - 設定した guild 以外に入っていたら退出する
 * - 設定したチャンネルが、その guild のテキストチャンネルとして実在し、Bot が送信できるか確かめる
 *
 * 判定は純粋関数に分け、discord.js への依存は main.ts 側に置く。
 */

export type ChannelInfo = {
  guildId: string | null;
  isText: boolean;
  canSend: boolean;
};

/** 退出すべき guild の ID を返す。 */
export function guildsToLeave(joinedGuildIds: string[], allowedGuildId: string): string[] {
  return joinedGuildIds.filter((id) => id !== allowedGuildId);
}

/**
 * チャンネルの問題点を一覧にする。空なら問題なし。
 * info が null のチャンネルは、存在しないか Bot から見えない。
 */
export function channelProblems(
  channels: { id: string; purpose: string; info: ChannelInfo | null }[],
  guildId: string,
): string[] {
  const problems: string[] = [];
  for (const { id, purpose, info } of channels) {
    if (!info) problems.push(`${purpose} (${id}) not found or not visible to the bot`);
    else if (info.guildId !== guildId) problems.push(`${purpose} (${id}) is not in the configured guild`);
    else if (!info.isText) problems.push(`${purpose} (${id}) is not a text channel`);
    else if (!info.canSend) problems.push(`${purpose} (${id}): the bot cannot send messages (check permissions)`);
  }
  return problems;
}

/** スラッシュコマンドを使えるか。設定した guild の中の、設定した自分のユーザーだけ（DM・他人・他の guild は不可）。 */
export function canUseCommand(
  who: { guildId: string | null; userId: string },
  config: { guildId: string; ownerUserId: string },
): boolean {
  return who.guildId === config.guildId && who.userId === config.ownerUserId;
}

/**
 * Discord の発言を setlog に送るなら、その送り先のグループを返す（設計書7.3。友達に見える書き込みなので厳しく絞る）。
 * 送るのは、設定した guild の chat チャンネルでの、設定した自分のユーザーの発言だけ。
 * Bot（自分自身の投稿を含む）・Webhook・システムメッセージ・DM は送らない。
 */
export function sendTarget<G extends { chatChannelId: string }>(
  m: { guildId: string | null; channelId: string; authorId: string; isBot: boolean; isWebhook: boolean; isSystem: boolean },
  config: { guildId: string; ownerUserId: string; groups: G[] },
): G | undefined {
  if (m.guildId !== config.guildId || m.authorId !== config.ownerUserId) return undefined;
  if (m.isBot || m.isWebhook || m.isSystem) return undefined;
  return config.groups.find((g) => g.chatChannelId === m.channelId);
}
