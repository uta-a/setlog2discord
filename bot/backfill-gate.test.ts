import { describe, expect, it } from "vitest";
import { createBackfillGate } from "./backfill-gate";

const MIN = 60_000;

describe("createBackfillGate", () => {
  it("定期のつなぎ直しでは、前の補完から 10 分たつまで補完しない（5 分ごとのつなぎ直しなら 2 回に 1 回）", () => {
    let t = 0;
    const gate = createBackfillGate({ intervalMs: 10 * MIN, now: () => t });
    expect(gate.shouldBackfill({ scheduled: false })).toBe(true); // 起動時
    gate.markBackfilled();
    t = 5 * MIN + 300;
    expect(gate.shouldBackfill({ scheduled: true })).toBe(false);
    t = 10 * MIN + 600;
    expect(gate.shouldBackfill({ scheduled: true })).toBe(true);
    gate.markBackfilled();
    t += 5 * MIN + 300;
    expect(gate.shouldBackfill({ scheduled: true })).toBe(false);
  });

  it("つなぎ直しが少し早まっても（接続にかかる時間の揺れ）、10 分の回は飛ばさない", () => {
    let t = 0;
    const gate = createBackfillGate({ intervalMs: 10 * MIN, now: () => t });
    gate.markBackfilled();
    t = 10 * MIN - 5_000;
    expect(gate.shouldBackfill({ scheduled: true })).toBe(true);
  });

  it("定期のつなぎ直し以外（起動・切断からの再接続・/reconnect）は毎回補完する", () => {
    let t = 0;
    const gate = createBackfillGate({ intervalMs: 10 * MIN, now: () => t });
    gate.markBackfilled();
    t = 1000;
    expect(gate.shouldBackfill({ scheduled: false })).toBe(true);
  });
});
