import { AbiCoder, Contract, type Provider } from "ethers";

import { ROUTER_ABI } from "./abi.js";
import type { DexVenueConfig, PairConfig, SeltraConfig } from "./config.js";

const LFJ_QUOTER_ABI = [
  "function findBestPathFromAmountIn(address[] route,uint128 amountIn) view returns ((address[] route,address[] pairs,uint256[] binSteps,uint8[] versions,uint128[] amounts,uint128[] virtualAmountsWithoutSlippage,uint128[] fees) quote)",
];
const UINT128_MAX = (1n << 128n) - 1n;

export interface DexQuote {
  adapterId: number;
  venue: string;
  amountOut: bigint;
  extra: string;
  quotedAtMs: number;
}

export interface BestVenueQuoter {
  quoteBest(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<DexQuote>;
}

/**
 * Builds venue-specific route calldata, then quotes through Seltra's deployed
 * router. The quote that wins is therefore the exact adapter + extra tuple the
 * keeper later simulates and submits; a UI-only or non-executable quote can
 * never become a fill instruction.
 */
export class VenueQuoteCoordinator implements BestVenueQuoter {
  private readonly router: Contract;
  private readonly lfjQuoters = new Map<string, Contract>();

  constructor(
    private readonly config: SeltraConfig,
    private readonly provider: Provider,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.router = new Contract(config.router, ROUTER_ABI, provider);
  }

  async quoteBest(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<DexQuote> {
    if (amountIn <= 0n) throw new Error("quote amount must be positive");
    const pairName = findPairName(this.config.pairs, tokenIn, tokenOut);
    if (!pairName) throw new Error("pair is not in the configured registry");

    const settled = await Promise.allSettled(
      this.config.dexVenues.map((venue) => this.quoteVenue(venue, pairName, tokenIn, tokenOut, amountIn)),
    );
    const quotes = settled
      .filter((result): result is PromiseFulfilledResult<DexQuote> => result.status === "fulfilled")
      .map((result) => result.value);
    if (quotes.length === 0) throw new Error(`no executable venue quote for ${pairName}`);
    return quotes.reduce((best, quote) => (quote.amountOut > best.amountOut ? quote : best));
  }

  private async quoteVenue(
    venue: DexVenueConfig,
    pairName: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<DexQuote> {
    if (!(await this.router.isRegistered(venue.adapterId))) throw new Error(`${venue.name} is unavailable`);
    const now = this.nowMs();
    const deadline = BigInt(Math.floor(now / 1000) + this.config.quoteDeadlineSeconds);
    const extra = await this.buildExtra(venue, pairName, tokenIn, tokenOut, amountIn, deadline);
    const amountOut = BigInt(
      await this.router.quote.staticCall(venue.adapterId, tokenIn, tokenOut, amountIn, extra),
    );
    if (amountOut <= 0n) throw new Error(`${venue.name} returned zero output`);
    return { adapterId: venue.adapterId, venue: venue.name, amountOut, extra, quotedAtMs: now };
  }

  private async buildExtra(
    venue: DexVenueConfig,
    pairName: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    deadline: bigint,
  ): Promise<string> {
    if (venue.kind === "mock") return "0x";
    if (venue.kind === "lfj") {
      if (amountIn > UINT128_MAX) throw new Error("LFJ quote amount must fit uint128");
      let quoter = this.lfjQuoters.get(venue.quoter.toLowerCase());
      if (!quoter) {
        quoter = new Contract(venue.quoter, LFJ_QUOTER_ABI, this.provider);
        this.lfjQuoters.set(venue.quoter.toLowerCase(), quoter);
      }
      const quote = await quoter.findBestPathFromAmountIn([tokenIn, tokenOut], amountIn);
      const route = [...quote.route].map(String);
      const binSteps = [...quote.binSteps].map(BigInt);
      const versions = [...quote.versions].map(Number);
      if (
        route.length !== 2 || route[0].toLowerCase() !== tokenIn.toLowerCase()
        || route[1].toLowerCase() !== tokenOut.toLowerCase() || binSteps.length !== 1 || versions.length !== 1
      ) throw new Error("LFJ did not return a direct route");
      return AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256[]", "uint8[]", "address[]"],
        [deadline, binSteps, versions, route],
      );
    }
    if (venue.kind === "pharaoh") {
      const route = venue.routes[pairName];
      if (!route) throw new Error(`${venue.name} has no ${pairName} route`);
      return AbiCoder.defaultAbiCoder().encode(["uint256", "int24"], [deadline, route.tickSpacing]);
    }
    const route = venue.routes[pairName];
    if (!route) throw new Error(`${venue.name} has no ${pairName} route`);
    return AbiCoder.defaultAbiCoder().encode(
      [
        "uint256",
        "tuple(address pair,address from,address to,bool stable,bool concentrated,address receiver)[]",
      ],
      [
        deadline,
        [{
          pair: route.pool,
          from: tokenIn,
          to: tokenOut,
          stable: route.stable,
          concentrated: route.concentrated,
          receiver: this.config.router,
        }],
      ],
    );
  }
}

export function findPairName(
  pairs: Record<string, PairConfig>,
  tokenIn: string,
  tokenOut: string,
): string | undefined {
  const from = tokenIn.toLowerCase();
  const to = tokenOut.toLowerCase();
  return Object.entries(pairs).find(([, pair]) => {
    const base = pair.base.toLowerCase();
    const quote = pair.quote.toLowerCase();
    return (base === from && quote === to) || (base === to && quote === from);
  })?.[0];
}
