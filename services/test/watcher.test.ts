import type { Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import type { SeltraConfig } from "../src/config.js";
import { MemoryStore } from "../src/store.js";
import type { StoredOrder } from "../src/types.js";
import type { BestVenueQuoter, DexQuote } from "../src/venues.js";
import { PriceWatcher } from "../src/watcher.js";

const config: SeltraConfig = {
  rpcUrl: "http://localhost:8545/",
  quoteRpcUrl: "http://localhost:8545/",
  chainId: 43113,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  settlement: "0x0000000000000000000000000000000000000001",
  router: "0x0000000000000000000000000000000000000002",
  pairs: {},
  apiPort: 8080,
  apiHost: "127.0.0.1",
  corsOrigin: "http://localhost:3000",
  apiRateLimitPerMinute: 120,
  dexVenues: [{ kind: "mock", name: "Mock", adapterId: 0 }],
  dexAdapterId: 0,
  keeperMinProfit: 0n,
  maxOrderTtlSeconds: 2_592_000,
  wrappedNative: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
  gasCostBufferBps: 2000,
  quoteDeadlineSeconds: 30,
  maxQuoteAgeMs: 5000,
  watcherPollIntervalMs: 60_000,
  pollIntervalMs: 60_000,
  watcherMaxQuoteGroupsPerTick: 32,
  publicQuoteCacheMs: 5_000,
  indexerStartBlock: 0,
  indexerConfirmations: 0,
  indexerBatchSize: 2000,
};

function storedOrder(expiry = BigInt(Math.floor(Date.now() / 1000) + 3600)): StoredOrder {
  return {
    orderHash: "0xabc",
    status: "resting",
    createdAt: Date.now(),
    signature: "0x",
    order: {
      maker: "0x0000000000000000000000000000000000000010",
      receiver: "0x0000000000000000000000000000000000000010",
      makerAsset: "0x0000000000000000000000000000000000000020",
      takerAsset: "0x0000000000000000000000000000000000000030",
      makingAmount: 10n,
      takingAmount: 400n,
      salt: 1n,
      epoch: 0n,
      expiry,
      allowedSender: "0x0000000000000000000000000000000000000000",
      flags: 0,
    },
    permit: {
      permitted: { token: "0x0000000000000000000000000000000000000020", amount: 10n },
      nonce: 1n,
      deadline: expiry,
    },
  };
}

function setup(result: DexQuote | Error, watcherMaxQuoteGroupsPerTick = 32) {
  const store = new MemoryStore();
  const onFillable = vi.fn();
  const quoteBest = result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  const quoter: BestVenueQuoter = { quoteBest };
  const watcher = new PriceWatcher(
    { ...config, watcherMaxQuoteGroupsPerTick },
    null as unknown as Provider,
    store,
    onFillable,
    quoter,
  );
  return { store, watcher, onFillable, quoteBest };
}

describe("PriceWatcher executable venue quotes", () => {
  const quote: DexQuote = {
    adapterId: 2,
    venue: "Blackhole",
    amountOut: 410n,
    extra: "0x1234",
    quotedAtMs: Date.now(),
  };

  it("does not advertise an order when every venue is unavailable", async () => {
    const { store, watcher, onFillable } = setup(new Error("no executable venue"));
    await store.insertOrder(storedOrder());
    await watcher.tick();
    expect(onFillable).not.toHaveBeenCalled();
  });

  it("passes the complete winning route to the keeper callback", async () => {
    const { store, watcher, onFillable, quoteBest } = setup(quote);
    const order = storedOrder();
    await store.insertOrder(order);
    await watcher.tick();
    expect(quoteBest).toHaveBeenCalledWith(order.order.makerAsset, order.order.takerAsset, 10n);
    expect(onFillable).toHaveBeenCalledWith(order, quote);
  });

  it("evaluates a newly submitted order without waiting for a polling tick", async () => {
    const { watcher, onFillable, quoteBest } = setup(quote);
    const order = storedOrder();
    await watcher.checkOrder(order);
    expect(quoteBest).toHaveBeenCalledWith(order.order.makerAsset, order.order.takerAsset, 10n);
    expect(onFillable).toHaveBeenCalledWith(order, quote);
  });

  it("still expires orders when venues are unavailable", async () => {
    const { store, watcher } = setup(new Error("paused"));
    const order = storedOrder(1n);
    await store.insertOrder(order);
    await watcher.tick();
    expect((await store.getOrder(order.orderHash))?.status).toBe("expired");
  });

  it("quotes identical Grid child sizes once and fans the result out", async () => {
    const { store, watcher, onFillable, quoteBest } = setup(quote);
    const first = storedOrder();
    first.orderHash = "0x01";
    const second = storedOrder();
    second.orderHash = "0x02";
    second.order.salt = 2n;
    second.permit.nonce = 2n;
    second.order.takingAmount = 500n;
    await store.insertOrder(first);
    await store.insertOrder(second);

    await watcher.tick();

    expect(quoteBest).toHaveBeenCalledOnce();
    expect(onFillable).toHaveBeenCalledOnce();
    expect(onFillable).toHaveBeenCalledWith(first, quote);
    expect(watcher.rpcBudgetSnapshot()).toMatchObject({
      ticks: 1,
      groupsSeen: 1,
      groupsQuoted: 1,
      groupsDeferred: 0,
    });
  });

  it("enforces the per-tick quote cap and rotates fairly across groups", async () => {
    const { store, watcher, quoteBest } = setup({ ...quote, amountOut: 1_000n }, 1);
    for (let i = 0; i < 3; i++) {
      const order = storedOrder();
      order.orderHash = `0x0${i + 1}`;
      order.order.makingAmount = BigInt(10 + i);
      order.order.salt = BigInt(i + 1);
      order.permit.permitted.amount = BigInt(10 + i);
      order.permit.nonce = BigInt(i + 1);
      await store.insertOrder(order);
    }

    await watcher.tick();
    await watcher.tick();
    await watcher.tick();

    expect(quoteBest).toHaveBeenCalledTimes(3);
    expect(new Set(quoteBest.mock.calls.map((call) => call[2]))).toEqual(new Set([10n, 11n, 12n]));
    expect(watcher.rpcBudgetSnapshot()).toMatchObject({
      ticks: 3,
      groupsSeen: 9,
      groupsQuoted: 3,
      groupsDeferred: 6,
    });
  });
});
