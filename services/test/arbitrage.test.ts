import { AbiCoder, Interface } from "ethers";
import { describe, expect, it } from "vitest";

import {
  ArbitrageSearcher,
  ArbitragePnlLedger,
  applyBpsHaircut,
  encodeLfjArbExtra,
  encodePharaohArbExtra,
  parseArbitrageProfit,
  type ArbRouteQuote,
  type ArbVenue,
} from "../src/arbitrage.js";

const TOKEN_A = "0x00000000000000000000000000000000000000a1";
const TOKEN_B = "0x00000000000000000000000000000000000000b2";

class FakeVenue implements ArbVenue {
  readonly calls: { tokenIn: string; tokenOut: string; amountIn: bigint; deadline: bigint }[] = [];
  private readonly rates = new Map<string, readonly [bigint, bigint]>();

  constructor(readonly adapterId: number, readonly name: string) {}

  setRate(tokenIn: string, tokenOut: string, numerator: bigint, denominator: bigint) {
    this.rates.set(`${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`, [numerator, denominator]);
    return this;
  }

  async quote(tokenIn: string, tokenOut: string, amountIn: bigint, deadline: bigint): Promise<ArbRouteQuote> {
    this.calls.push({ tokenIn, tokenOut, amountIn, deadline });
    const rate = this.rates.get(`${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`);
    if (!rate) throw new Error("unsupported pair");
    return {
      adapterId: this.adapterId,
      venue: this.name,
      amountOut: (amountIn * rate[0]) / rate[1],
      extra: `0x${this.adapterId.toString(16).padStart(2, "0")}`,
    };
  }
}

function venues() {
  const lfj = new FakeVenue(1, "LFJ")
    .setRate(TOKEN_A, TOKEN_B, 2n, 1n)
    .setRate(TOKEN_B, TOKEN_A, 48n, 100n);
  const pharaoh = new FakeVenue(3, "Pharaoh")
    .setRate(TOKEN_A, TOKEN_B, 19n, 10n)
    .setRate(TOKEN_B, TOKEN_A, 51n, 100n);
  return { lfj, pharaoh };
}

describe("ArbitrageSearcher", () => {
  it("selects the profitable cross-venue direction after gas and slippage", async () => {
    const { lfj, pharaoh } = venues();
    const searcher = new ArbitrageSearcher([lfj, pharaoh], async () => 5n, {
      slippageBps: 25,
      minNetProfit: 5n,
      deadlineSeconds: 30,
    });

    const opportunity = await searcher.findBest(TOKEN_A, TOKEN_B, 1_000n, 100n);

    expect(opportunity).toMatchObject({
      amountIn: 1_000n,
      deadline: 130n,
      expectedAmountOut: 1_020n,
      expectedGrossProfit: 20n,
      estimatedGasCost: 5n,
      expectedNetProfit: 15n,
      minProfit: 10n,
    });
    expect(opportunity?.first).toMatchObject({
      adapterId: 1,
      venue: "LFJ",
      quotedAmountOut: 2_000n,
      minAmountOut: 1_995n,
    });
    expect(opportunity?.second).toMatchObject({
      adapterId: 3,
      venue: "Pharaoh",
      quotedAmountOut: 1_020n,
      minAmountOut: 1_010n,
    });
  });

  it("rejects a quote that is not profitable after the conservative bounds", async () => {
    const { lfj, pharaoh } = venues();
    const searcher = new ArbitrageSearcher([lfj, pharaoh], async () => 20n, {
      slippageBps: 50,
      minNetProfit: 5n,
      deadlineSeconds: 30,
    });

    expect(await searcher.findBest(TOKEN_A, TOKEN_B, 1_000n, 100n)).toBeUndefined();
  });

  it("skips unavailable routes rather than failing the whole scan", async () => {
    const profitable = new FakeVenue(1, "A").setRate(TOKEN_A, TOKEN_B, 2n, 1n);
    const returnVenue = new FakeVenue(2, "B").setRate(TOKEN_B, TOKEN_A, 51n, 100n);
    const searcher = new ArbitrageSearcher([profitable, returnVenue], async () => 0n, {
      slippageBps: 0,
      minNetProfit: 1n,
      deadlineSeconds: 10,
    });

    const opportunity = await searcher.findBest(TOKEN_A, TOKEN_B, 100n, 1n);
    expect(opportunity?.expectedGrossProfit).toBe(2n);
    expect(opportunity?.first.venue).toBe("A");
    expect(opportunity?.second.venue).toBe("B");
  });

  it("surfaces total quote-provider failure", async () => {
    const first = new FakeVenue(1, "A");
    const second = new FakeVenue(2, "B");
    const searcher = new ArbitrageSearcher([first, second], async () => 0n, {
      slippageBps: 0,
      minNetProfit: 1n,
      deadlineSeconds: 10,
    });
    await expect(searcher.findBest(TOKEN_A, TOKEN_B, 100n, 1n)).rejects.toThrow("all first-leg");
  });

  it("validates construction and search inputs", async () => {
    const { lfj, pharaoh } = venues();
    expect(() => new ArbitrageSearcher([lfj], async () => 0n, { slippageBps: 0, minNetProfit: 0n, deadlineSeconds: 1 }))
      .toThrow("at least two");
    expect(() => new ArbitrageSearcher([lfj, new FakeVenue(1, "same adapter")], async () => 0n, {
      slippageBps: 0,
      minNetProfit: 0n,
      deadlineSeconds: 1,
    })).toThrow("distinct adapter");
    expect(() => new ArbitrageSearcher([lfj, pharaoh], async () => 0n, { slippageBps: 10_000, minNetProfit: 0n, deadlineSeconds: 1 }))
      .toThrow("slippageBps");

    const searcher = new ArbitrageSearcher([lfj, pharaoh], async () => 0n, {
      slippageBps: 0,
      minNetProfit: 0n,
      deadlineSeconds: 1,
    });
    await expect(searcher.findBest(TOKEN_A, TOKEN_A, 1n)).rejects.toThrow("must differ");
    await expect(searcher.findBest(TOKEN_A, TOKEN_B, 0n)).rejects.toThrow("positive");
  });
});

describe("arbitrage route encoding", () => {
  it("encodes a direct LFJ leg", () => {
    const encoded = encodeLfjArbExtra(123n, 20n, 2, TOKEN_A, TOKEN_B);
    const decoded = AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256[]", "uint8[]", "address[]"],
      encoded,
    );
    expect(decoded[0]).toBe(123n);
    expect(decoded[1][0]).toBe(20n);
    expect(decoded[2][0]).toBe(2n);
    expect(decoded[3].map((x: string) => x.toLowerCase())).toEqual([TOKEN_A, TOKEN_B]);
  });

  it("encodes Pharaoh deadline and tick spacing", () => {
    const encoded = encodePharaohArbExtra(456n, 10);
    const decoded = AbiCoder.defaultAbiCoder().decode(["uint256", "int24"], encoded);
    expect(decoded[0]).toBe(456n);
    expect(decoded[1]).toBe(10n);
  });

  it("applies floor-rounded slippage haircuts", () => {
    expect(applyBpsHaircut(1_001n, 50)).toBe(995n);
  });

  it("reads realized profit from the mined executor event", () => {
    const iface = new Interface([
      "event ArbitrageExecuted(address indexed operator,address indexed tokenIn,address indexed tokenMid,uint8 firstAdapterId,uint8 secondAdapterId,uint256 amountIn,uint256 amountMid,uint256 amountOut,uint256 profit)",
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent("ArbitrageExecuted")!, [
      TOKEN_A,
      TOKEN_A,
      TOKEN_B,
      1,
      3,
      1_000n,
      2_000n,
      1_021n,
      21n,
    ]);
    expect(parseArbitrageProfit([{ topics: encoded.topics, data: encoded.data }])).toBe(21n);
    expect(() => parseArbitrageProfit([])).toThrow("missing ArbitrageExecuted");
  });
});

describe("ArbitragePnlLedger", () => {
  it("records realized profit net of converted gas cost", async () => {
    const { lfj, pharaoh } = venues();
    const opportunity = await new ArbitrageSearcher([lfj, pharaoh], async () => 5n, {
      slippageBps: 0,
      minNetProfit: 5n,
      deadlineSeconds: 30,
    }).findBest(TOKEN_A, TOKEN_B, 1_000n, 100n);
    if (!opportunity) throw new Error("expected opportunity");

    const ledger = new ArbitragePnlLedger();
    const record = ledger.record(opportunity, { txHash: "0xabc", profit: 18n }, 6n, 123);
    expect(record.realizedNetProfit).toBe(12n);
    expect(ledger.totals(TOKEN_A)).toEqual({ grossProfit: 18n, gasCost: 6n, netProfit: 12n, trades: 1 });

    const copy = ledger.list();
    copy[0].realizedProfit = 999n;
    expect(ledger.totals(TOKEN_A).grossProfit).toBe(18n);
  });
});
