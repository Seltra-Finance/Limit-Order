import { Contract, type Provider } from "ethers";

import {
  encodeLfjArbExtra,
  encodePharaohArbExtra,
  type ArbDraft,
  type ArbRouteQuote,
  type ArbVenue,
  type GasCostEstimator,
} from "./arbitrage.js";

const LFJ_QUOTER_ABI = [
  "function findBestPathFromAmountIn(address[] route,uint128 amountIn) view returns ((address[] route,address[] pairs,uint256[] binSteps,uint8[] versions,uint128[] amounts,uint128[] virtualAmountsWithoutSlippage,uint128[] fees) quote)",
];

const PHARAOH_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

const UINT128_MAX = (1n << 128n) - 1n;

/** Direct LFJ V2.2 quote source that also constructs the exact adapter extra. */
export class LfjArbitrageVenue implements ArbVenue {
  readonly adapterId = 1;
  readonly name = "LFJ";
  private readonly quoter: Contract;

  constructor(quoterAddress: string, provider: Provider) {
    this.quoter = new Contract(quoterAddress, LFJ_QUOTER_ABI, provider);
  }

  async quote(tokenIn: string, tokenOut: string, amountIn: bigint, deadline: bigint): Promise<ArbRouteQuote> {
    if (amountIn <= 0n || amountIn > UINT128_MAX) throw new Error("LFJ quote amount must fit uint128");
    const quote = await this.quoter.findBestPathFromAmountIn([tokenIn, tokenOut], amountIn);
    const route = [...quote.route].map(String);
    const binSteps = [...quote.binSteps].map(BigInt);
    const versions = [...quote.versions].map(Number);
    const amounts = [...quote.amounts].map(BigInt);
    if (
      route.length !== 2 || route[0].toLowerCase() !== tokenIn.toLowerCase()
      || route[1].toLowerCase() !== tokenOut.toLowerCase() || binSteps.length !== 1 || versions.length !== 1
      || amounts.length !== 2 || amounts[1] <= 0n
    ) throw new Error("LFJ returned an invalid direct route");

    return {
      adapterId: this.adapterId,
      venue: this.name,
      amountOut: amounts[1],
      extra: encodeLfjArbExtra(deadline, binSteps[0], versions[0], tokenIn, tokenOut),
    };
  }
}

/** Single-pool Pharaoh/Ramses V3 quote source. */
export class PharaohArbitrageVenue implements ArbVenue {
  readonly adapterId = 3;
  readonly name = "Pharaoh";
  private readonly quoter: Contract;

  constructor(quoterAddress: string, provider: Provider, private readonly tickSpacing: number) {
    this.quoter = new Contract(quoterAddress, PHARAOH_QUOTER_ABI, provider);
  }

  async quote(tokenIn: string, tokenOut: string, amountIn: bigint, deadline: bigint): Promise<ArbRouteQuote> {
    const result = await this.quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      tickSpacing: this.tickSpacing,
      sqrtPriceLimitX96: 0,
    });
    const amountOut = BigInt(result.amountOut);
    if (amountOut <= 0n) throw new Error("Pharaoh returned zero output");
    return {
      adapterId: this.adapterId,
      venue: this.name,
      amountOut,
      extra: encodePharaohArbExtra(deadline, this.tickSpacing),
    };
  }
}

export interface NativeGasOracleConfig {
  estimatedGasUnits: bigint;
  gasCostBufferBps: number;
  wrappedNative: string;
}

/**
 * Converts estimated native gas into the cycle's starting token. For WAVAX
 * this is one-to-one. Other start tokens use an injected independent quote
 * source and round the conversion upward by the configured safety buffer.
 */
export class NativeGasCostOracle {
  constructor(
    private readonly provider: Pick<Provider, "getFeeData">,
    private readonly conversionVenue: ArbVenue,
    private readonly config: NativeGasOracleConfig,
  ) {
    if (config.estimatedGasUnits <= 0n) throw new Error("estimatedGasUnits must be positive");
    if (!Number.isInteger(config.gasCostBufferBps) || config.gasCostBufferBps < 0 || config.gasCostBufferBps > 10_000) {
      throw new Error("gasCostBufferBps must be in [0, 10000]");
    }
  }

  readonly estimate: GasCostEstimator = async (draft: ArbDraft): Promise<bigint> => {
    const feeData = await this.provider.getFeeData();
    const price = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!price || price <= 0n) throw new Error("RPC returned no usable gas price");
    const nativeCost = ceilBps(this.config.estimatedGasUnits * price, this.config.gasCostBufferBps);
    if (draft.tokenIn.toLowerCase() === this.config.wrappedNative.toLowerCase()) return nativeCost;
    const converted = await this.conversionVenue.quote(
      this.config.wrappedNative,
      draft.tokenIn,
      nativeCost,
      draft.deadline,
    );
    if (converted.amountOut <= 0n) throw new Error("gas conversion quote returned zero");
    return converted.amountOut;
  };

  async convertActual(nativeCost: bigint, tokenIn: string, deadline: bigint): Promise<bigint> {
    if (nativeCost < 0n) throw new Error("native gas cost cannot be negative");
    if (nativeCost === 0n) return 0n;
    if (tokenIn.toLowerCase() === this.config.wrappedNative.toLowerCase()) return nativeCost;
    const converted = await this.conversionVenue.quote(this.config.wrappedNative, tokenIn, nativeCost, deadline);
    return converted.amountOut;
  }
}

function ceilBps(amount: bigint, bufferBps: number): bigint {
  if (bufferBps === 0) return amount;
  return (amount * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
}
