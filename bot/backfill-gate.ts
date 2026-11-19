/**
 * REST 補完の間引き（設計書4章）。WebSocket は 5 分ごとにつなぎ直すが、補完は 10 分ごとでよい。
 *
 * - 定期のつなぎ直しでは、前の補完から intervalMs たつまで補完しない
 * - 起動・切断からの再接続・/reconnect では毎回補完する（取りこぼした可能性が高いため）
 *
 * つなぎ直しの時刻は接続にかかる時間で揺れるので、30 秒の余裕をみる（10 分の回を飛ばして 15 分空かないように）。
 */
export type BackfillGate = {
  shouldBackfill(open: { scheduled: boolean }): boolean;
  /** 補完を始めたときに呼ぶ（失敗の再試行の補完も含む）。 */
  markBackfilled(): void;
};

const SLACK_MS = 30_000;

export function createBackfillGate(opts: { intervalMs: number; now?: () => number }): BackfillGate {
  const now = opts.now ?? Date.now;
  let last: number | null = null;
  return {
    shouldBackfill(open) {
      if (!open.scheduled || last === null) return true;
      return now() - last >= opts.intervalMs - SLACK_MS;
    },
    markBackfilled() {
      last = now();
    },
  };
}
