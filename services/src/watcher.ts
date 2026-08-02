import type { Provider } from "ethers";

import type { SeltraConfig } from "./config.js";
import type { Store } from "./store.js";
import type { StoredOrder } from "./types.js";
import { VenueQuoteCoordinator, type BestVenueQuoter, type DexQuote } from "./venues.js";

/**
 * Price watcher (revised spec 1.9): polls executable prices directly from the
 * integrated venues (through the aggregation router's quote, which reads pool
 * state) rather than oracles, because fills must succeed against actual pool
 * state at execution time. Emits per-order fillability: an order is fillable
 * when quoting its full makingAmount returns at least takingAmount.
 */
export class PriceWatcher {
  private readonly quoter: BestVenueQuoter;
  private timer?: NodeJS.Timeout;
  private running = false;
  private groupCursor = 0;
  private readonly stats = {
    ticks: 0,
    overlappingTicksSkipped: 0,
    groupsSeen: 0,
    groupsQuoted: 0,
    groupsDeferred: 0,
  };

  constructor(
    private readonly config: SeltraConfig,
    provider: Provider,
    private readonly store: Store,
    private readonly onFillable: (order: StoredOrder, quote: DexQuote) => void,
    quoter?: BestVenueQuoter,
  ) {
    this.quoter = quoter ?? new VenueQuoteCoordinator(config, provider);
  }

  start(): void {
    void this.runTick();
    this.timer = setInterval(() => void this.runTick(), this.config.watcherPollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    this.stats.ticks += 1;
    const resting = await this.store.listOrders({ status: "resting" });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const groups = new Map<string, StoredOrder[]>();

    for (const order of resting) {
      if (order.order.expiry <= now) {
        await this.store.setStatus(order.orderHash, "expired");
        continue;
      }
      const key = quoteGroupKey(order);
      const members = groups.get(key) ?? [];
      members.push(order);
      groups.set(key, members);
    }

    const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (orderedGroups.length === 0) {
      this.groupCursor = 0;
      return;
    }

    // A Grid normally collapses into one or two exact-size groups per side.
    // The hard cap prevents arbitrary order cardinality from turning into an
    // unbounded RPC bill. Rotation gives every distinct group a fair turn.
    const limit = Math.min(this.config.watcherMaxQuoteGroupsPerTick, orderedGroups.length);
    this.stats.groupsSeen += orderedGroups.length;
    this.stats.groupsQuoted += limit;
    this.stats.groupsDeferred += orderedGroups.length - limit;
    const start = this.groupCursor % orderedGroups.length;
    const selected = Array.from(
      { length: limit },
      (_, offset) => orderedGroups[(start + offset) % orderedGroups.length]!,
    );
    this.groupCursor = (start + limit) % orderedGroups.length;

    await Promise.all(selected.map(async ([, members]) => {
      const sample = members[0]!;
      try {
        const quote = await this.quoter.quoteBest(
          sample.order.makerAsset,
          sample.order.takerAsset,
          sample.order.makingAmount,
        );
        for (const order of members) {
          if (quote.amountOut >= order.order.takingAmount) this.onFillable(order, quote);
        }
      } catch {
        // No enabled route/liquidity; retry when this group rotates back in.
      }
    }));
  }

  private async runTick(): Promise<void> {
    if (this.running) {
      this.stats.overlappingTicksSkipped += 1;
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } catch {
      // A later bounded tick retries transient store/RPC failures.
    } finally {
      this.running = false;
    }
  }

  rpcBudgetSnapshot(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Evaluate one newly accepted order immediately instead of waiting for the
   * next polling tick. The recurring tick remains the retry path for orders
   * that become executable later.
   */
  async checkOrder(order: StoredOrder): Promise<void> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (order.order.expiry <= now) {
      await this.store.setStatus(order.orderHash, "expired");
      return;
    }
    try {
      const quote = await this.quoter.quoteBest(
        order.order.makerAsset,
        order.order.takerAsset,
        order.order.makingAmount,
      );
      if (quote.amountOut >= order.order.takingAmount) this.onFillable(order, quote);
    } catch {
      // No enabled route/liquidity for this pair; the order can still settle
      // P2P or be retried by a later polling tick.
    }
  }
}

function quoteGroupKey(order: StoredOrder): string {
  return [
    order.order.makerAsset.toLowerCase(),
    order.order.takerAsset.toLowerCase(),
    order.order.makingAmount.toString(),
  ].join(":");
}
