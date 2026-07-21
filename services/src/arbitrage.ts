import { AbiCoder, Contract, Interface, NonceManager, Wallet, type Provider, type TransactionReceipt } from "ethers";

const ADAPTER_ABI = [
  "function quote(address tokenIn,address tokenOut,uint256 amountIn,bytes extra) returns (uint256 amountOut)",
];

const ARB_EXECUTOR_ABI = [
  "function executeTwoLeg(address tokenIn,address tokenMid,uint256 amountIn,uint256 minProfit,uint256 deadline,(uint8 adapterId,uint256 minAmountOut,bytes extra) first,(uint8 adapterId,uint256 minAmountOut,bytes extra) second) returns (uint256 profit)",
  "event ArbitrageExecuted(address indexed operator,address indexed tokenIn,address indexed tokenMid,uint8 firstAdapterId,uint8 secondAdapterId,uint256 amountIn,uint256 amountMid,uint256 amountOut,uint256 profit)",
];

const ARB_EXECUTOR_INTERFACE = new Interface(ARB_EXECUTOR_ABI);

export interface ArbRouteQuote {
  adapterId: number;
  venue: string;
  amountOut: bigint;
  extra: string;
}

export interface ArbVenue {
  readonly adapterId: number;
  readonly name: string;
  quote(tokenIn: string, tokenOut: string, amountIn: bigint, deadline: bigint): Promise<ArbRouteQuote>;
}

export interface ArbLeg {
  adapterId: number;
  minAmountOut: bigint;
  extra: string;
  venue: string;
  quotedAmountOut: bigint;
}

export interface ArbDraft {
  tokenIn: string;
  tokenMid: string;
  amountIn: bigint;
  deadline: bigint;
  first: ArbRouteQuote;
  second: ArbRouteQuote;
}

export interface ArbitrageOpportunity {
  tokenIn: string;
  tokenMid: string;
  amountIn: bigint;
  deadline: bigint;
  first: ArbLeg;
  second: ArbLeg;
  expectedAmountOut: bigint;
  expectedGrossProfit: bigint;
  estimatedGasCost: bigint;
  minProfit: bigint;
  expectedNetProfit: bigint;
  quotedAtMs: number;
}

export interface ArbitrageExecutionRecord {
  txHash: string;
  tokenIn: string;
  tokenMid: string;
  firstVenue: string;
  secondVenue: string;
  amountIn: bigint;
  expectedProfit: bigint;
  realizedProfit: bigint;
  actualGasCostInTokenIn: bigint;
  realizedNetProfit: bigint;
  timestamp: number;
}

export interface ArbSearchConfig {
  /** Per-leg output haircut applied to quotes before accepting a candidate. */
  slippageBps: number;
  /** Minimum expected profit after the injected gas estimate. */
  minNetProfit: bigint;
  deadlineSeconds: number;
}

export type GasCostEstimator = (draft: ArbDraft) => Promise<bigint>;

/**
 * Finds atomic tokenIn -> tokenMid -> tokenIn cycles across distinct,
 * allowlisted adapters. Gas conversion is injected because the executor pays
 * gas in AVAX while profit can be denominated in any allowed start token.
 */
export class ArbitrageSearcher {
  constructor(
    private readonly venues: ArbVenue[],
    private readonly estimateGasCostInTokenIn: GasCostEstimator,
    private readonly config: ArbSearchConfig,
  ) {
    if (venues.length < 2) throw new Error("at least two arbitrage venues are required");
    if (new Set(venues.map((venue) => venue.adapterId)).size < 2) {
      throw new Error("at least two distinct adapter ids are required");
    }
    if (config.slippageBps < 0 || config.slippageBps >= 10_000) {
      throw new Error("slippageBps must be in [0, 10000)");
    }
    if (!Number.isInteger(config.deadlineSeconds) || config.deadlineSeconds <= 0) {
      throw new Error("deadlineSeconds must be a positive integer");
    }
    if (config.minNetProfit < 0n) throw new Error("minNetProfit cannot be negative");
  }

  async findBest(
    tokenIn: string,
    tokenMid: string,
    amountIn: bigint,
    nowSeconds = BigInt(Math.floor(Date.now() / 1000)),
  ): Promise<ArbitrageOpportunity | undefined> {
    if (tokenIn.toLowerCase() === tokenMid.toLowerCase()) throw new Error("arbitrage tokens must differ");
    if (amountIn <= 0n) throw new Error("amountIn must be positive");

    const deadline = nowSeconds + BigInt(this.config.deadlineSeconds);
    const firstQuotes = await Promise.all(
      this.venues.map(async (venue) => {
        try {
          const quote = await venue.quote(tokenIn, tokenMid, amountIn, deadline);
          if (quote.adapterId !== venue.adapterId) throw new Error("venue returned the wrong adapter id");
          return quote;
        } catch {
          return undefined;
        }
      }),
    );
    if (firstQuotes.every((quote) => quote === undefined)) {
      throw new Error("all first-leg arbitrage venue quotes failed");
    }

    let best: ArbitrageOpportunity | undefined;
    let secondQuoteSuccesses = 0;
    for (const first of firstQuotes) {
      if (!first || first.amountOut <= 0n) continue;
      for (const venue of this.venues) {
        if (venue.adapterId === first.adapterId) continue;

        let second: ArbRouteQuote;
        try {
          second = await venue.quote(tokenMid, tokenIn, first.amountOut, deadline);
          if (second.adapterId !== venue.adapterId) throw new Error("venue returned the wrong adapter id");
        } catch {
          continue;
        }
        if (second.amountOut > 0n) secondQuoteSuccesses++;
        if (second.amountOut <= amountIn) continue;

        const draft: ArbDraft = { tokenIn, tokenMid, amountIn, deadline, first, second };
        const estimatedGasCost = await this.estimateGasCostInTokenIn(draft);
        if (estimatedGasCost < 0n) throw new Error("gas estimator returned a negative cost");

        const minProfit = estimatedGasCost + this.config.minNetProfit;
        const conservativeFirstOut = applyBpsHaircut(first.amountOut, this.config.slippageBps);
        // Reserve the configured tolerance independently for both venue legs.
        // The on-chain min-out and profit checks remain authoritative; this
        // compounded haircut keeps obviously fragile routes from burning gas.
        const conservativeFinalOut = applyBpsHaircut(
          applyBpsHaircut(second.amountOut, this.config.slippageBps),
          this.config.slippageBps,
        );
        if (conservativeFirstOut === 0n || conservativeFinalOut < amountIn + minProfit) continue;

        const expectedGrossProfit = second.amountOut - amountIn;
        const expectedNetProfit = expectedGrossProfit - estimatedGasCost;
        const candidate: ArbitrageOpportunity = {
          tokenIn,
          tokenMid,
          amountIn,
          deadline,
          first: {
            adapterId: first.adapterId,
            venue: first.venue,
            quotedAmountOut: first.amountOut,
            minAmountOut: conservativeFirstOut,
            extra: first.extra,
          },
          second: {
            adapterId: second.adapterId,
            venue: second.venue,
            quotedAmountOut: second.amountOut,
            // The executor's round-trip assertion is authoritative. Matching
            // the second leg minimum to it fails earlier inside the adapter.
            minAmountOut: amountIn + minProfit,
            extra: second.extra,
          },
          expectedAmountOut: second.amountOut,
          expectedGrossProfit,
          estimatedGasCost,
          minProfit,
          expectedNetProfit,
          quotedAtMs: Number(nowSeconds) * 1_000,
        };

        if (!best || candidate.expectedNetProfit > best.expectedNetProfit) best = candidate;
      }
    }
    if (secondQuoteSuccesses === 0) throw new Error("all second-leg arbitrage venue quotes failed");
    return best;
  }
}

/** Adapter-backed quote source. Route construction stays venue-specific. */
export class AdapterVenue implements ArbVenue {
  private readonly adapter: Contract;

  constructor(
    readonly adapterId: number,
    readonly name: string,
    adapterAddress: string,
    provider: Provider,
    private readonly buildExtra: (
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      deadline: bigint,
    ) => string | Promise<string>,
  ) {
    if (!Number.isInteger(adapterId) || adapterId < 0 || adapterId > 255) {
      throw new Error("adapterId must fit uint8");
    }
    this.adapter = new Contract(adapterAddress, ADAPTER_ABI, provider);
  }

  async quote(tokenIn: string, tokenOut: string, amountIn: bigint, deadline: bigint): Promise<ArbRouteQuote> {
    const extra = await this.buildExtra(tokenIn, tokenOut, amountIn, deadline);
    const amountOut = BigInt(await this.adapter.quote.staticCall(tokenIn, tokenOut, amountIn, extra));
    return { adapterId: this.adapterId, venue: this.name, amountOut, extra };
  }
}

/** Simulates the exact opportunity before submitting it from the operator. */
export class ArbitrageExecutorClient {
  private readonly executor: Contract;
  private inFlight = false;

  constructor(executorAddress: string, provider: Provider, privateKey: string) {
    const signer = new NonceManager(new Wallet(privateKey, provider));
    this.executor = new Contract(executorAddress, ARB_EXECUTOR_ABI, signer);
  }

  async estimateGas(opportunity: ArbitrageOpportunity): Promise<bigint> {
    return BigInt(await this.executor.executeTwoLeg.estimateGas(...executorArgs(opportunity)));
  }

  async execute(opportunity: ArbitrageOpportunity): Promise<{ txHash: string; profit: bigint; receipt: TransactionReceipt }> {
    if (this.inFlight) throw new Error("arbitrage execution already in flight");
    this.inFlight = true;
    try {
      const args = executorArgs(opportunity);
      await this.executor.executeTwoLeg.staticCall(...args);
      const tx = await this.executor.executeTwoLeg(...args);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("arbitrage transaction was not mined");
      const profit = parseArbitrageProfit(receipt.logs);
      return { txHash: receipt.hash, profit, receipt };
    } finally {
      this.inFlight = false;
    }
  }
}

/** In-memory accounting primitive; production persistence can append these
 *  immutable records to Postgres without changing the search/execution math. */
export class ArbitragePnlLedger {
  private readonly records: ArbitrageExecutionRecord[] = [];

  record(
    opportunity: ArbitrageOpportunity,
    execution: { txHash: string; profit: bigint },
    actualGasCostInTokenIn: bigint,
    timestamp = Date.now(),
  ): ArbitrageExecutionRecord {
    if (execution.profit < 0n || actualGasCostInTokenIn < 0n) throw new Error("P&L inputs cannot be negative");
    const entry: ArbitrageExecutionRecord = {
      txHash: execution.txHash,
      tokenIn: opportunity.tokenIn,
      tokenMid: opportunity.tokenMid,
      firstVenue: opportunity.first.venue,
      secondVenue: opportunity.second.venue,
      amountIn: opportunity.amountIn,
      expectedProfit: opportunity.expectedGrossProfit,
      realizedProfit: execution.profit,
      actualGasCostInTokenIn,
      realizedNetProfit: execution.profit - actualGasCostInTokenIn,
      timestamp,
    };
    this.records.push(entry);
    return { ...entry };
  }

  list(tokenIn?: string): ArbitrageExecutionRecord[] {
    const normalized = tokenIn?.toLowerCase();
    return this.records
      .filter((entry) => !normalized || entry.tokenIn.toLowerCase() === normalized)
      .map((entry) => ({ ...entry }));
  }

  totals(tokenIn: string): { grossProfit: bigint; gasCost: bigint; netProfit: bigint; trades: number } {
    const entries = this.list(tokenIn);
    return entries.reduce(
      (totals, entry) => ({
        grossProfit: totals.grossProfit + entry.realizedProfit,
        gasCost: totals.gasCost + entry.actualGasCostInTokenIn,
        netProfit: totals.netProfit + entry.realizedNetProfit,
        trades: totals.trades + 1,
      }),
      { grossProfit: 0n, gasCost: 0n, netProfit: 0n, trades: 0 },
    );
  }
}

export function encodeLfjArbExtra(
  deadline: bigint,
  binStep: bigint,
  version: number,
  tokenIn: string,
  tokenOut: string,
): string {
  if (binStep < 0n) throw new Error("LFJ binStep cannot be negative");
  if (!Number.isInteger(version) || version < 0 || version > 3) throw new Error("invalid LFJ version");
  return AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256[]", "uint8[]", "address[]"],
    [deadline, [binStep], [version], [tokenIn, tokenOut]],
  );
}

export function encodePharaohArbExtra(deadline: bigint, tickSpacing: number): string {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 8_388_607) {
    throw new Error("tickSpacing must be a positive int24");
  }
  return AbiCoder.defaultAbiCoder().encode(["uint256", "int24"], [deadline, tickSpacing]);
}

export function applyBpsHaircut(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error("bps must be in [0, 10000)");
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** Reads realized profit from the mined executor event, never from a stale
 *  pre-submit simulation result. */
export function parseArbitrageProfit(logs: readonly { topics: readonly string[]; data: string }[]): bigint {
  for (const log of logs) {
    try {
      const parsed = ARB_EXECUTOR_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "ArbitrageExecuted") return BigInt(parsed.args.profit);
    } catch {
      // Receipts also contain ERC-20 and adapter events.
    }
  }
  throw new Error("mined arbitrage receipt is missing ArbitrageExecuted");
}

function executorArgs(opportunity: ArbitrageOpportunity) {
  return [
    opportunity.tokenIn,
    opportunity.tokenMid,
    opportunity.amountIn,
    opportunity.minProfit,
    opportunity.deadline,
    {
      adapterId: opportunity.first.adapterId,
      minAmountOut: opportunity.first.minAmountOut,
      extra: opportunity.first.extra,
    },
    {
      adapterId: opportunity.second.adapterId,
      minAmountOut: opportunity.second.minAmountOut,
      extra: opportunity.second.extra,
    },
  ] as const;
}
