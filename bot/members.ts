/**
 * メンバー名の解決（設計書6章）。WebSocket のメッセージには senderName が無いので、
 * GET collections の参加者から userId → 名前を引く。
 *
 * 知らない userId が来たら取り直す。取り直しても見つからなかった人は、minRefreshMs（既定 5 分）あけるまで取り直さない。
 * 取得に失敗しても投げない（名前が分からないだけでクリップを落とさない）。
 */
import { log } from "./log";

export type MemberDirectory = { name(userId: string): Promise<string | undefined> };

export function createMemberDirectory(
  fetchParticipants: () => Promise<{ userId: string; name: string }[]>,
  opts: { minRefreshMs?: number; now?: () => number } = {},
): MemberDirectory {
  const minRefreshMs = opts.minRefreshMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const names = new Map<string, string>();
  /** 取り直しても見つからなかった userId と、その時刻（同じ人で何度も取り直さない）。 */
  const missing = new Map<string, number>();
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= (async () => {
      try {
        for (const p of await fetchParticipants()) names.set(p.userId, p.name);
      } catch (e) {
        log.warn(`メンバー名の取得に失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    async name(userId) {
      if (!names.has(userId)) {
        // 初めて見る userId（新しく入った友達など）は間隔に関係なく 1 回取り直す。
        // 見つからなかった人は minRefreshMs あけてから
        const lastMiss = missing.get(userId);
        if (lastMiss === undefined || now() - lastMiss >= minRefreshMs) {
          await refresh();
          if (!names.has(userId)) missing.set(userId, now());
        }
      }
      return names.get(userId);
    },
  };
}
