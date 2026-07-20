import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { TransactionReceipt } from "ethers";

import type { ArbitrageOpportunity } from "../src/arbitrage.js";
import type { ArbitrageCycleConfig } from "../src/arbConfig.js";
import {
  ArbitrageRunner,
  JsonlArbitrageJournal,
  MemoryArbitrageJournal,
  type ArbitrageAlert,
} from "../src/arbitrageRunner.js";

const TOKEN_A = "0x00000000000000000000000000000000000000a1";
const TOKEN_B = "0x00000000000000000000000000000000000000b2";

const cycle: ArbitrageCycleConfig = {
  name: "A-B",
  tokenIn: TOKEN_A,
  tokenMid: TOKEN_B,
  amountIn: 1_000n,
  minNetProfit: 5n,
};

function opportunity(quotedAtMs: number): ArbitrageOpportunity {
  return {
    tokenIn: TOKEN_A,
    tokenMid: TOKEN_B,
    amountIn: 1_000n,
    deadline: 1_000n,
    first: { adapterId: 1, minAmountOut: 1_990n, extra: "0x01", venue: "LFJ", quotedAmountOut: 2_000n },
    second: { adapterId: 3, minAmountOut: 1_010n, extra: "0x03", venue: "Pharaoh", quotedAmountOut: 1_020n },
    expectedAmountOut: 1_020n,
    expectedGrossProfit: 20n,
    estimatedGasCost: 5n,
    minProfit: 10n,
    expectedNetProfit: 15n,
    quotedAtMs,
  };
}

function runner(options: {
  now?: number;
  search?: () => Promise<ArbitrageOpportunity | undefined>;
  fee?: bigint | null;
  mode?: "dry-run" | "live";
  executor?: {
    execute: (opportunity: ArbitrageOpportunity) => Promise<{
      txHash: string;
      profit: bigint;
      receipt: TransactionReceipt;
    }>;
  };
  journal?: MemoryArbitrageJournal;
  alerts?: ArbitrageAlert[];
  maxFailures?: number;
}) {
  let now = options.now ?? 10_000;
  const journal = options.journal ?? new MemoryArbitrageJournal();
  const alerts = options.alerts ?? [];
  const searcher = { findBest: options.search ?? (async () => opportunity(now)) };
  const instance = new ArbitrageRunner(
    {
      mode: options.mode ?? "dry-run",
      pollIntervalMs: 1_000,
      cooldownMs: 100,
      maxQuoteAgeMs: 5_000,
      maxFeePerGasWei: 100n,
      maxConsecutiveFailures: options.maxFailures ?? 3,
      failurePauseMs: 10_000,
      slippageBps: 0,
    },
    { getFeeData: async () => ({ maxFeePerGas: options.fee === undefined ? 10n : options.fee, gasPrice: null }) } as never,
    new Map([[cycle.name, searcher]]),
    journal,
    async (nativeCost) => nativeCost * 2n,
    options.executor ? { estimateGas: async () => 1n, ...options.executor } : undefined,
    (alert) => { alerts.push(alert); },
    { now: () => now, sleep: async (ms) => { now += ms; } },
  );
  return { instance, journal, alerts, setNow: (value: number) => { now = value; } };
}

describe("ArbitrageRunner", () => {
  it("journals a dry-run opportunity without constructing an executor", async () => {
    const { instance, journal } = runner({});
    const result = await instance.scanOnce(cycle);
    expect(result.status).toBe("dry-run");
    expect(journal.entries[0]).toMatchObject({ kind: "dry-run", cycle: "A-B" });
  });

  it("blocks overlapping scans and applies a per-cycle cooldown", async () => {
    let release!: (value: ArbitrageOpportunity) => void;
    const pending = new Promise<ArbitrageOpportunity>((resolve) => { release = resolve; });
    const { instance } = runner({ search: async () => pending });
    const first = instance.scanOnce(cycle);
    expect((await instance.scanOnce(cycle)).status).toBe("busy");
    release(opportunity(10_000));
    expect((await first).status).toBe("dry-run");
    expect((await instance.scanOnce(cycle)).status).toBe("cooldown");
  });

  it("skips stale quotes and gas prices above the hard cap", async () => {
    const stale = runner({ search: async () => opportunity(1_000) });
    expect(await stale.instance.scanOnce(cycle)).toMatchObject({ status: "skipped", reason: "stale-quote" });
    expect(stale.alerts[0].kind).toBe("stale-quote");

    const expensive = runner({ fee: 101n });
    expect(await expensive.instance.scanOnce(cycle)).toMatchObject({ status: "skipped", reason: "high-fee" });
    expect(expensive.alerts[0].kind).toBe("high-fee");
  });

  it("records mined profit and actual converted gas in live mode", async () => {
    const receipt = { fee: 6n } as TransactionReceipt;
    const { instance, journal, alerts } = runner({
      mode: "live",
      fee: 2n,
      executor: { execute: async () => ({ txHash: "0xabc", profit: 10n, receipt }) },
    });
    const result = await instance.scanOnce(cycle);
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.record).toMatchObject({ realizedProfit: 10n, actualGasCostInTokenIn: 12n, realizedNetProfit: -2n });
    expect(journal.entries[0].kind).toBe("submission-intent");
    expect(journal.entries[1].execution?.realizedNetProfit).toBe("-2");
    expect(alerts[0].kind).toBe("negative-realized-pnl");
  });

  it("skips live execution when the exact gas estimate removes the margin", async () => {
    let executed = false;
    const receipt = { fee: 1n } as TransactionReceipt;
    const { instance, alerts } = runner({
      mode: "live",
      fee: 10n,
      executor: {
        execute: async () => {
          executed = true;
          return { txHash: "0xabc", profit: 10n, receipt };
        },
      },
    });
    expect(await instance.scanOnce(cycle)).toMatchObject({ status: "skipped", reason: "gas-unprofitable" });
    expect(executed).toBe(false);
    expect(alerts[0].kind).toBe("gas-unprofitable");
  });

  it("raises the submitted minimum profit when exact gas is higher", async () => {
    let submitted: ArbitrageOpportunity | undefined;
    const receipt = { fee: 3n } as TransactionReceipt;
    const { instance } = runner({
      mode: "live",
      fee: 3n,
      executor: {
        execute: async (value) => {
          submitted = value;
          return { txHash: "0xdef", profit: 15n, receipt };
        },
      },
    });
    expect((await instance.scanOnce(cycle)).status).toBe("executed");
    expect(submitted?.minProfit).toBe(11n);
    expect(submitted?.second.minAmountOut).toBe(1_011n);
  });

  it("opens a circuit after repeated failures", async () => {
    const { instance, setNow, alerts } = runner({
      search: async () => { throw new Error("RPC unavailable\nsecret detail"); },
      maxFailures: 2,
    });
    expect((await instance.scanOnce(cycle)).status).toBe("failed");
    setNow(10_101);
    expect((await instance.scanOnce(cycle)).status).toBe("failed");
    setNow(10_202);
    expect((await instance.scanOnce(cycle)).status).toBe("circuit-open");
    expect(alerts.at(-1)?.kind).toBe("circuit-open");
  });
});

describe("JsonlArbitrageJournal", () => {
  it("persists execution P&L and rebuilds totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seltra-arb-"));
    try {
      const journal = new JsonlArbitrageJournal(join(directory, "arb.jsonl"));
      await journal.append({
        kind: "execution",
        timestamp: 1,
        cycle: "A-B",
        opportunity: {
          tokenIn: TOKEN_A,
          tokenMid: TOKEN_B,
          firstVenue: "LFJ",
          secondVenue: "Pharaoh",
          amountIn: "1000",
          expectedAmountOut: "1020",
          expectedGrossProfit: "20",
          estimatedGasCost: "5",
          expectedNetProfit: "15",
          minProfit: "10",
          deadline: "1000",
          quotedAtMs: 1,
        },
        execution: {
          txHash: "0xabc",
          realizedProfit: "18",
          actualGasCostInTokenIn: "6",
          realizedNetProfit: "12",
        },
      });
      expect(await journal.totals(TOKEN_A)).toEqual({ grossProfit: 18n, gasCost: 6n, netProfit: 12n, trades: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
