import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "ethers";

import { buildApi, softCancelMessage } from "../src/api.js";
import type { SeltraConfig } from "../src/config.js";
import { typedDataForSigning } from "../src/permit2.js";
import { MemoryStore } from "../src/store.js";
import { orderToJson, permitToJson, type Order, type PermitTransferFrom } from "../src/types.js";

const WAVAX = "0xd00ae08403B9bbb9124bB305C09058E32C39A48c";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";

const config: SeltraConfig = {
  rpcUrl: "",
  chainId: 43113,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  settlement: "0x00000000000000000000000000000000DeaDBeef",
  router: "0x0000000000000000000000000000000000000001",
  pairs: { "WAVAX/USDC": { base: WAVAX, quote: USDC } },
  apiPort: 0,
  apiHost: "127.0.0.1",
  corsOrigin: "http://localhost:3000",
  apiRateLimitPerMinute: 120,
  dexVenues: [{ kind: "mock", name: "Mock", adapterId: 0 }],
  dexAdapterId: 0,
  keeperMinProfit: 0n,
  minOrderNotional: 0n,
  maxOrderTtlSeconds: 2_592_000,
  keeperMaxOrderNotional: 0n,
  keeperDailyNotionalCap: 0n,
  wrappedNative: WAVAX,
  gasCostBufferBps: 2000,
  quoteDeadlineSeconds: 30,
  maxQuoteAgeMs: 5000,
  pollIntervalMs: 60000,
  indexerStartBlock: 0,
  indexerConfirmations: 0,
  indexerBatchSize: 2000,
};

const wallet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    maker: wallet.address,
    receiver: wallet.address,
    makerAsset: WAVAX,
    takerAsset: USDC,
    makingAmount: 10n * 10n ** 18n,
    takingAmount: 400n * 10n ** 6n,
    salt: BigInt(Math.floor(Math.random() * 1e12)),
    epoch: 0n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    allowedSender: "0x0000000000000000000000000000000000000000",
    flags: 0,
    ...overrides,
  };
}

async function signedBody(order: Order) {
  const permit: PermitTransferFrom = {
    permitted: { token: order.makerAsset, amount: order.makingAmount },
    nonce: order.salt, // fine for tests
    deadline: order.expiry,
  };
  const { domain, types, value } = typedDataForSigning(order, permit, config.settlement, config.chainId, config.permit2);
  const signature = await wallet.signTypedData(domain, types, value);
  return { order: orderToJson(order), permit: permitToJson(permit), signature };
}

describe("orderbook API", () => {
  const store = new MemoryStore();
  const api = buildApi({ config, store });

  beforeAll(async () => {
    await api.ready();
  });
  afterAll(async () => {
    await api.close();
  });

  it("accepts a well-formed signed order and lists it", async () => {
    const order = makeOrder();
    const res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(order) });
    expect(res.statusCode).toBe(200);
    const { orderHash } = res.json();

    const list = await api.inject({ method: "GET", url: `/orders?maker=${wallet.address}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((o: { orderHash: string }) => o.orderHash === orderHash)).toBe(true);
  });

  it("rejects a signature that does not recover to the maker", async () => {
    const order = makeOrder();
    const body = await signedBody(order);
    body.order.takingAmount = "1"; // tamper after signing
    const res = await api.inject({ method: "POST", url: "/orders", payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/signature/);
  });

  it("rejects malformed signatures, bad flags, expired orders, unknown pairs", async () => {
    const okOrder = makeOrder();
    const okBody = await signedBody(okOrder);

    let res = await api.inject({
      method: "POST",
      url: "/orders",
      payload: { ...okBody, signature: "0xdead" },
    });
    expect(res.statusCode).toBe(400);

    const flagged = makeOrder({ flags: 1 });
    res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(flagged) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/flags/);

    const expired = makeOrder({ expiry: 1n });
    res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(expired) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/expired/);

    const longLived = makeOrder({
      expiry: BigInt(Math.floor(Date.now() / 1000) + config.maxOrderTtlSeconds + 60),
    });
    res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(longLived) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/TTL/);

    const zeroAmount = makeOrder({ makingAmount: 0n });
    res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(zeroAmount) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/positive/);

    const badPair = makeOrder({ takerAsset: "0x0000000000000000000000000000000000000123" });
    res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(badPair) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pair/);
  });

  it("orderbook depth splits asks and bids", async () => {
    const res = await api.inject({ method: "GET", url: `/orderbook/${WAVAX},${USDC}` });
    expect(res.statusCode).toBe(200);
    const book = res.json();
    expect(book.asks.length).toBeGreaterThan(0);
  });

  it("soft-cancel flips status", async () => {
    const order = makeOrder();
    const res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(order) });
    const { orderHash } = res.json();
    const cancelSignature = await wallet.signMessage(softCancelMessage(config.chainId, orderHash));
    const del = await api.inject({
      method: "DELETE",
      url: `/orders/${orderHash}`,
      headers: { "x-seltra-cancel-signature": cancelSignature },
    });
    expect(del.statusCode).toBe(200);
    const get = await api.inject({ method: "GET", url: `/orders/${orderHash}` });
    expect(get.json().status).toBe("cancelled");
  });

  it("rejects an unauthenticated soft cancel", async () => {
    const order = makeOrder();
    const res = await api.inject({ method: "POST", url: "/orders", payload: await signedBody(order) });
    const del = await api.inject({ method: "DELETE", url: `/orders/${res.json().orderHash}` });
    expect(del.statusCode).toBe(401);
  });
});
