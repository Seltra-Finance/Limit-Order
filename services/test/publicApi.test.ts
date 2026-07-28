import { describe, expect, it } from "vitest";

import {
  protocolStats,
  type PublicOrderRecord,
  type PublicPair,
} from "../src/publicApi.js";

function pair(id: string, quoteSymbol: string, quoteDecimals: number): PublicPair {
  const [baseSymbol] = id.split("-");
  return {
    configName: id.replace("-", "/"),
    id,
    baseAsset: "0x0000000000000000000000000000000000000001",
    quoteAsset: "0x0000000000000000000000000000000000000002",
    baseSymbol,
    quoteSymbol,
    baseDecimals: 18,
    quoteDecimals,
    pricePrecision: 4,
    amountPrecision: 4,
    referenceBaseAmount: "1",
  };
}

function record(
  orderHash: string,
  pairId: string,
  side: "buy" | "sell",
  makingAmount: string,
  takingAmount: string,
  options: {
    status?: PublicOrderRecord["status"];
    path?: "dex" | "p2p";
    txHash?: string;
  } = {},
): PublicOrderRecord {
  const status = options.status ?? "filled";
  return {
    orderHash,
    chainId: 43_114,
    pair: pairId,
    side,
    price: "1",
    baseAmount: "1",
    status,
    softCancelled: false,
    createdAt: 1,
    updatedAt: 2,
    order: { makingAmount, takingAmount },
    permit: {},
    signature: "0x",
    fill: status === "filled"
      ? {
          path: options.path ?? "dex",
          txHash: options.txHash ?? orderHash,
          blockNumber: 1,
          timestamp: 1,
          makerImprovement: "0",
          keeperReward: "0",
          amountOut: takingAmount,
        }
      : undefined,
  };
}

describe("protocolStats", () => {
  it("scopes every metric and never sums different quote tokens", () => {
    const usdcPair = pair("WAVAX-USDC", "USDC", 6);
    const wavaxPair = pair("WETH.e-WAVAX", "WAVAX", 18);
    const p2pTx = `0x${"99".repeat(32)}`;
    const records = [
      record(`0x${"11".repeat(32)}`, usdcPair.id, "sell", "100", "10000000"),
      record(`0x${"22".repeat(32)}`, usdcPair.id, "sell", "100", "20000000", {
        path: "p2p",
        txHash: p2pTx,
      }),
      record(`0x${"33".repeat(32)}`, usdcPair.id, "buy", "20000000", "100", {
        path: "p2p",
        txHash: p2pTx,
      }),
      record(
        `0x${"44".repeat(32)}`,
        wavaxPair.id,
        "sell",
        "100",
        "2000000000000000000",
      ),
      record(`0x${"55".repeat(32)}`, wavaxPair.id, "sell", "100", "1", {
        status: "resting",
      }),
    ];

    expect(protocolStats(records, [usdcPair, wavaxPair])).toMatchObject({
      totalVolumeQuote: null,
      quoteSymbol: null,
      volumeByQuote: [
        { quoteSymbol: "USDC", amount: "30.0" },
        { quoteSymbol: "WAVAX", amount: "2.0" },
      ],
      ordersFilled: 4,
      ordersResting: 1,
    });

    expect(protocolStats(records, [usdcPair, wavaxPair], usdcPair)).toMatchObject({
      totalVolumeQuote: "30.0",
      quoteSymbol: "USDC",
      volumeByQuote: [],
      ordersFilled: 3,
      ordersResting: 0,
      p2pMatchRateBps: 6_667,
    });

    expect(protocolStats(records, [usdcPair, wavaxPair], wavaxPair)).toMatchObject({
      totalVolumeQuote: "2.0",
      quoteSymbol: "WAVAX",
      volumeByQuote: [],
      ordersFilled: 1,
      ordersResting: 1,
    });
  });
});
