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
  maxOrderTtlSeconds: 2_592_000,
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
  const quote = {
    adapterId: 1,
    venue: "LFJ",
    amountOut: 40n * 10n ** 6n,
    extra: "0x",
    quotedAtMs: 1_700_000_000_000,
  };
  const quoter = {
    quoteBest: async () => quote,
    quoteAll: async () => [
      quote,
      { ...quote, adapterId: 2, venue: "Blackhole", amountOut: 39n * 10n ** 6n },
    ],
  };
  const api = buildApi({ config, store, quoter });
  let firstOrderHash = "";

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
    firstOrderHash = orderHash;

    const list = await api.inject({ method: "GET", url: `/orders?maker=${wallet.address}` });
    expect(list.statusCode).toBe(200);
    const record = list.json().find((o: { orderHash: string }) => o.orderHash === orderHash);
    expect(record).toMatchObject({
      orderHash,
      chainId: 43113,
      pair: "WAVAX-USDC",
      side: "sell",
      price: "40.000000",
      baseAmount: "10",
      softCancelled: false,
      status: "resting",
    });
  });

  it("admits both minimal-unit and high-notional signed orders without nominal gates", async () => {
    const minimalBuy = makeOrder({
      makerAsset: USDC,
      takerAsset: WAVAX,
      makingAmount: 1n,
      takingAmount: 1n,
    });
    const minimalAccepted = await api.inject({
      method: "POST",
      url: "/orders",
      payload: await signedBody(minimalBuy),
    });
    expect(minimalAccepted.statusCode).toBe(200);

    const highNotionalBuy = makeOrder({
      makerAsset: USDC,
      takerAsset: WAVAX,
      makingAmount: 10_000_000_000_000n,
      takingAmount: 1_000_000n * 10n ** 18n,
    });
    const highNotionalAccepted = await api.inject({
      method: "POST",
      url: "/orders",
      payload: await signedBody(highNotionalBuy),
    });
    expect(highNotionalAccepted.statusCode).toBe(200);
  });

  it("rejects a signature that does not recover to the maker", async () => {
    const order = makeOrder();
    const body = await signedBody(order);
    body.order.takingAmount = "399000000"; // tamper after signing
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
    const res = await api.inject({ method: "GET", url: "/orderbook/WAVAX-USDC" });
    expect(res.statusCode).toBe(200);
    const book = res.json();
    expect(book.pair).toBe("WAVAX-USDC");
    expect(book.ts).toEqual(expect.any(Number));
    expect(book.asks[0]).toMatchObject({ price: 40, size: 10, total: 10 });
    expect(book.asks.length).toBeGreaterThan(0);
  });

  it("serves executable quotes, persisted history and protocol stats", async () => {
    const live = await api.inject({ method: "GET", url: "/quote/WAVAX-USDC" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      pair: "WAVAX-USDC",
      price: 40,
      venue: "LFJ",
      venues: [
        { name: "LFJ", price: 40 },
        { name: "Blackhole", price: 39 },
      ],
      referenceBaseAmount: "1",
      ts: quote.quotedAtMs,
    });

    const history = await api.inject({
      method: "GET",
      url: `/quote-history/WAVAX-USDC?from=${quote.quotedAtMs - 1}`,
    });
    expect(history.json()).toEqual([{ t: quote.quotedAtMs, price: 40 }]);

    const venueHistory = await api.inject({
      method: "GET",
      url: `/venue-quote-history/WAVAX-USDC?from=${quote.quotedAtMs - 1}`,
    });
    expect(venueHistory.json()).toEqual([
      { t: quote.quotedAtMs, name: "Blackhole", price: 39 },
      { t: quote.quotedAtMs, name: "LFJ", price: 40 },
    ]);

    const stats = await api.inject({ method: "GET", url: "/stats" });
    expect(stats.json()).toMatchObject({
      totalVolumeQuote: null,
      quoteSymbol: null,
      volumeByQuote: [],
      ordersFilled: 0,
      ordersResting: expect.any(Number),
      avgImprovementBps: null,
      p2pMatchRateBps: null,
    });

    const pairStats = await api.inject({ method: "GET", url: "/stats?pair=WAVAX-USDC" });
    expect(pairStats.statusCode).toBe(200);
    expect(pairStats.json()).toMatchObject({
      totalVolumeQuote: "0.0",
      quoteSymbol: "USDC",
      volumeByQuote: [],
      ordersFilled: 0,
      ordersResting: expect.any(Number),
    });

    const unknownStats = await api.inject({ method: "GET", url: "/stats?pair=UNKNOWN-PAIR" });
    expect(unknownStats.statusCode).toBe(404);
    expect(unknownStats.json()).toEqual({ error: "pair not supported" });
  });

  it("speaks the frontend subscription protocol and sends a book snapshot", async () => {
    const ws = await api.injectWS("/stream");
    const message = new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (payload: unknown) => resolve(JSON.parse(String(payload)) as Record<string, unknown>));
    });
    ws.send(JSON.stringify({ type: "subscribe", channel: "book:WAVAX-USDC" }));
    await expect(message).resolves.toMatchObject({
      v: 1,
      type: "book.snapshot",
      pair: "WAVAX-USDC",
      seq: expect.any(Number),
    });
    ws.close();
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

  it("reconciles an invalidated Permit2 nonce immediately", async () => {
    const reconcileApi = buildApi({
      config,
      store,
      chain: {
        epochOf: async () => 0n,
        balanceOf: async () => 2n ** 255n,
        permit2Allowance: async () => 2n ** 255n,
        isTokenAllowed: async () => true,
        isNonceInvalidated: async () => true,
      },
    });
    await reconcileApi.ready();
    const response = await reconcileApi.inject({
      method: "POST",
      url: `/orders/${firstOrderHash}/reconcile`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelled");
    await reconcileApi.close();
  });
});
