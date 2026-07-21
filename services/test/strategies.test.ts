import { describe, expect, it } from "vitest";

import {
  StrategyBook,
  validateStrategy,
  type DcaStrategy,
  type FiniteGridStrategy,
  type MartingaleStrategy,
  type StrategyRiskLimits,
} from "../src/strategies.js";

const OWNER = "0x0000000000000000000000000000000000000010";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

function limits(overrides: Partial<StrategyRiskLimits> = {}): StrategyRiskLimits {
  return {
    maxOrderNotional: 100n,
    maxTotalNotional: 1_000n,
    maxDailyNotional: 500n,
    maxSlippageBps: 100,
    expiresAt: 10_000,
    ...overrides,
  };
}

function grid(overrides: Partial<FiniteGridStrategy> = {}): FiniteGridStrategy {
  return {
    id: "grid-1",
    kind: "finite-grid",
    owner: OWNER,
    pair: "WAVAX/USDC",
    status: "draft",
    limits: limits(),
    createdAt: 100,
    updatedAt: 100,
    orderHashes: [HASH_A, HASH_B],
    ...overrides,
  };
}

function dca(overrides: Partial<DcaStrategy> = {}): DcaStrategy {
  return {
    id: "dca-1",
    kind: "dca",
    owner: OWNER,
    pair: "WAVAX/USDC",
    status: "draft",
    limits: limits(),
    createdAt: 100,
    updatedAt: 100,
    side: "buy",
    amountPerExecution: 50n,
    intervalSeconds: 3_600,
    maxExecutions: 10,
    executionsCompleted: 0,
    nextExecutionAt: 200,
    ...overrides,
  };
}

function martingale(overrides: Partial<MartingaleStrategy> = {}): MartingaleStrategy {
  return {
    id: "martingale-1",
    kind: "martingale",
    owner: OWNER,
    pair: "WAVAX/USDC",
    status: "draft",
    limits: limits(),
    createdAt: 100,
    updatedAt: 100,
    side: "buy",
    baseAmount: 10n,
    multiplierBps: 15_000,
    maxSteps: 3,
    currentStep: 0,
    currentAmount: 10n,
    committedNotional: 0n,
    ...overrides,
  };
}

describe("strategy validation", () => {
  it("accepts bounded finite grids and rejects duplicate children", () => {
    expect(() => validateStrategy(grid())).not.toThrow();
    expect(() => validateStrategy(grid({ orderHashes: [HASH_A, HASH_A] }))).toThrow("unique");
  });

  it("enforces DCA per-order and total budgets", () => {
    expect(() => validateStrategy(dca())).not.toThrow();
    expect(() => validateStrategy(dca({ amountPerExecution: 101n }))).toThrow("per-order");
    expect(() => validateStrategy(dca({ amountPerExecution: 100n, maxExecutions: 11 }))).toThrow("total-notional");
    expect(() => validateStrategy(dca({ maxExecutions: 20 }))).toThrow("daily limit");
  });

  it("keeps martingale disabled unless explicitly feature-gated", () => {
    expect(() => validateStrategy(martingale())).toThrow("disabled");
    expect(() => validateStrategy(martingale(), { martingaleEnabled: true })).not.toThrow();
    expect(() => validateStrategy(martingale({ maxSteps: 7 }), { martingaleEnabled: true })).toThrow("maxSteps");
  });
});

describe("StrategyBook", () => {
  it("enforces lifecycle transitions and returns defensive copies", () => {
    const book = new StrategyBook();
    book.add(grid());
    expect(book.activate("grid-1", 101).status).toBe("active");
    expect(book.pause("grid-1", 102).status).toBe("paused");
    expect(book.activate("grid-1", 103).status).toBe("active");
    expect(book.cancel("grid-1", 104).status).toBe("cancelled");
    expect(() => book.activate("grid-1", 105)).toThrow("cannot transition");

    const copy = book.get("grid-1") as FiniteGridStrategy;
    copy.orderHashes.length = 0;
    expect((book.get("grid-1") as FiniteGridStrategy).orderHashes).toHaveLength(2);
  });

  it("returns due DCA strategies and skips catch-up bursts", () => {
    const book = new StrategyBook();
    book.add(dca());
    book.activate("dca-1", 101);
    expect(book.due(199)).toHaveLength(0);
    expect(book.due(200)).toHaveLength(1);

    const updated = book.recordDcaExecution("dca-1", 50n, 10_000 - 4_000);
    expect(updated.executionsCompleted).toBe(1);
    expect(updated.nextExecutionAt).toBe(9_600);
    expect(book.due(6_001)).toHaveLength(0);
  });

  it("rejects early or wrong-sized DCA records without mutating state", () => {
    const book = new StrategyBook();
    book.add(dca());
    book.activate("dca-1", 101);
    expect(() => book.recordDcaExecution("dca-1", 50n, 199)).toThrow("not due");
    expect(() => book.recordDcaExecution("dca-1", 49n, 200)).toThrow("unexpected");
    expect((book.get("dca-1") as DcaStrategy).executionsCompleted).toBe(0);
  });

  it("completes a DCA plan after its final execution", () => {
    const book = new StrategyBook();
    book.add(dca({ maxExecutions: 1 }));
    book.activate("dca-1", 101);
    expect(book.recordDcaExecution("dca-1", 50n, 200).status).toBe("completed");
  });

  it("bounds martingale progression and resets after a win", () => {
    const book = new StrategyBook({ martingaleEnabled: true });
    book.add(martingale());
    book.activate("martingale-1", 101);

    const afterLoss = book.recordMartingaleResult("martingale-1", false, 10n, 200);
    expect(afterLoss.currentStep).toBe(1);
    expect(afterLoss.currentAmount).toBe(15n);
    const afterWin = book.recordMartingaleResult("martingale-1", true, 15n, 300);
    expect(afterWin.currentStep).toBe(0);
    expect(afterWin.currentAmount).toBe(10n);
  });

  it("enforces daily usage and leaves rejected martingale state unchanged", () => {
    const book = new StrategyBook({ martingaleEnabled: true });
    book.add(martingale({ limits: limits({ maxDailyNotional: 10n }) }));
    book.activate("martingale-1", 101);
    book.recordMartingaleResult("martingale-1", true, 10n, 200);
    expect(() => book.recordMartingaleResult("martingale-1", true, 10n, 201)).toThrow("daily-notional");
    expect((book.get("martingale-1") as MartingaleStrategy).committedNotional).toBe(10n);
  });
});
