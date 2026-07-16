import { AbiCoder, Contract, Wallet, type Provider } from "ethers";

import { SETTLEMENT_ABI } from "./abi.js";
import { NotionalCaps } from "./caps.js";
import type { SeltraConfig } from "./config.js";
import type { Match } from "./matching.js";
import { orderToJson, permitToJson, type StoredOrder } from "./types.js";

/**
 * Keeper bot (revised spec 1.9): consumes fillable orders (price watcher for
 * the DEX path, matching engine for the P2P path), simulates with eth_call at
 * latest state, and submits only when the keeper share of expected surplus
 * clears gas plus margin. Nonce-race reverts are swallowed gracefully; the
 * first fill wins inside Permit2 and losers revert cleanly.
 */
export class Keeper {
  private settlement: Contract;
  private wallet: Wallet;
  private makerSurplusBps = 7000n;
  private inFlight = new Set<string>();
  /** rollout caps (spec 2.4), tracked per quote token */
  readonly caps: NotionalCaps;

  constructor(
    private readonly config: SeltraConfig,
    provider: Provider,
    privateKey: string,
    private readonly hooks: {
      onFilled?: (orderHashes: string[], txHash: string, path: "dex" | "p2p") => void;
      onFailed?: (orderHashes: string[], reason: string) => void;
    } = {},
  ) {
    this.wallet = new Wallet(privateKey, provider);
    this.settlement = new Contract(config.settlement, SETTLEMENT_ABI, this.wallet);
    this.caps = new NotionalCaps(config.keeperMaxOrderNotional, config.keeperDailyNotionalCap);
  }

  /** DEX fill; `extra` carries venue routing hints (empty for the mock
   *  adapter; (deadline, binSteps, versions, tokenPath) for LFJ). */
  async tryFillDEX(order: StoredOrder, quotedOut: bigint, extra = "0x"): Promise<void> {
    if (this.inFlight.has(order.orderHash)) return;

    // Keeper economics: our share of the surplus, before gas.
    const surplus = quotedOut - order.order.takingAmount;
    const keeperShare = (surplus * (10000n - this.makerSurplusBps)) / 10000n;
    if (keeperShare < this.config.keeperMinProfit) return;

    // Rollout caps on the quote-side notional (spec 2.4).
    if (!this.caps.allows(order.order.takerAsset, order.order.takingAmount)) return;

    const args = [
      orderToJson(order.order),
      permitToJson(order.permit),
      order.signature,
      { adapterId: this.config.dexAdapterId, extra },
    ];

    this.inFlight.add(order.orderHash);
    try {
      // Simulate first; simulated failures are never broadcast.
      await this.settlement.fillOrderDEX.staticCall(...args);
      const tx = await this.settlement.fillOrderDEX(...args);
      const receipt = await tx.wait();
      this.caps.record(order.order.takerAsset, order.order.takingAmount);
      this.hooks.onFilled?.([order.orderHash], receipt.hash, "dex");
    } catch (err) {
      this.hooks.onFailed?.([order.orderHash], (err as Error).message);
    } finally {
      this.inFlight.delete(order.orderHash);
    }
  }

  /** P2P fill of a matched pair (a = base seller, b = quote seller). */
  async tryFillP2P(match: Match): Promise<boolean> {
    const { a, b } = match;
    const key = a.orderHash + b.orderHash;
    if (this.inFlight.has(key)) return false;

    const keeperShare = (match.surplus * (10000n - this.makerSurplusBps)) / 10000n;
    if (keeperShare < this.config.keeperMinProfit) return false;

    // Rollout caps: the P2P quote-side notional is B's full makingAmount.
    if (!this.caps.allows(b.order.makerAsset, b.order.makingAmount)) return false;

    const args = [
      orderToJson(a.order),
      permitToJson(a.permit),
      a.signature,
      orderToJson(b.order),
      permitToJson(b.permit),
      b.signature,
    ];

    this.inFlight.add(key);
    try {
      await this.settlement.fillOrderP2P.staticCall(...args);
      const tx = await this.settlement.fillOrderP2P(...args);
      const receipt = await tx.wait();
      this.caps.record(b.order.makerAsset, b.order.makingAmount);
      this.hooks.onFilled?.([a.orderHash, b.orderHash], receipt.hash, "p2p");
      return true;
    } catch (err) {
      this.hooks.onFailed?.([a.orderHash, b.orderHash], (err as Error).message);
      return false;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Read the live surplus split so profit estimates match the contract. */
  async sync(): Promise<void> {
    try {
      const settlementRead = new Contract(
        this.config.settlement,
        ["function makerSurplusBps() view returns (uint16)"],
        this.wallet.provider,
      );
      this.makerSurplusBps = BigInt(await settlementRead.makerSurplusBps());
    } catch {
      // keep default 7000
    }
  }

  /** LFJ route hints: (deadline, pairBinSteps, versions, tokenPath). */
  static encodeLfjExtra(
    deadlineSec: bigint,
    pairBinSteps: bigint[],
    versions: number[],
    tokenPath: string[],
  ): string {
    return AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256[]", "uint8[]", "address[]"],
      [deadlineSec, pairBinSteps, versions, tokenPath],
    );
  }
}
