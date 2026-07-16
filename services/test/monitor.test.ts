import { describe, expect, it } from "vitest";

import { MetricsTracker, DEFAULT_THRESHOLDS, type DexFillEvent } from "../src/monitor.js";

function dexFill(overrides: Partial<DexFillEvent> = {}): DexFillEvent {
  return {
    orderHash: "0xabc",
    maker: "0x1",
    keeper: "0x2",
    adapterId: 1,
    makingAmount: 10n * 10n ** 18n,
    amountOut: 410n * 10n ** 6n,
    makerImprovement: 7n * 10n ** 6n,
    keeperReward: 3n * 10n ** 6n,
    blockNumber: 1,
    timestampMs: Date.UTC(2026, 6, 10),
    ...overrides,
  };
}

describe("MetricsTracker (spec 2.3 / 3.5)", () => {
  it("aggregates fills, surplus, improvement, match rate", () => {
    const m = new MetricsTracker();
    m.ingestDexFill(dexFill());
    m.ingestP2PFill({
      hashA: "0xa",
      hashB: "0xb",
      surplus: 5n * 10n ** 6n,
      keeperReward: 15n * 10n ** 5n,
      blockNumber: 2,
      timestampMs: Date.UTC(2026, 6, 10),
    });

    const s = m.snapshot();
    expect(s.dexFills).toBe(1);
    expect(s.p2pFills).toBe(1);
    expect(s.p2pMatchRate).toBe(0.5);
    expect(s.totalSurplus).toBe((15n * 10n ** 6n).toString());
    expect(s.totalMakerImprovement).toBe((7n * 10n ** 6n).toString());
  });

  it("healthy fills produce no alerts", () => {
    const m = new MetricsTracker();
    expect(m.ingestDexFill(dexFill())).toHaveLength(0);
  });

  it("griefing signal: streak of near-limit fills", () => {
    const m = new MetricsTracker();
    // Surplus of 0 on a 410 USDC output: within 1 bps of the limit.
    const near = dexFill({ makerImprovement: 0n, keeperReward: 0n });
    expect(m.ingestDexFill(near)).toHaveLength(0);
    expect(m.ingestDexFill(near)).toHaveLength(0);
    const alerts = m.ingestDexFill(near); // third consecutive
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("near-limit-streak");

    // A healthy fill resets the streak.
    m.ingestDexFill(dexFill());
    expect(m.ingestDexFill(near)).toHaveLength(0);
  });

  it("quote deviation beyond threshold alerts", () => {
    const m = new MetricsTracker();
    // realized 410 vs independent quote 430: ~465 bps > 300 bps threshold
    const alerts = m.checkQuoteDeviation("0xabc", 410n * 10n ** 6n, 430n * 10n ** 6n);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("quote-deviation");

    // 410 vs 412: ~48 bps, fine.
    expect(m.checkQuoteDeviation("0xabc", 410n * 10n ** 6n, 412n * 10n ** 6n)).toHaveLength(0);
  });

  it("keeper failure spike within the window", () => {
    const m = new MetricsTracker();
    const t0 = Date.UTC(2026, 6, 10);
    for (let i = 0; i < DEFAULT_THRESHOLDS.failureSpike - 1; i++) {
      expect(m.ingestKeeperFailure(t0 + i * 1000)).toHaveLength(0);
    }
    const alerts = m.ingestKeeperFailure(t0 + 60_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("keeper-failure-spike");

    // Failures outside the window age out.
    const m2 = new MetricsTracker();
    for (let i = 0; i < 10; i++) {
      const alertsSpread = m2.ingestKeeperFailure(t0 + i * 10 * 60_000); // 10 min apart
      expect(alertsSpread).toHaveLength(0);
    }
  });

  it("pause events always alert; pause is critical", () => {
    const m = new MetricsTracker();
    const paused = m.ingestPause(true, "0xguardian");
    expect(paused[0].kind).toBe("fills-paused");
    expect(paused[0].severity).toBe("critical");
    expect(m.ingestPause(false)[0].kind).toBe("fills-unpaused");
  });

  it("fills per minute over a rolling window", () => {
    const m = new MetricsTracker();
    const t0 = Date.UTC(2026, 6, 10);
    for (let i = 0; i < 20; i++) m.ingestDexFill(dexFill({ timestampMs: t0 + i * 30_000 }));
    // 10-minute window ending at t0+10min: 20 fills within it -> 2/min.
    expect(m.fillsPerMinute(t0 + 10 * 60_000)).toBe(2);
  });
});
