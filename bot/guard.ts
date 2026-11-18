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
    if (!info) problems.push(`${purpose}（${id}）が見つからない、または Bot から見えない`);
    else if (info.guildId !== guildId) problems.push(`${purpose}（${id}）が設定した guild のチャンネルではない`);
    else if (!info.isText) problems.push(`${purpose}（${id}）がテキストチャンネルではない`);
    else if (!info.canSend) problems.push(`${purpose}（${id}）に Bot が送信できない（権限を確認）`);
  }
  return problems;
}
