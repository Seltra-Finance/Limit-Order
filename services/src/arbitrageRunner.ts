import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Provider, TransactionReceipt } from "ethers";

import type {
  ArbitrageExecutionRecord,
  ArbitrageOpportunity,
  ArbitrageSearcher,
} from "./arbitrage.js";
import { applyBpsHaircut } from "./arbitrage.js";
import type { ArbitrageCycleConfig, ArbitrageMode } from "./arbConfig.js";

export type ArbitrageAlertKind =
  | "circuit-open"
  | "execution-failed"
  | "gas-unprofitable"
  | "high-fee"
  | "negative-realized-pnl"
  | "stale-quote";

export interface ArbitrageAlert {
  severity: "warning" | "critical";
  kind: ArbitrageAlertKind;
  message: string;
  timestamp: number;
  data?: Record<string, string | number>;
}

export type ArbitrageScanResult =
  | { status: "busy" | "cooldown" | "circuit-open" | "no-opportunity" }
  | { status: "skipped"; reason: "gas-unprofitable" | "high-fee" | "stale-quote"; opportunity: ArbitrageOpportunity }
  | { status: "dry-run"; opportunity: ArbitrageOpportunity }
  | { status: "executed"; opportunity: ArbitrageOpportunity; record: ArbitrageExecutionRecord }
  | { status: "failed"; reason: string };

export interface ArbitrageExecutor {
  estimateGas(opportunity: ArbitrageOpportunity): Promise<bigint>;
  execute(opportunity: ArbitrageOpportunity): Promise<{
    txHash: string;
    profit: bigint;
    receipt: TransactionReceipt;
  }>;
}

export interface ArbitrageJournalEntry {
  kind: "dry-run" | "submission-intent" | "execution" | "failure" | "skip";
  timestamp: number;
  cycle: string;
  reason?: string;
  opportunity?: SerializedOpportunity;
  execution?: SerializedExecution;
}

interface SerializedOpportunity {
  tokenIn: string;
  tokenMid: string;
  firstVenue: string;
  secondVenue: string;
  amountIn: string;
  expectedAmountOut: string;
  expectedGrossProfit: string;
  estimatedGasCost: string;
  expectedNetProfit: string;
  minProfit: string;
  deadline: string;
  quotedAtMs: number;
}

interface SerializedExecution {
  txHash: string;
  realizedProfit: string;
  actualGasCostInTokenIn: string;
  realizedNetProfit: string;
}

export interface ArbitrageJournal {
  append(entry: ArbitrageJournalEntry): Promise<void>;
}

export class MemoryArbitrageJournal implements ArbitrageJournal {
  readonly entries: ArbitrageJournalEntry[] = [];

  async append(entry: ArbitrageJournalEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }
}

/** Append-only JSONL journal. A partial/corrupt line fails loudly on read. */
export class JsonlArbitrageJournal implements ArbitrageJournal {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async append(entry: ArbitrageJournalEntry): Promise<void> {
    const write = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
    });
    this.pending = write.catch(() => undefined);
    await write;
  }

  async read(): Promise<ArbitrageJournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as ArbitrageJournalEntry;
        } catch {
          throw new Error(`invalid arbitrage journal JSON at line ${index + 1}`);
        }
      });
  }

  async totals(tokenIn: string): Promise<{ grossProfit: bigint; gasCost: bigint; netProfit: bigint; trades: number }> {
    const normalized = tokenIn.toLowerCase();
    const executions = (await this.read()).filter(
      (entry) => entry.kind === "execution" && entry.execution && entry.opportunity?.tokenIn.toLowerCase() === normalized,
    );
    return executions.reduce(
      (totals, entry) => ({
        grossProfit: totals.grossProfit + BigInt(entry.execution!.realizedProfit),
        gasCost: totals.gasCost + BigInt(entry.execution!.actualGasCostInTokenIn),
        netProfit: totals.netProfit + BigInt(entry.execution!.realizedNetProfit),
        trades: totals.trades + 1,
      }),
      { grossProfit: 0n, gasCost: 0n, netProfit: 0n, trades: 0 },
    );
  }
}

export interface ArbitrageRunnerConfig {
  mode: ArbitrageMode;
  pollIntervalMs: number;
  cooldownMs: number;
  maxQuoteAgeMs: number;
  maxFeePerGasWei: bigint;
  maxConsecutiveFailures: number;
  failurePauseMs: number;
  slippageBps: number;
}

interface RunnerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: RunnerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Continuous single-process coordinator. Per-cycle locks, cooldowns and the
 * executor's own transaction lock prevent nonce races. Circuit breaking is
 * deliberately local; an external supervisor may restart only after review.
 */
export class ArbitrageRunner {
  private readonly inFlight = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private stopped = false;

  constructor(
    private readonly config: ArbitrageRunnerConfig,
    private readonly provider: Pick<Provider, "getFeeData">,
    private readonly searchers: ReadonlyMap<string, Pick<ArbitrageSearcher, "findBest">>,
    private readonly journal: ArbitrageJournal,
    private readonly convertActualGasToTokenIn: (
      nativeCost: bigint,
      tokenIn: string,
      deadline: bigint,
    ) => Promise<bigint>,
    private readonly executor?: ArbitrageExecutor,
    private readonly onAlert: (alert: ArbitrageAlert) => void | Promise<void> = () => undefined,
    private readonly clock: RunnerClock = SYSTEM_CLOCK,
  ) {
    if (config.mode === "live" && !executor) throw new Error("live runner requires an executor");
  }

  async scanOnce(cycle: ArbitrageCycleConfig): Promise<ArbitrageScanResult> {
    const now = this.clock.now();
    if (this.inFlight.has(cycle.name)) return { status: "busy" };
    if (now < this.circuitOpenUntil) return { status: "circuit-open" };
    const lastAttempt = this.lastAttemptAt.get(cycle.name);
    if (lastAttempt !== undefined && now - lastAttempt < this.config.cooldownMs) return { status: "cooldown" };

    const searcher = this.searchers.get(cycle.name);
    if (!searcher) throw new Error(`missing searcher for cycle ${cycle.name}`);

    this.inFlight.add(cycle.name);
    try {
      let opportunity = await searcher.findBest(cycle.tokenIn, cycle.tokenMid, cycle.amountIn, BigInt(Math.floor(now / 1000)));
      if (!opportunity) return { status: "no-opportunity" };

      this.lastAttemptAt.set(cycle.name, now);
      const quoteAge = this.clock.now() - opportunity.quotedAtMs;
      if (quoteAge > this.config.maxQuoteAgeMs) {
        await this.skip(cycle.name, opportunity, "stale-quote", `quote is ${quoteAge}ms old`);
        return { status: "skipped", reason: "stale-quote", opportunity };
      }

      const feeData = await this.provider.getFeeData();
      const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
      if (!feePerGas || feePerGas > this.config.maxFeePerGasWei) {
        await this.skip(cycle.name, opportunity, "high-fee", `fee per gas ${feePerGas ?? 0n} exceeds cap`);
        return { status: "skipped", reason: "high-fee", opportunity };
      }

      if (this.config.mode === "dry-run") {
        await this.journal.append({
          kind: "dry-run",
          timestamp: this.clock.now(),
          cycle: cycle.name,
          opportunity: serializeOpportunity(opportunity),
        });
        this.consecutiveFailures = 0;
        return { status: "dry-run", opportunity };
      }

      const exactGasUnits = await this.executor!.estimateGas(opportunity);
      const exactNativeGasCost = exactGasUnits * feePerGas;
      const exactGasCostInTokenIn = await this.convertActualGasToTokenIn(
        exactNativeGasCost,
        opportunity.tokenIn,
        opportunity.deadline,
      );
      const requiredProfit = exactGasCostInTokenIn + cycle.minNetProfit;
      const conservativeFinalOut = applyBpsHaircut(
        applyBpsHaircut(opportunity.expectedAmountOut, this.config.slippageBps),
        this.config.slippageBps,
      );
      if (conservativeFinalOut < opportunity.amountIn + requiredProfit) {
        await this.skip(
          cycle.name,
          opportunity,
          "gas-unprofitable",
          `exact gas estimate leaves less than the required net profit`,
        );
        return { status: "skipped", reason: "gas-unprofitable", opportunity };
      }
      if (requiredProfit > opportunity.minProfit) {
        opportunity = {
          ...opportunity,
          estimatedGasCost: exactGasCostInTokenIn,
          minProfit: requiredProfit,
          expectedNetProfit: opportunity.expectedGrossProfit - exactGasCostInTokenIn,
          second: {
            ...opportunity.second,
            minAmountOut: opportunity.amountIn + requiredProfit,
          },
        };
      }
      const refreshedQuoteAge = this.clock.now() - opportunity.quotedAtMs;
      if (refreshedQuoteAge > this.config.maxQuoteAgeMs) {
        await this.skip(cycle.name, opportunity, "stale-quote", `quote is ${refreshedQuoteAge}ms old after gas estimation`);
        return { status: "skipped", reason: "stale-quote", opportunity };
      }

      // Persist before broadcasting. If the process or disk fails after a
      // mined transaction, this intent gives operators a bounded chain-event
      // reconciliation window instead of an invisible accounting gap.
      await this.journal.append({
        kind: "submission-intent",
        timestamp: this.clock.now(),
        cycle: cycle.name,
        opportunity: serializeOpportunity(opportunity),
      });
      const execution = await this.executor!.execute(opportunity);
      const nativeGasCost = execution.receipt.fee;
      const actualGasCostInTokenIn = await this.convertActualGasToTokenIn(
        nativeGasCost,
        opportunity.tokenIn,
        opportunity.deadline,
      );
      const record: ArbitrageExecutionRecord = {
        txHash: execution.txHash,
        tokenIn: opportunity.tokenIn,
        tokenMid: opportunity.tokenMid,
        firstVenue: opportunity.first.venue,
        secondVenue: opportunity.second.venue,
        amountIn: opportunity.amountIn,
        expectedProfit: opportunity.expectedGrossProfit,
        realizedProfit: execution.profit,
        actualGasCostInTokenIn,
        realizedNetProfit: execution.profit - actualGasCostInTokenIn,
        timestamp: this.clock.now(),
      };
      await this.journal.append({
        kind: "execution",
        timestamp: record.timestamp,
        cycle: cycle.name,
        opportunity: serializeOpportunity(opportunity),
        execution: serializeExecution(record),
      });
      if (record.realizedNetProfit < 0n) {
        await this.alert({
          severity: "critical",
          kind: "negative-realized-pnl",
          message: `arbitrage ${record.txHash} lost money after gas`,
          timestamp: record.timestamp,
          data: { txHash: record.txHash, realizedNetProfit: record.realizedNetProfit.toString() },
        });
      }
      this.consecutiveFailures = 0;
      return { status: "executed", opportunity, record };
    } catch (error) {
      return this.fail(cycle.name, error);
    } finally {
      this.inFlight.delete(cycle.name);
    }
  }

  async start(cycles: readonly ArbitrageCycleConfig[]): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      for (const cycle of cycles) {
        if (this.stopped) break;
        await this.scanOnce(cycle);
      }
      if (!this.stopped) await this.clock.sleep(this.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async skip(
    cycle: string,
    opportunity: ArbitrageOpportunity,
    kind: "gas-unprofitable" | "high-fee" | "stale-quote",
    reason: string,
  ): Promise<void> {
    await this.journal.append({
      kind: "skip",
      timestamp: this.clock.now(),
      cycle,
      reason,
      opportunity: serializeOpportunity(opportunity),
    });
    await this.alert({ severity: "warning", kind, message: `${cycle}: ${reason}`, timestamp: this.clock.now() });
  }

  private async fail(cycle: string, error: unknown): Promise<ArbitrageScanResult> {
    const reason = safeError(error);
    this.consecutiveFailures++;
    await this.journal.append({ kind: "failure", timestamp: this.clock.now(), cycle, reason });
    await this.alert({
      severity: "warning",
      kind: "execution-failed",
      message: `${cycle}: ${reason}`,
      timestamp: this.clock.now(),
      data: { consecutiveFailures: this.consecutiveFailures },
    });
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.circuitOpenUntil = this.clock.now() + this.config.failurePauseMs;
      await this.alert({
        severity: "critical",
        kind: "circuit-open",
        message: `arbitrage paused for ${this.config.failurePauseMs}ms after ${this.consecutiveFailures} failures`,
        timestamp: this.clock.now(),
        data: { openUntil: this.circuitOpenUntil },
      });
    }
    return { status: "failed", reason };
  }

  private async alert(alert: ArbitrageAlert): Promise<void> {
    await this.onAlert(alert);
  }
}

export async function emitArbitrageAlert(alert: ArbitrageAlert, webhookUrl?: string): Promise<void> {
  const line = `[arb:${alert.severity}] ${alert.kind}: ${alert.message}`;
  if (alert.severity === "critical") console.error(line);
  else console.warn(line);
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: line, ...alert }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    console.error("arbitrage alert webhook failed", safeError(error));
  }
}

function serializeOpportunity(opportunity: ArbitrageOpportunity): SerializedOpportunity {
  return {
    tokenIn: opportunity.tokenIn,
    tokenMid: opportunity.tokenMid,
    firstVenue: opportunity.first.venue,
    secondVenue: opportunity.second.venue,
    amountIn: opportunity.amountIn.toString(),
    expectedAmountOut: opportunity.expectedAmountOut.toString(),
    expectedGrossProfit: opportunity.expectedGrossProfit.toString(),
    estimatedGasCost: opportunity.estimatedGasCost.toString(),
    expectedNetProfit: opportunity.expectedNetProfit.toString(),
    minProfit: opportunity.minProfit.toString(),
    deadline: opportunity.deadline.toString(),
    quotedAtMs: opportunity.quotedAtMs,
  };
}

function serializeExecution(record: ArbitrageExecutionRecord): SerializedExecution {
  return {
    txHash: record.txHash,
    realizedProfit: record.realizedProfit.toString(),
    actualGasCostInTokenIn: record.actualGasCostInTokenIn.toString(),
    realizedNetProfit: record.realizedNetProfit.toString(),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/0x[0-9a-fA-F]{130,}/g, "[redacted-hex]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}
