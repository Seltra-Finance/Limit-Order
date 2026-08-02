import { AbiCoder, type Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import type { SeltraConfig } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import type { StoredOrder } from "../src/types.js";
import type { BestVenueQuoter, DexQuote } from "../src/venues.js";

describe("Keeper LFJ route encoding", () => {
  const tokenA = "0x00000000000000000000000000000000000000a1";
  const tokenB = "0x00000000000000000000000000000000000000b2";
  const tokenC = "0x00000000000000000000000000000000000000c3";

  it("encodes a direct route", () => {
    const encoded = Keeper.encodeLfjExtra(123n, [20n], [2], [tokenA, tokenB]);
    const decoded = AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256[]", "uint8[]", "address[]"],
      encoded,
    );
    expect(decoded[0]).toBe(123n);
    expect(decoded[3].map((token: string) => token.toLowerCase())).toEqual([tokenA, tokenB]);
  });

  it("rejects intermediate tokens", () => {
    expect(() => Keeper.encodeLfjExtra(123n, [20n, 20n], [2, 2], [tokenA, tokenC, tokenB])).toThrow(
      "Seltra V1 supports only direct LFJ routes",
    );
  });
});

describe("Keeper confirmed-fill suppression", () => {
  const base = "0x00000000000000000000000000000000000000a1";
  const quoteToken = "0x00000000000000000000000000000000000000b2";
  const orderHash = `0x${"12".repeat(32)}`;

  const config: SeltraConfig = {
    rpcUrl: "http://127.0.0.1:8545",
    quoteRpcUrl: "http://127.0.0.1:8545",
    chainId: 43113,
    permit2: "0x0000000000000000000000000000000000000001",
    settlement: "0x0000000000000000000000000000000000000002",
    router: "0x0000000000000000000000000000000000000003",
    pairs: { "BASE/QUOTE": { base, quote: quoteToken } },
    apiPort: 8080,
    apiHost: "127.0.0.1",
    corsOrigin: "*",
    apiRateLimitPerMinute: 600,
    dexVenues: [],
    dexAdapterId: 0,
    keeperMinProfit: 0n,
    maxOrderTtlSeconds: 604_800,
    wrappedNative: base,
    gasCostBufferBps: 0,
    quoteDeadlineSeconds: 30,
    maxQuoteAgeMs: 60_000,
    watcherPollIntervalMs: 2_000,
    pollIntervalMs: 2_000,
    watcherMaxQuoteGroupsPerTick: 32,
    publicQuoteCacheMs: 5_000,
    indexerStartBlock: 1,
    indexerConfirmations: 2,
    indexerBatchSize: 2_000,
  };

  const order: StoredOrder = {
    orderHash,
    status: "resting",
    createdAt: Date.now(),
    order: {
      maker: "0x0000000000000000000000000000000000000004",
      receiver: "0x0000000000000000000000000000000000000004",
      makerAsset: base,
      takerAsset: quoteToken,
      makingAmount: 100n,
      takingAmount: 90n,
      salt: 1n,
      epoch: 0n,
      expiry: BigInt(Math.floor(Date.now() / 1_000) + 600),
      allowedSender: "0x0000000000000000000000000000000000000000",
      flags: 0,
    },
    permit: {
      permitted: { token: base, amount: 100n },
      nonce: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 600),
    },
    signature: `0x${"34".repeat(65)}`,
  };

  function harness(hooks: ConstructorParameters<typeof Keeper>[3] = {}) {
    const staticCall = vi.fn(async () => undefined);
    const estimateGas = vi.fn(async () => 100n);
    const send = vi.fn(async () => ({ wait: async () => ({ hash: `0x${"56".repeat(32)}` }) }));
    Object.assign(send, { staticCall, estimateGas });

    const keeper = new Keeper(
      config,
      {} as Provider,
      `0x${"11".repeat(32)}`,
      hooks,
      { quoteBest: vi.fn() } as unknown as BestVenueQuoter,
    );
    (keeper as unknown as { settlement: { fillOrderDEX: typeof send } }).settlement = {
      fillOrderDEX: send,
    };
    const quote: DexQuote = {
      adapterId: 1,
      venue: "Test",
      amountOut: 100n,
      extra: "0x",
      quotedAtMs: Date.now(),
    };
    return { keeper, quote, staticCall, send };
  }

  it("does not retry a mined fill before indexer reconciliation", async () => {
    const onFilled = vi.fn(async () => undefined);
    const onFailed = vi.fn();
    const { keeper, quote, staticCall, send } = harness({ onFilled, onFailed });

    await keeper.tryFillDEX(order, quote);
    await keeper.tryFillDEX(order, { ...quote, quotedAtMs: Date.now() });

    expect(send).toHaveBeenCalledTimes(1);
    expect(staticCall).toHaveBeenCalledTimes(1);
    expect(onFilled).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();

    keeper.markReconciled(orderHash);
    await keeper.tryFillDEX(order, { ...quote, quotedAtMs: Date.now() });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not impose a quote-notional maximum on keeper execution", async () => {
    const { keeper, quote, send } = harness();
    const highNotional = 10n ** 40n;
    const highOrder: StoredOrder = {
      ...order,
      orderHash: `0x${"78".repeat(32)}`,
      order: {
        ...order.order,
        makingAmount: highNotional,
        takingAmount: highNotional,
      },
      permit: {
        ...order.permit,
        permitted: { token: base, amount: highNotional },
      },
    };

    await keeper.tryFillDEX(highOrder, {
      ...quote,
      amountOut: highNotional + 10n,
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not classify a post-fill persistence error as an execution failure", async () => {
    const onFailed = vi.fn();
    const onPostFillError = vi.fn();
    const { keeper, quote } = harness({
      onFilled: async () => {
        throw new Error("database unavailable");
      },
      onFailed,
      onPostFillError,
    });

    await keeper.tryFillDEX(order, quote);
    await keeper.tryFillDEX(order, { ...quote, quotedAtMs: Date.now() });

    expect(onFailed).not.toHaveBeenCalled();
    expect(onPostFillError).toHaveBeenCalledWith([orderHash], "database unavailable");
  });
});
