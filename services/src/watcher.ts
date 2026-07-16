import { Contract, type Provider } from "ethers";

import { ROUTER_ABI } from "./abi.js";
import type { SeltraConfig } from "./config.js";
import type { Store } from "./store.js";
import type { StoredOrder } from "./types.js";

/**
 * Price watcher (revised spec 1.9): polls executable prices directly from the
 * integrated venues (through the aggregation router's quote, which reads pool
 * state) rather than oracles, because fills must succeed against actual pool
 * state at execution time. Emits per-order fillability: an order is fillable
 * when quoting its full makingAmount returns at least takingAmount.
 */
export class PriceWatcher {
  private router: Contract;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: SeltraConfig,
    provider: Provider,
    private readonly store: Store,
    private readonly onFillable: (order: StoredOrder, quotedOut: bigint) => void,
  ) {
    this.router = new Contract(config.router, ROUTER_ABI, provider);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const resting = await this.store.listOrders({ status: "resting" });
    const now = BigInt(Math.floor(Date.now() / 1000));
    let adapterEnabled = false;
    try {
      adapterEnabled = Boolean(await this.router.isRegistered(this.config.dexAdapterId));
    } catch {
      // Treat an unreadable registry as unavailable; never advertise a route
      // whose circuit-breaker state cannot be established.
    }
    for (const o of resting) {
      if (o.order.expiry <= now) {
        await this.store.setStatus(o.orderHash, "expired");
        continue;
      }
      if (!adapterEnabled) continue;
      try {
        const quoted: bigint = await this.router.quote.staticCall(
          this.config.dexAdapterId,
          o.order.makerAsset,
          o.order.takerAsset,
          o.order.makingAmount,
          "0x",
        );
        if (quoted >= o.order.takingAmount) this.onFillable(o, quoted);
      } catch {
        // no route/liquidity for this pair on the configured adapter; the
        // order can still settle P2P.
      }
    }
  }
}
