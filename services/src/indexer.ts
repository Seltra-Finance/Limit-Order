import { Contract, type Provider } from "ethers";

import { PERMIT2_ABI, SETTLEMENT_ABI } from "./abi.js";
import type { SeltraConfig } from "./config.js";
import type { Store } from "./store.js";
import { nonceToInvalidation } from "./permit2.js";
import { queryParsedContractLogs } from "./logs.js";

/**
 * Durable finalized-block reconciler. Each completed range advances a
 * database checkpoint; event-backed fills are idempotent, so a process crash
 * can safely replay the current range instead of skipping chain history.
 */
export class Indexer {
  private readonly settlement: Contract;
  private readonly permit2: Contract;
  private lastBlock = 0;
  private timer?: NodeJS.Timeout;
  private readonly checkpointKey: string;
  private logRequests = 0;
  private running = false;
  private overlappingTicksSkipped = 0;

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
    this.checkpointKey = `settlement:${config.chainId}:${config.settlement.toLowerCase()}`;
  }

  async start(): Promise<void> {
    const saved = await this.store.getIndexerCheckpoint(this.checkpointKey);
    if (saved !== undefined) {
      this.lastBlock = saved;
    } else if (this.config.indexerStartBlock > 0) {
      this.lastBlock = this.config.indexerStartBlock - 1;
    } else {
      this.lastBlock = Math.max(0, (await this.provider.getBlockNumber()) - this.config.indexerConfirmations);
      await this.store.setIndexerCheckpoint(this.checkpointKey, this.lastBlock);
    }
    await this.tick();
    this.timer = setInterval(
      () => void this.runTick(),
      this.config.pollIntervalMs,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const head = Math.max(0, (await this.provider.getBlockNumber()) - this.config.indexerConfirmations);
    while (this.lastBlock < head) {
      const from = this.lastBlock + 1;
      const to = Math.min(head, from + this.config.indexerBatchSize - 1);
      await this.processRange(from, to);
      this.lastBlock = to;
      await this.store.setIndexerCheckpoint(this.checkpointKey, to);
    }
  }

  private async runTick(): Promise<void> {
    if (this.running) {
      this.overlappingTicksSkipped += 1;
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } catch (error) {
      console.error("indexer tick failed", error);
    } finally {
      this.running = false;
    }
  }

  private async processRange(from: number, to: number): Promise<void> {
    this.logRequests += 1;
    const events = await queryParsedContractLogs(this.provider, [
      {
        address: this.config.settlement,
        interface: this.settlement.interface,
        events: ["OrderFilledDEX", "OrderFilledP2P", "EpochIncremented", "FillsPaused", "FillsUnpaused"],
      },
      {
        address: this.config.permit2,
        interface: this.permit2.interface,
        events: ["UnorderedNonceInvalidation"],
      },
    ], from, to);

    for (const ev of events) {
      if (ev.name === "OrderFilledDEX") {
        const [orderHash, , keeper, adapterId, , amountOut, makerImprovement, keeperReward] = ev.args;
        await this.store.setStatus(orderHash, "filled");
        const inserted = await this.store.insertFill({
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
        if (inserted) this.hooks.onFill?.(orderHash, "dex");
      } else if (ev.name === "OrderFilledP2P") {
        const [hashA, hashB, surplus, shareA, shareB, keeperReward] = ev.args;
        for (const [orderHash, improvement] of [[hashA, shareA], [hashB, shareB]] as const) {
          await this.store.setStatus(orderHash, "filled");
          const inserted = await this.store.insertFill({
            orderHash,
            path: "p2p",
            keeper: "",
            txHash: ev.transactionHash,
            amountOut: surplus,
            makerImprovement: improvement,
            keeperReward,
            blockNumber: ev.blockNumber,
          });
          if (inserted) this.hooks.onFill?.(orderHash, "p2p");
        }
      } else if (ev.name === "EpochIncremented") {
        const [maker, newEpoch] = ev.args;
        await this.store.setEpoch(maker, newEpoch);
        const orders = await this.store.listOrders({ maker, status: "resting" });
        for (const order of orders) {
          if (order.order.epoch < newEpoch) {
            await this.store.setStatus(order.orderHash, "cancelled");
            this.hooks.onCancel?.(order.orderHash);
          }
        }
      } else if (ev.name === "UnorderedNonceInvalidation") {
        const [owner, word, mask] = ev.args;
        const orders = await this.store.listOrders({ maker: owner, status: "resting" });
        for (const order of orders) {
          const invalidation = nonceToInvalidation(order.permit.nonce);
          if (invalidation.wordPos === word && (invalidation.mask & mask) !== 0n) {
            await this.store.setStatus(order.orderHash, "cancelled");
            this.hooks.onCancel?.(order.orderHash);
          }
        }
      } else if (ev.name === "FillsPaused" || ev.name === "FillsUnpaused") {
        this.hooks.onPause?.(ev.name === "FillsPaused");
      }
    }
  }

  rpcBudgetSnapshot(): { combinedLogRequests: number; overlappingTicksSkipped: number } {
    return {
      combinedLogRequests: this.logRequests,
      overlappingTicksSkipped: this.overlappingTicksSkipped,
    };
  }
}
