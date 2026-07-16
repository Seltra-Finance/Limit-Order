import { describe, expect, it } from "vitest";

import { buildMarketOrder, randomNonce } from "../src/market.js";

const MAKER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const WAVAX = "0xd00ae08403B9bbb9124bB305C09058E32C39A48c";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";

const base = {
  maker: MAKER,
  makerAsset: WAVAX,
  takerAsset: USDC,
  makingAmount: 10n * 10n ** 18n,
  quotedOut: 410n * 10n ** 6n,
  nowMs: Date.UTC(2026, 6, 10),
};

describe("buildMarketOrder (marketable limit order)", () => {
  it("sets the limit to quote minus slippage, permit consistent with order", () => {
    const { order, permit } = buildMarketOrder({ ...base, slippageBps: 50 });
    expect(order.takingAmount).toBe((410n * 10n ** 6n * 9950n) / 10000n); // 407.95
    expect(order.receiver).toBe(MAKER);
    expect(order.flags).toBe(0);
    // Settlement's permit/order consistency checks will pass:
    expect(permit.permitted.token).toBe(order.makerAsset);
    expect(permit.permitted.amount).toBe(order.makingAmount);
    expect(permit.deadline).toBe(order.expiry);
  });

  it("short expiry gives fill-or-kill semantics", () => {
    const { order } = buildMarketOrder({ ...base, ttlSeconds: 30 });
    expect(order.expiry).toBe(BigInt(Math.floor(base.nowMs / 1000) + 30));
    const dflt = buildMarketOrder(base);
    expect(dflt.order.expiry).toBe(BigInt(Math.floor(base.nowMs / 1000) + 60));
  });

  it("zero slippage pins the quote exactly; bad params reject", () => {
    const { order } = buildMarketOrder({ ...base, slippageBps: 0 });
    expect(order.takingAmount).toBe(base.quotedOut);

    expect(() => buildMarketOrder({ ...base, slippageBps: 10000 })).toThrow();
    expect(() => buildMarketOrder({ ...base, quotedOut: 0n })).toThrow();
    expect(() => buildMarketOrder({ ...base, quotedOut: 1n, slippageBps: 9999 })).toThrow(/zero output/);
  });

  it("carries the maker's epoch", () => {
    const { order } = buildMarketOrder({ ...base, epoch: 3n });
    expect(order.epoch).toBe(3n);
  });

  it("random nonces are 64-bit and collision-unlikely", () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 1000; i++) {
      const n = randomNonce();
      expect(n).toBeLessThan(1n << 64n);
      seen.add(n);
    }
    expect(seen.size).toBe(1000);
  });
});
