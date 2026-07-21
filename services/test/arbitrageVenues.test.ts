import { describe, expect, it } from "vitest";

import { WAVAX } from "../src/arbConfig.js";
import { NativeGasCostOracle } from "../src/arbitrageVenues.js";
import type { ArbDraft, ArbRouteQuote, ArbVenue } from "../src/arbitrage.js";

const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";

class ConversionVenue implements ArbVenue {
  readonly adapterId = 1;
  readonly name = "conversion";
  calls = 0;

  async quote(_tokenIn: string, _tokenOut: string, amountIn: bigint): Promise<ArbRouteQuote> {
    this.calls++;
    return { adapterId: 1, venue: this.name, amountOut: amountIn * 20n, extra: "0x" };
  }
}

function draft(tokenIn: string): ArbDraft {
  const quote = { adapterId: 1, venue: "x", amountOut: 1n, extra: "0x" };
  return { tokenIn, tokenMid: USDC, amountIn: 1n, deadline: 100n, first: quote, second: quote };
}

describe("NativeGasCostOracle", () => {
  it("uses a buffered one-to-one native cost for WAVAX cycles", async () => {
    const venue = new ConversionVenue();
    const oracle = new NativeGasCostOracle(
      { getFeeData: async () => ({ maxFeePerGas: 2n, gasPrice: 1n }) } as never,
      venue,
      { estimatedGasUnits: 100n, gasCostBufferBps: 2_000, wrappedNative: WAVAX },
    );
    expect(await oracle.estimate(draft(WAVAX))).toBe(240n);
    expect(venue.calls).toBe(0);
  });

  it("quotes native gas into a non-native starting token", async () => {
    const venue = new ConversionVenue();
    const oracle = new NativeGasCostOracle(
      { getFeeData: async () => ({ maxFeePerGas: null, gasPrice: 2n }) } as never,
      venue,
      { estimatedGasUnits: 100n, gasCostBufferBps: 0, wrappedNative: WAVAX },
    );
    expect(await oracle.estimate(draft(USDC))).toBe(4_000n);
    expect(await oracle.convertActual(3n, USDC, 100n)).toBe(60n);
    expect(venue.calls).toBe(2);
  });
});
