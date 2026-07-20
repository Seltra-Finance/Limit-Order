export type StrategyKind = "finite-grid" | "dca" | "martingale";
export type StrategyStatus = "draft" | "active" | "paused" | "completed" | "cancelled" | "failed";
export type StrategySide = "buy" | "sell";

export interface StrategyRiskLimits {
  maxOrderNotional: bigint;
  maxTotalNotional: bigint;
  maxDailyNotional: bigint;
  maxSlippageBps: number;
  expiresAt: number;
}

interface StrategyBase {
  id: string;
  kind: StrategyKind;
  owner: string;
  pair: string;
  status: StrategyStatus;
  limits: StrategyRiskLimits;
  createdAt: number;
  updatedAt: number;
}

export interface FiniteGridStrategy extends StrategyBase {
  kind: "finite-grid";
  orderHashes: string[];
}

export interface DcaStrategy extends StrategyBase {
  kind: "dca";
  side: StrategySide;
  amountPerExecution: bigint;
  intervalSeconds: number;
  maxExecutions: number;
  executionsCompleted: number;
  nextExecutionAt: number;
}

export interface MartingaleStrategy extends StrategyBase {
  kind: "martingale";
  side: StrategySide;
  baseAmount: bigint;
  multiplierBps: number;
  maxSteps: number;
  currentStep: number;
  currentAmount: bigint;
  committedNotional: bigint;
}

export type Strategy = FiniteGridStrategy | DcaStrategy | MartingaleStrategy;

export interface StrategyFeatureFlags {
  martingaleEnabled: boolean;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DAY_SECONDS = 86_400;

/**
 * Validates bounded strategy templates only. Arbitrary code, arbitrary call
 * targets, leverage, and uncapped notional are intentionally not represented.
 */
export function validateStrategy(
  strategy: Strategy,
  flags: StrategyFeatureFlags = { martingaleEnabled: false },
): void {
  if (!strategy.id.trim()) throw new Error("strategy id is required");
  if (!ADDRESS_RE.test(strategy.owner)) throw new Error("strategy owner must be an address");
  if (!strategy.pair.trim()) throw new Error("strategy pair is required");
  if (!Number.isInteger(strategy.createdAt) || strategy.createdAt < 0) throw new Error("invalid createdAt");
  if (!Number.isInteger(strategy.updatedAt)) throw new Error("invalid updatedAt");
  validateRiskLimits(strategy.limits, strategy.createdAt);
  if (strategy.updatedAt < strategy.createdAt) throw new Error("updatedAt precedes createdAt");

  switch (strategy.kind) {
    case "finite-grid":
      if (strategy.orderHashes.length === 0 || strategy.orderHashes.length > 20) {
        throw new Error("finite grids require 1 to 20 child orders");
      }
      if (new Set(strategy.orderHashes.map((x) => x.toLowerCase())).size !== strategy.orderHashes.length) {
        throw new Error("finite grid order hashes must be unique");
      }
      if (strategy.orderHashes.some((hash) => !HASH_RE.test(hash))) throw new Error("invalid grid order hash");
      break;
    case "dca":
      if (strategy.amountPerExecution <= 0n) throw new Error("DCA amount must be positive");
      if (!Number.isInteger(strategy.intervalSeconds) || strategy.intervalSeconds < 60) {
        throw new Error("DCA interval must be at least 60 seconds");
      }
      if (!Number.isInteger(strategy.maxExecutions) || strategy.maxExecutions < 1 || strategy.maxExecutions > 365) {
        throw new Error("DCA maxExecutions must be in [1, 365]");
      }
      if (
        !Number.isInteger(strategy.executionsCompleted) || strategy.executionsCompleted < 0
        || strategy.executionsCompleted > strategy.maxExecutions
      ) throw new Error("invalid DCA execution count");
      if (strategy.amountPerExecution > strategy.limits.maxOrderNotional) {
        throw new Error("DCA amount exceeds the per-order limit");
      }
      if (strategy.amountPerExecution > strategy.limits.maxDailyNotional) {
        throw new Error("DCA amount exceeds the daily limit");
      }
      if (strategy.amountPerExecution * BigInt(strategy.maxExecutions) > strategy.limits.maxTotalNotional) {
        throw new Error("DCA schedule exceeds the total-notional limit");
      }
      if (
        !Number.isInteger(strategy.nextExecutionAt) || strategy.nextExecutionAt < strategy.createdAt
        || strategy.nextExecutionAt > strategy.limits.expiresAt
      ) throw new Error("invalid DCA nextExecutionAt");
      const executionsPerDay = Math.min(strategy.maxExecutions, Math.ceil(DAY_SECONDS / strategy.intervalSeconds));
      if (strategy.amountPerExecution * BigInt(executionsPerDay) > strategy.limits.maxDailyNotional) {
        throw new Error("DCA cadence exceeds the daily limit");
      }
      break;
    case "martingale": {
      if (!flags.martingaleEnabled) throw new Error("martingale strategies are disabled");
      if (strategy.baseAmount <= 0n) throw new Error("martingale base amount must be positive");
      if (!Number.isInteger(strategy.multiplierBps) || strategy.multiplierBps <= 10_000 || strategy.multiplierBps > 20_000) {
        throw new Error("martingale multiplier must be in (1x, 2x]");
      }
      if (!Number.isInteger(strategy.maxSteps) || strategy.maxSteps < 1 || strategy.maxSteps > 6) {
        throw new Error("martingale maxSteps must be in [1, 6]");
      }
      if (!Number.isInteger(strategy.currentStep) || strategy.currentStep < 0 || strategy.currentStep > strategy.maxSteps) {
        throw new Error("invalid martingale step");
      }
      if (
        strategy.currentAmount <= 0n || strategy.currentAmount > strategy.limits.maxOrderNotional
        || strategy.currentAmount > strategy.limits.maxDailyNotional
      ) {
        throw new Error("martingale amount exceeds the per-order limit");
      }
      if (strategy.baseAmount > strategy.limits.maxOrderNotional || strategy.baseAmount > strategy.limits.maxDailyNotional) {
        throw new Error("martingale base amount exceeds its limits");
      }
      if (strategy.committedNotional < 0n || strategy.committedNotional > strategy.limits.maxTotalNotional) {
        throw new Error("martingale committed notional exceeds its hard budget");
      }
      break;
    }
  }
}

export class StrategyBook {
  private readonly strategies = new Map<string, Strategy>();
  private readonly dailyUsage = new Map<string, Map<number, bigint>>();

  constructor(private readonly flags: StrategyFeatureFlags = { martingaleEnabled: false }) {}

  add(strategy: Strategy): void {
    validateStrategy(strategy, this.flags);
    if (this.strategies.has(strategy.id)) throw new Error("strategy already exists");
    this.strategies.set(strategy.id, cloneStrategy(strategy));
  }

  get(id: string): Strategy | undefined {
    const strategy = this.strategies.get(id);
    return strategy ? cloneStrategy(strategy) : undefined;
  }

  list(owner?: string): Strategy[] {
    const normalized = owner?.toLowerCase();
    return [...this.strategies.values()]
      .filter((strategy) => !normalized || strategy.owner.toLowerCase() === normalized)
      .map(cloneStrategy);
  }

  activate(id: string, now: number): Strategy {
    return this.transition(id, "active", now, ["draft", "paused"]);
  }

  pause(id: string, now: number): Strategy {
    return this.transition(id, "paused", now, ["active"]);
  }

  cancel(id: string, now: number): Strategy {
    return this.transition(id, "cancelled", now, ["draft", "active", "paused"]);
  }

  due(now: number): DcaStrategy[] {
    assertTimestamp(now);
    return [...this.strategies.values()]
      .filter(
        (strategy): strategy is DcaStrategy =>
          strategy.kind === "dca" && strategy.status === "active" && strategy.nextExecutionAt <= now
          && strategy.limits.expiresAt >= now && strategy.executionsCompleted < strategy.maxExecutions
          && this.usageFor(strategy.id, now) + strategy.amountPerExecution <= strategy.limits.maxDailyNotional,
      )
      .map((strategy) => cloneStrategy(strategy) as DcaStrategy);
  }

  recordDcaExecution(id: string, executedNotional: bigint, now: number): DcaStrategy {
    assertTimestamp(now);
    const current = this.require(id);
    if (current.kind !== "dca") throw new Error("strategy is not DCA");
    if (current.status !== "active") throw new Error("DCA strategy is not active");
    if (now < current.updatedAt) throw new Error("strategy timestamp moved backwards");
    if (now < current.nextExecutionAt) throw new Error("DCA execution is not due");
    if (now > current.limits.expiresAt) throw new Error("DCA strategy has expired");
    if (executedNotional !== current.amountPerExecution) throw new Error("unexpected DCA execution amount");
    this.assertDailyCapacity(current, executedNotional, now);

    const strategy = cloneStrategy(current);
    strategy.executionsCompleted += 1;
    strategy.updatedAt = now;
    if (strategy.executionsCompleted >= strategy.maxExecutions || now === strategy.limits.expiresAt) {
      strategy.status = "completed";
    } else {
      // Missed intervals are skipped rather than creating a burst of catch-up
      // executions after downtime.
      strategy.nextExecutionAt = Math.max(strategy.nextExecutionAt + strategy.intervalSeconds, now + strategy.intervalSeconds);
    }
    validateStrategy(strategy, this.flags);
    this.strategies.set(id, strategy);
    this.recordUsage(id, executedNotional, now);
    return cloneStrategy(strategy) as DcaStrategy;
  }

  recordMartingaleResult(id: string, won: boolean, executedNotional: bigint, now: number): MartingaleStrategy {
    assertTimestamp(now);
    const current = this.require(id);
    if (current.kind !== "martingale") throw new Error("strategy is not martingale");
    if (current.status !== "active") throw new Error("martingale strategy is not active");
    if (now < current.updatedAt) throw new Error("strategy timestamp moved backwards");
    if (now > current.limits.expiresAt) throw new Error("martingale strategy has expired");
    if (executedNotional !== current.currentAmount) throw new Error("unexpected martingale execution amount");
    if (current.committedNotional + executedNotional > current.limits.maxTotalNotional) {
      throw new Error("martingale execution exceeds its total budget");
    }
    this.assertDailyCapacity(current, executedNotional, now);

    const strategy = cloneStrategy(current);
    strategy.committedNotional += executedNotional;
    strategy.updatedAt = now;
    if (won) {
      strategy.currentStep = 0;
      strategy.currentAmount = strategy.baseAmount;
      if (strategy.committedNotional + strategy.baseAmount > strategy.limits.maxTotalNotional) {
        strategy.status = "completed";
      }
    } else if (strategy.currentStep >= strategy.maxSteps) {
      strategy.status = "completed";
    } else {
      const nextStep = strategy.currentStep + 1;
      const nextAmount = (strategy.currentAmount * BigInt(strategy.multiplierBps)) / 10_000n;
      if (
        nextAmount > strategy.limits.maxOrderNotional
        || nextAmount > strategy.limits.maxDailyNotional
        || strategy.committedNotional + nextAmount > strategy.limits.maxTotalNotional
      ) {
        strategy.status = "completed";
      } else {
        strategy.currentStep = nextStep;
        strategy.currentAmount = nextAmount;
      }
    }
    validateStrategy(strategy, this.flags);
    this.strategies.set(id, strategy);
    this.recordUsage(id, executedNotional, now);
    return cloneStrategy(strategy) as MartingaleStrategy;
  }

  private transition(id: string, status: StrategyStatus, now: number, allowed: StrategyStatus[]): Strategy {
    assertTimestamp(now);
    const current = this.require(id);
    if (!allowed.includes(current.status)) throw new Error(`cannot transition ${current.status} to ${status}`);
    if (now < current.updatedAt) throw new Error("strategy timestamp moved backwards");
    if (status === "active" && now > current.limits.expiresAt) throw new Error("strategy has expired");
    const strategy = cloneStrategy(current);
    strategy.status = status;
    strategy.updatedAt = now;
    validateStrategy(strategy, this.flags);
    this.strategies.set(id, strategy);
    return cloneStrategy(strategy);
  }

  private assertDailyCapacity(strategy: Strategy, notional: bigint, now: number): void {
    if (this.usageFor(strategy.id, now) + notional > strategy.limits.maxDailyNotional) {
      throw new Error("strategy daily-notional limit exceeded");
    }
  }

  private usageFor(id: string, now: number): bigint {
    return this.dailyUsage.get(id)?.get(Math.floor(now / DAY_SECONDS)) ?? 0n;
  }

  private recordUsage(id: string, notional: bigint, now: number): void {
    const day = Math.floor(now / DAY_SECONDS);
    const usage = this.dailyUsage.get(id) ?? new Map<number, bigint>();
    usage.set(day, (usage.get(day) ?? 0n) + notional);
    this.dailyUsage.set(id, usage);
  }

  private require(id: string): Strategy {
    const strategy = this.strategies.get(id);
    if (!strategy) throw new Error("strategy not found");
    return strategy;
  }
}

function validateRiskLimits(limits: StrategyRiskLimits, createdAt: number): void {
  if (limits.maxOrderNotional <= 0n) throw new Error("maxOrderNotional must be positive");
  if (limits.maxTotalNotional < limits.maxOrderNotional) {
    throw new Error("maxTotalNotional must cover at least one order");
  }
  if (limits.maxDailyNotional <= 0n || limits.maxDailyNotional > limits.maxTotalNotional) {
    throw new Error("maxDailyNotional must be positive and bounded by total notional");
  }
  if (!Number.isInteger(limits.maxSlippageBps) || limits.maxSlippageBps < 0 || limits.maxSlippageBps > 1_000) {
    throw new Error("maxSlippageBps must be in [0, 1000]");
  }
  if (!Number.isInteger(limits.expiresAt) || limits.expiresAt <= createdAt) {
    throw new Error("strategy expiry must be after creation");
  }
}

function assertTimestamp(now: number): void {
  if (!Number.isInteger(now) || now < 0) throw new Error("invalid timestamp");
}

function cloneStrategy<T extends Strategy>(strategy: T): T {
  return {
    ...strategy,
    limits: { ...strategy.limits },
    ...(strategy.kind === "finite-grid" ? { orderHashes: [...strategy.orderHashes] } : {}),
  } as T;
}
