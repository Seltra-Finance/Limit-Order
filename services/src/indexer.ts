import { Contract, type Provider } from "ethers";

import { PERMIT2_ABI, SETTLEMENT_ABI } from "./abi.js";
import type { SeltraConfig } from "./config.js";
import type { Store } from "./store.js";
import { nonceToInvalidation } from "./permit2.js";

/**
 * Chain indexer (revised spec 1.7): reconciles order status with on-chain
 * state each block from OrderFilledDEX / OrderFilledP2P / EpochIncremented /
 * FillsPaused/Unpaused, plus Permit2 UnorderedNonceInvalidation filtered to
 * Seltra-relevant nonces. This is the local reconciler; a Goldsky subgraph
 * over the same events feeds dashboards in production.
 */
export class Indexer {
  private settlement: Contract;
  private permit2: Contract;
  private lastBlock = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: SeltraConfig,
    private readonly provider: Provider,
    private readonly store: Store,
    private readonly hooks: {
      onFill?: (orderHash: string, path: "dex" | "p2p") => void;
      onCancel?: (orderHash: string) => void;
      onPause?: (paused: boolean) => void;
    } = {},
  ) {
    this.settlement = new Contract(config.settlement, SETTLEMENT_ABI, provider);
    this.permit2 = new Contract(config.permit2, PERMIT2_ABI, provider);
  }

  async start(): Promise<void> {
    this.lastBlock = await this.provider.getBlockNumber();
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const head = await this.provider.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1;
    this.lastBlock = head;

    const [dexFills, p2pFills, epochs, invalidations] = await Promise.all([
      this.settlement.queryFilter(this.settlement.filters.OrderFilledDEX(), from, head),
      this.settlement.queryFilter(this.settlement.filters.OrderFilledP2P(), from, head),
      this.settlement.queryFilter(this.settlement.filters.EpochIncremented(), from, head),
      this.permit2.queryFilter(this.permit2.filters.UnorderedNonceInvalidation(), from, head),
    ]);

    for (const ev of dexFills) {
      const [orderHash, , keeper, adapterId, , amountOut, makerImprovement, keeperReward] = (ev as any).args;
      await this.store.setStatus(orderHash, "filled");
      await this.store.insertFill({
        orderHash,
        path: "dex",
        adapterId: Number(adapterId),
        keeper,
        txHash: ev.transactionHash,
        amountOut,
        makerImprovement,
        keeperReward,
        blockNumber: ev.blockNumber,
      });
      this.hooks.onFill?.(orderHash, "dex");
    }

    for (const ev of p2pFills) {
      const [hashA, hashB, surplus, shareA, shareB, keeperReward] = (ev as any).args;
      for (const [orderHash, improvement] of [
        [hashA, shareA],
        [hashB, shareB],
      ] as const) {
        await this.store.setStatus(orderHash, "filled");
        await this.store.insertFill({
          orderHash,
          path: "p2p",
          keeper: "",
          txHash: ev.transactionHash,
          amountOut: surplus,
          makerImprovement: improvement,
          keeperReward,
          blockNumber: ev.blockNumber,
        });
        this.hooks.onFill?.(orderHash, "p2p");
      }
    }

    for (const ev of epochs) {
      const [maker, newEpoch] = (ev as any).args;
      await this.store.setEpoch(maker, newEpoch);
      // Every resting order of that maker signed under an older epoch is dead.
      const orders = await this.store.listOrders({ maker, status: "resting" });
      for (const o of orders) {
        if (o.order.epoch < newEpoch) {
          await this.store.setStatus(o.orderHash, "cancelled");
          this.hooks.onCancel?.(o.orderHash);
        }
      }
    }

    // Permit2 nonce invalidations, filtered to nonces our book knows about.
    for (const ev of invalidations) {
      const [owner, word, mask] = (ev as any).args;
      const orders = await this.store.listOrders({ maker: owner, status: "resting" });
      for (const o of orders) {
        const inv = nonceToInvalidation(o.permit.nonce);
        if (inv.wordPos === word && (inv.mask & mask) !== 0n) {
          await this.store.setStatus(o.orderHash, "cancelled");
          this.hooks.onCancel?.(o.orderHash);
        }
      }
    }
  }
}
