import { Contract, type Provider } from "ethers";

import { SETTLEMENT_ABI } from "./abi.js";
import type { SeltraConfig } from "./config.js";
import { queryParsedContractLogs } from "./logs.js";

/**
 * Monitoring and alerting (revised spec 2.3 / 3.5). Two layers:
 *
 *  - MetricsTracker: pure, testable ingestion of typed protocol events into
 *    rolling metrics + alert decisions (griefing signal, quote deviation,
 *    keeper failure spikes, pause events).
 *  - SeltraMonitor: thin chain poller that feeds settlement events into the
 *    tracker and forwards alerts to console + optional webhook. Dashboards
 *    (fills/min per path, surplus distribution, maker improvement paid,
 *    keeper win rate, P2P match rate) read the same metrics.
 */

export interface MonitorAlert {
  severity: "info" | "warning" | "critical";
  kind:
    | "fills-paused"
    | "fills-unpaused"
    | "near-limit-streak"
    | "quote-deviation"
    | "keeper-failure-spike"
    | "maker-invariant-violation";
  message: string;
  data?: Record<string, unknown>;
}

export interface DexFillEvent {
  orderHash: string;
  maker: string;
  keeper: string;
  adapterId: number;
  makingAmount: bigint;
  amountOut: bigint;
  makerImprovement: bigint;
  keeperReward: bigint;
  blockNumber: number;
  timestampMs: number;
}

export interface P2PFillEvent {
  hashA: string;
  hashB: string;
  surplus: bigint;
  keeperReward: bigint;
  blockNumber: number;
  timestampMs: number;
}

export interface MonitorThresholds {
  /** DEX fills with surplus <= this (relative to amountOut, in bps) count as
   *  "near limit"; a streak of them is the griefing signal (spec 2.3). */
  nearLimitBps: number;
  nearLimitStreak: number;
  /** alert when realized output deviates from an independent quote by more
   *  than this many bps */
  quoteDeviationBps: number;
  /** keeper failures within failureWindowMs that trigger a spike alert */
  failureSpike: number;
  failureWindowMs: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  nearLimitBps: 1, // surplus <= 0.01% of output
  nearLimitStreak: 3,
  quoteDeviationBps: 300,
  failureSpike: 5,
  failureWindowMs: 5 * 60_000,
};

export class MetricsTracker {
  dexFills = 0;
  p2pFills = 0;
  totalSurplus = 0n;
  totalMakerImprovement = 0n;
  totalKeeperReward = 0n;
  keeperFailures = 0;

  private nearLimitRun = 0;
  private failureTimestamps: number[] = [];
  private fillTimestamps: number[] = [];

  constructor(private readonly thresholds: MonitorThresholds = DEFAULT_THRESHOLDS) {}

  ingestDexFill(e: DexFillEvent): MonitorAlert[] {
    this.dexFills++;
    this.fillTimestamps.push(e.timestampMs);
    const surplus = e.makerImprovement + e.keeperReward; // pre-protocol-fee lower bound
    this.totalSurplus += surplus;
    this.totalMakerImprovement += e.makerImprovement;
    this.totalKeeperReward += e.keeperReward;

    const alerts: MonitorAlert[] = [];

    // Maker invariant (belt over the on-chain suspenders): improvement must
    // be ~70% of surplus and amountOut must cover the implied taking side.
    if (e.amountOut < surplus) {
      alerts.push({
        severity: "critical",
        kind: "maker-invariant-violation",
        message: `fill ${e.orderHash} reports surplus ${surplus} exceeding amountOut ${e.amountOut}`,
        data: { orderHash: e.orderHash },
      });
    }

    // Griefing signal: repeated fills that land within dust of the limit.
    const nearLimit = surplus * 10_000n <= BigInt(this.thresholds.nearLimitBps) * e.amountOut;
    this.nearLimitRun = nearLimit ? this.nearLimitRun + 1 : 0;
    if (this.nearLimitRun >= this.thresholds.nearLimitStreak) {
      alerts.push({
        severity: "warning",
        kind: "near-limit-streak",
        message: `${this.nearLimitRun} consecutive DEX fills within ${this.thresholds.nearLimitBps} bps of the maker limit (possible griefing)`,
        data: { streak: this.nearLimitRun, lastOrder: e.orderHash },
      });
    }
    return alerts;
  }

  ingestP2PFill(e: P2PFillEvent): MonitorAlert[] {
    this.p2pFills++;
    this.fillTimestamps.push(e.timestampMs);
    this.totalSurplus += e.surplus;
    this.totalKeeperReward += e.keeperReward;
    return [];
  }

  /** Compare realized output to an independently fetched quote (spec 2.3:
   *  "adapter output deviating from an independent quote beyond threshold"). */
  checkQuoteDeviation(orderHash: string, amountOut: bigint, independentQuote: bigint): MonitorAlert[] {
    if (independentQuote === 0n) return [];
    const diff = amountOut > independentQuote ? amountOut - independentQuote : independentQuote - amountOut;
    const bps = (diff * 10_000n) / independentQuote;
    if (bps > BigInt(this.thresholds.quoteDeviationBps)) {
      return [
        {
          severity: "warning",
          kind: "quote-deviation",
          message: `fill ${orderHash} realized ${amountOut} vs independent quote ${independentQuote} (${bps} bps deviation)`,
          data: { orderHash, bps: Number(bps) },
        },
      ];
    }
    return [];
  }

  ingestKeeperFailure(timestampMs: number): MonitorAlert[] {
    this.keeperFailures++;
    this.failureTimestamps.push(timestampMs);
    const cutoff = timestampMs - this.thresholds.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
    if (this.failureTimestamps.length >= this.thresholds.failureSpike) {
      return [
        {
          severity: "warning",
          kind: "keeper-failure-spike",
          message: `${this.failureTimestamps.length} keeper fill failures within ${this.thresholds.failureWindowMs / 60000} min (revert spike)`,
        },
      ];
    }
    return [];
  }

  ingestPause(paused: boolean, guardian?: string): MonitorAlert[] {
    return [
      paused
        ? {
            severity: "critical",
            kind: "fills-paused",
            message: `guardian ${guardian ?? "?"} paused fills`,
          }
        : { severity: "info", kind: "fills-unpaused", message: "fills unpaused" },
    ];
  }

  fillsPerMinute(nowMs = Date.now(), windowMs = 10 * 60_000): number {
    const cutoff = nowMs - windowMs;
    return this.fillTimestamps.filter((t) => t >= cutoff).length / (windowMs / 60_000);
  }

  p2pMatchRate(): number {
    const total = this.dexFills + this.p2pFills;
    return total === 0 ? 0 : this.p2pFills / total;
  }

  snapshot() {
    return {
      dexFills: this.dexFills,
      p2pFills: this.p2pFills,
      p2pMatchRate: this.p2pMatchRate(),
      totalSurplus: this.totalSurplus.toString(),
      totalMakerImprovement: this.totalMakerImprovement.toString(),
      totalKeeperReward: this.totalKeeperReward.toString(),
      keeperFailures: this.keeperFailures,
    };
  }
}

/** Alert sink: console always; webhook (Slack-compatible JSON) when set. */
export async function emitAlert(alert: MonitorAlert, webhookUrl?: string): Promise<void> {
  const line = `[${alert.severity.toUpperCase()}] ${alert.kind}: ${alert.message}`;
  if (alert.severity === "critical") console.error(line);
  else console.warn(line);
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: line, ...alert }),
      });
    } catch {
      console.error("alert webhook delivery failed");
    }
  }
}

export class SeltraMonitor {
  readonly metrics: MetricsTracker;
  private settlement: Contract;
  private lastBlock = 0;
  private timer?: NodeJS.Timeout;
  private logRequests = 0;
  private running = false;
  private overlappingTicksSkipped = 0;

  constructor(
    private readonly config: SeltraConfig,
    private readonly provider: Provider,
    thresholds: MonitorThresholds = DEFAULT_THRESHOLDS,
    private readonly webhookUrl = process.env.ALERT_WEBHOOK_URL,
  ) {
    this.metrics = new MetricsTracker(thresholds);
    this.settlement = new Contract(config.settlement, SETTLEMENT_ABI, provider);
  }

  async start(): Promise<void> {
    this.lastBlock = await this.provider.getBlockNumber();
    this.timer = setInterval(() => void this.runTick(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const head = await this.provider.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1;
    const now = Date.now();

    this.logRequests += 1;
    const events = await queryParsedContractLogs(this.provider, [{
      address: this.config.settlement,
      interface: this.settlement.interface,
      events: ["OrderFilledDEX", "OrderFilledP2P", "FillsPaused", "FillsUnpaused"],
    }], from, head);

    const alerts: MonitorAlert[] = [];
    for (const ev of events) {
      if (ev.name === "OrderFilledDEX") {
        const [orderHash, maker, keeper, adapterId, makingAmount, amountOut, makerImprovement, keeperReward] =
          ev.args;
        alerts.push(
          ...this.metrics.ingestDexFill({
            orderHash,
            maker,
            keeper,
            adapterId: Number(adapterId),
            makingAmount,
            amountOut,
            makerImprovement,
            keeperReward,
            blockNumber: ev.blockNumber,
            timestampMs: now,
          }),
        );
      } else if (ev.name === "OrderFilledP2P") {
        const [hashA, hashB, surplus, , , keeperReward] = ev.args;
        alerts.push(
          ...this.metrics.ingestP2PFill({
            hashA,
            hashB,
            surplus,
            keeperReward,
            blockNumber: ev.blockNumber,
            timestampMs: now,
          }),
        );
      } else if (ev.name === "FillsPaused") {
        alerts.push(...this.metrics.ingestPause(true, ev.args[0]));
      } else if (ev.name === "FillsUnpaused") {
        alerts.push(...this.metrics.ingestPause(false));
      }
    }

    for (const alert of alerts) await emitAlert(alert, this.webhookUrl);
    this.lastBlock = head;
  }

  private async runTick(): Promise<void> {
    if (this.running) {
      this.overlappingTicksSkipped += 1;
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } catch {
      // Retry the same range on the next non-overlapping tick.
    } finally {
      this.running = false;
    }
  }

  rpcBudgetSnapshot(): { combinedLogRequests: number; overlappingTicksSkipped: number } {
    return {
      combinedLogRequests: this.logRequests,
      overlappingTicksSkipped: this.overlappingTicksSkipped,
    };
  }
}
