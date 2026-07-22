import { AbiCoder, Contract, Wallet, type Provider } from "ethers";

import { SETTLEMENT_ABI } from "./abi.js";
import { NotionalCaps } from "./caps.js";
import { quotePolicyFor, type SeltraConfig } from "./config.js";
import type { Match } from "./matching.js";
import { orderToJson, permitToJson, type StoredOrder } from "./types.js";
import { VenueQuoteCoordinator, findPairName, type BestVenueQuoter, type DexQuote } from "./venues.js";

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
  private protocolFeeBps = 0n;
  private inFlight = new Set<string>();
  private readonly quoter: BestVenueQuoter;
  /** rollout caps (spec 2.4), tracked per quote token */
  readonly caps: NotionalCaps;

  constructor(
    private readonly config: SeltraConfig,
    private readonly provider: Provider,
    privateKey: string,
    private readonly hooks: {
      onFilled?: (orderHashes: string[], txHash: string, path: "dex" | "p2p") => void;
      onFailed?: (orderHashes: string[], reason: string) => void;
    } = {},
    quoter?: BestVenueQuoter,
  ) {
    this.wallet = new Wallet(privateKey, provider);
    this.settlement = new Contract(config.settlement, SETTLEMENT_ABI, this.wallet);
    this.quoter = quoter ?? new VenueQuoteCoordinator(config, provider);
    const tokenCaps = Object.fromEntries(
      Object.entries(config.quotePolicies ?? {}).map(([token, policy]) => [
        token,
        { perOrder: policy.keeperMaxOrderNotional, daily: policy.keeperDailyNotionalCap },
      ]),
    );
    this.caps = new NotionalCaps(config.keeperMaxOrderNotional, config.keeperDailyNotionalCap, tokenCaps);
  }

  /** DEX fill using the exact adapter + calldata tuple that produced the quote. */
  async tryFillDEX(order: StoredOrder, quote: DexQuote): Promise<void> {
    if (this.inFlight.has(order.orderHash)) return;
    if (Date.now() - quote.quotedAtMs > this.config.maxQuoteAgeMs) return;

    // Keeper economics: our share of the surplus, before gas.
    const surplus = quote.amountOut - order.order.takingAmount;
    if (surplus < 0n) return;
    const keeperShare = this.keeperReward(surplus);

    // Rollout caps are always denominated in the configured pair's quote
    // token, including reverse-direction orders that sell quote for base.
    const notional = this.quoteNotional(order);
    if (!notional || !this.caps.allows(notional.token, notional.amount)) return;

    const args = [
      orderToJson(order.order),
      permitToJson(order.permit),
      order.signature,
      { adapterId: quote.adapterId, extra: quote.extra },
    ];

    this.inFlight.add(order.orderHash);
    try {
      // Simulate first; simulated failures are never broadcast.
      await this.settlement.fillOrderDEX.staticCall(...args);
      const gasUnits = BigInt(await this.settlement.fillOrderDEX.estimateGas(...args));
      if (!(await this.isProfitableAfterGas(keeperShare, order.order.takerAsset, notional.token, gasUnits))) return;
      if (Date.now() - quote.quotedAtMs > this.config.maxQuoteAgeMs) return;
      const tx = await this.settlement.fillOrderDEX(...args);
      const receipt = await tx.wait();
      this.caps.record(notional.token, notional.amount);
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

    const keeperShare = this.keeperReward(match.surplus);

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
      const gasUnits = BigInt(await this.settlement.fillOrderP2P.estimateGas(...args));
      if (!(await this.isProfitableAfterGas(keeperShare, b.order.makerAsset, b.order.makerAsset, gasUnits))) {
        return false;
      }
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
      const settlementRead = new Contract(this.config.settlement, SETTLEMENT_ABI, this.wallet.provider);
      const [makerSurplusBps, protocolFeeBps] = await Promise.all([
        settlementRead.makerSurplusBps(),
        settlementRead.protocolFeeBps(),
      ]);
      this.makerSurplusBps = BigInt(makerSurplusBps);
      this.protocolFeeBps = BigInt(protocolFeeBps);
    } catch {
      // keep default 7000
    }
  }

  private keeperReward(surplus: bigint): bigint {
    const keeperSide = (surplus * (10_000n - this.makerSurplusBps)) / 10_000n;
    return keeperSide - (keeperSide * this.protocolFeeBps) / 10_000n;
  }

  private async isProfitableAfterGas(
    rewardAmount: bigint,
    rewardToken: string,
    quoteToken: string,
    gasUnits: bigint,
  ): Promise<boolean> {
    // Development deployments can use mock tokens without a native-token
    // conversion route. Mainnet configuration forbids a zero profit floor.
    const minProfit = quotePolicyFor(this.config, quoteToken).keeperMinProfit;
    if (minProfit === 0n) return true;
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!gasPrice || gasPrice <= 0n) return false;
    const gasNative = ceilBps(gasUnits * gasPrice, this.config.gasCostBufferBps);
    const [rewardQuote, gasQuote] = await Promise.all([
      this.convertToQuote(rewardAmount, rewardToken, quoteToken),
      this.convertToQuote(gasNative, this.config.wrappedNative, quoteToken),
    ]);
    return rewardQuote >= gasQuote + minProfit;
  }

  private async convertToQuote(amount: bigint, token: string, quoteToken: string): Promise<bigint> {
    if (token.toLowerCase() === quoteToken.toLowerCase()) return amount;
    if (findPairName(this.config.pairs, token, quoteToken)) {
      return (await this.quoter.quoteBest(token, quoteToken, amount)).amountOut;
    }
    for (const pair of Object.values(this.config.pairs)) {
      let intermediate: string | undefined;
      if (pair.base.toLowerCase() === token.toLowerCase()) intermediate = pair.quote;
      if (pair.quote.toLowerCase() === token.toLowerCase()) intermediate = pair.base;
      if (!intermediate || !findPairName(this.config.pairs, intermediate, quoteToken)) continue;
      const first = await this.quoter.quoteBest(token, intermediate, amount);
      return (await this.quoter.quoteBest(intermediate, quoteToken, first.amountOut)).amountOut;
    }
    throw new Error(`no configured gas/profit conversion path from ${token} to ${quoteToken}`);
  }

  private quoteNotional(order: StoredOrder): { token: string; amount: bigint } | undefined {
    for (const pair of Object.values(this.config.pairs)) {
      const maker = order.order.makerAsset.toLowerCase();
      const taker = order.order.takerAsset.toLowerCase();
      if (maker === pair.base.toLowerCase() && taker === pair.quote.toLowerCase()) {
        return { token: pair.quote, amount: order.order.takingAmount };
      }
      if (maker === pair.quote.toLowerCase() && taker === pair.base.toLowerCase()) {
        return { token: pair.quote, amount: order.order.makingAmount };
      }
    }
    return undefined;
  }

  /** LFJ route hints: (deadline, pairBinSteps, versions, tokenPath). */
  static encodeLfjExtra(
    deadlineSec: bigint,
    pairBinSteps: bigint[],
    versions: number[],
    tokenPath: string[],
  ): string {
    if (tokenPath.length !== 2 || pairBinSteps.length !== 1 || versions.length !== 1) {
      throw new Error("Seltra V1 supports only direct LFJ routes");
    }
    return AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256[]", "uint8[]", "address[]"],
      [deadlineSec, pairBinSteps, versions, tokenPath],
    );
  }
}

function ceilBps(amount: bigint, bufferBps: number): bigint {
  if (bufferBps === 0) return amount;
  return (amount * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
}
