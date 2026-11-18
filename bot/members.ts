/**
 * メンバー名の解決（設計書6章）。WebSocket のメッセージには senderName が無いので、
 * GET collections の参加者から userId → 名前を引く。
 *
 * 知らない userId が来たら取り直す。ただし minRefreshMs（既定 5 分）に 1 回まで（取得の頻度を抑えるため）。
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
  let lastRefresh: number | null = null;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= (async () => {
      lastRefresh = now();
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
      if (!names.has(userId) && (lastRefresh === null || now() - lastRefresh >= minRefreshMs)) await refresh();
      return names.get(userId);
    },
  };
}
