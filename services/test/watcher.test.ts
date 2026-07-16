import type { Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import type { SeltraConfig } from "../src/config.js";
import { MemoryStore } from "../src/store.js";
import type { StoredOrder } from "../src/types.js";
import { PriceWatcher } from "../src/watcher.js";

const config: SeltraConfig = {
  rpcUrl: "",
  chainId: 43113,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  settlement: "0x0000000000000000000000000000000000000001",
  router: "0x0000000000000000000000000000000000000002",
  pairs: {},
  apiPort: 0,
  dexAdapterId: 0,
  keeperMinProfit: 0n,
  keeperMaxOrderNotional: 0n,
  keeperDailyNotionalCap: 0n,
  pollIntervalMs: 60_000,
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

function setup(enabled: boolean, quotedOut = 410n) {
  const store = new MemoryStore();
  const onFillable = vi.fn();
  const watcher = new PriceWatcher(config, null as unknown as Provider, store, onFillable);
  const quote = vi.fn().mockResolvedValue(quotedOut);
  const router = {
    isRegistered: vi.fn().mockResolvedValue(enabled),
    quote: { staticCall: quote },
  };
  (watcher as unknown as { router: typeof router }).router = router;
  return { store, watcher, onFillable, router, quote };
}

describe("PriceWatcher adapter circuit breaker", () => {
  it("does not quote or advertise a paused adapter", async () => {
    const { store, watcher, onFillable, quote } = setup(false);
    await store.insertOrder(storedOrder());

    await watcher.tick();

    expect(quote).not.toHaveBeenCalled();
    expect(onFillable).not.toHaveBeenCalled();
  });

  it("quotes a registered adapter and reports a fillable order", async () => {
    const { store, watcher, onFillable, quote } = setup(true);
    const order = storedOrder();
    await store.insertOrder(order);

    await watcher.tick();

    expect(quote).toHaveBeenCalledOnce();
    expect(onFillable).toHaveBeenCalledWith(order, 410n);
  });

  it("still expires orders while the adapter is paused", async () => {
    const { store, watcher } = setup(false);
    const order = storedOrder(1n);
    await store.insertOrder(order);

    await watcher.tick();

    expect((await store.getOrder(order.orderHash))?.status).toBe("expired");
  });
});
