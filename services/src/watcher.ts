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
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const resting = await this.store.listOrders({ status: "resting" });
    for (const o of resting) {
      await this.checkOrder(o);
    }
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
