import { describe, expect, it } from "vitest";

import { crosses, matchable, MatchingEngine, type Match } from "../src/matching.js";
import type { Order, StoredOrder } from "../src/types.js";

const WAVAX = "0x0000000000000000000000000000000000000A11";
const USDC = "0x0000000000000000000000000000000000000B22";

let hashCounter = 0;
function stored(partial: Partial<Order> & { makingAmount: bigint; takingAmount: bigint }, sellBase = true): StoredOrder {
  const order: Order = {
    maker: "0x1111111111111111111111111111111111111111",
    receiver: "0x1111111111111111111111111111111111111111",
    makerAsset: sellBase ? WAVAX : USDC,
    takerAsset: sellBase ? USDC : WAVAX,
    salt: BigInt(++hashCounter),
    epoch: 0n,
    expiry: 4102444800n,
    allowedSender: "0x0000000000000000000000000000000000000000",
    flags: 0,
    ...partial,
  };
  return {
    order,
    permit: { permitted: { token: order.makerAsset, amount: order.makingAmount }, nonce: BigInt(hashCounter), deadline: order.expiry },
    signature: "0x",
    orderHash: `0xhash${hashCounter}`,
    status: "resting",
    createdAt: hashCounter,
  };
}

describe("cross condition (mirrors SeltraSettlement integer math)", () => {
  it("crosses iff b.makingAmount >= a.takingAmount for the exact X leg", () => {
    // A sells 10 WAVAX for >= 400 USDC; B sells 405 USDC for 10 WAVAX.
    const a = stored({ makingAmount: 10n * 10n ** 18n, takingAmount: 400n * 10n ** 6n }, true);
    const b = stored({ makingAmount: 405n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    expect(crosses(a.order, b.order)).toBe(true);

    const bLow = stored({ makingAmount: 399n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    expect(crosses(a.order, bLow.order)).toBe(false);
  });

  it("handles uint256 maxima without multiplication", () => {
    const max = (1n << 256n) - 1n;
    const a = stored({ makingAmount: max, takingAmount: max }, true);
    const bLow = stored({ makingAmount: max - 1n, takingAmount: max }, false);
    const bExact = stored({ makingAmount: max, takingAmount: max }, false);
    expect(crosses(a.order, bLow.order)).toBe(false);
    expect(crosses(a.order, bExact.order)).toBe(true);
  });

  /** Property test (spec 1.8): the reduced check agrees with the rational formula
   *  across a fuzzed corpus (the Foundry mirror is
   *  testFuzz_crossConditionMirrorsOnChain). */
  it("fuzzed corpus: division-free evaluation equals rational comparison", () => {
    let seed = 42n;
    const rng = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n));
    for (let i = 0; i < 5000; i++) {
      const makingA = (rng() % 10n ** 24n) + 1n;
      const takingA = (rng() % 10n ** 14n) + 1n;
      const makingB = (rng() % 10n ** 14n) + 1n;
      const takingB = makingA; // exact-size X leg
      const a = stored({ makingAmount: makingA, takingAmount: takingA }, true);
      const b = stored({ makingAmount: makingB, takingAmount: takingB }, false);
      // Reference: B's max price >= A's min price, computed as exact rationals.
      const reference = makingB * makingA >= takingA * takingB;
      expect(crosses(a.order, b.order)).toBe(reference);
      // With the exact X leg, the cross reduces to makingB >= takingA.
      expect(crosses(a.order, b.order)).toBe(makingB >= takingA);
    }
  });

  it("matchable requires mirror assets, exact size, resting status", () => {
    const a = stored({ makingAmount: 10n * 10n ** 18n, takingAmount: 400n * 10n ** 6n }, true);
    const b = stored({ makingAmount: 405n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    expect(matchable(a, b)).toBe(true);

    const wrongSize = stored({ makingAmount: 405n * 10n ** 6n, takingAmount: 9n * 10n ** 18n }, false);
    expect(matchable(a, wrongSize)).toBe(false);

    const filled = { ...b, status: "filled" as const };
    expect(matchable(a, filled)).toBe(false);
  });
});

describe("MatchingEngine", () => {
  it("crossing exact-size pair produces exactly one match", () => {
    const matches: Match[] = [];
    const engine = new MatchingEngine((m) => matches.push(m));

    const a = stored({ makingAmount: 10n * 10n ** 18n, takingAmount: 400n * 10n ** 6n }, true);
    const b = stored({ makingAmount: 405n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    engine.add(a);
    engine.add(b);

    expect(matches).toHaveLength(1);
    expect(matches[0].a.orderHash).toBe(a.orderHash);
    expect(matches[0].b.orderHash).toBe(b.orderHash);
    expect(matches[0].surplus).toBe(5n * 10n ** 6n);

    // A third crossing order cannot re-match in-flight orders.
    const c = stored({ makingAmount: 500n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    engine.add(c);
    expect(matches).toHaveLength(1);
  });

  it("non-crossing orders never match", () => {
    const matches: Match[] = [];
    const engine = new MatchingEngine((m) => matches.push(m));
    engine.add(stored({ makingAmount: 10n * 10n ** 18n, takingAmount: 400n * 10n ** 6n }, true));
    engine.add(stored({ makingAmount: 399n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false));
    expect(matches).toHaveLength(0);
  });

  it("picks the counterparty with the largest surplus", () => {
    const matches: Match[] = [];
    const engine = new MatchingEngine((m) => matches.push(m));
    const b1 = stored({ makingAmount: 401n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    const b2 = stored({ makingAmount: 410n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    engine.add(b1);
    engine.add(b2);
    engine.add(stored({ makingAmount: 10n * 10n ** 18n, takingAmount: 400n * 10n ** 6n }, true));
    expect(matches).toHaveLength(1);
    expect(matches[0].b.orderHash).toBe(b2.orderHash);
  });

  it("failed match is re-evaluated (nonce consumed on one side)", () => {
    const matches: Match[] = [];
    const engine = new MatchingEngine((m) => matches.push(m));
    const a = stored({ makingAmount: 10n * 10n ** 18n, takingAmount: 400n * 10n ** 6n }, true);
    const b1 = stored({ makingAmount: 405n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    engine.add(a);
    engine.add(b1);
    expect(matches).toHaveLength(1);

    // b1's nonce turned out consumed on-chain: release, b1 drops out, and a
    // matches the next candidate.
    const b2 = stored({ makingAmount: 402n * 10n ** 6n, takingAmount: 10n * 10n ** 18n }, false);
    engine.add(b2);
    expect(matches).toHaveLength(1); // a still in-flight, no double match
    engine.releaseMatch(matches[0], true, false);
    expect(matches).toHaveLength(2);
    expect(matches[1].b.orderHash).toBe(b2.orderHash);
  });
});
