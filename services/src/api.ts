import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { formatUnits, getAddress, isAddress, parseUnits, verifyMessage } from "ethers";

import { quotePolicyFor, type SeltraConfig } from "./config.js";
import {
  ALLOWED_CANDLE_INTERVALS,
  buildBook,
  buildCandles,
  buildTrades,
  diffBookLevels,
  pairForOrder,
  protocolStats,
  publicPairs,
  resolvePublicPair,
  serializePublicOrder,
  type BookSnapshot,
  type PublicOrderRecord,
  type PublicPair,
} from "./publicApi.js";
import type { Store } from "./store.js";
import { orderFromJson, permitFromJson, type StoredOrder } from "./types.js";
import { orderHash, recoverMaker } from "./permit2.js";
import type { VenueQuoter } from "./venues.js";

/** Orderbook REST + WebSocket API (revised spec 1.10). */

export interface ApiDeps {
  config: SeltraConfig;
  store: Store;
  /** called after an order is accepted, e.g. to feed the matching engine */
  onNewOrder?: (order: StoredOrder) => void;
  /** Production executable-venue quoter used by the public market-data API. */
  quoter?: VenueQuoter;
  /** optional on-chain hooks (balance/allowance/epoch/reconciliation) */
  chain?: {
    epochOf(maker: string): Promise<bigint>;
    balanceOf(token: string, owner: string): Promise<bigint>;
    permit2Allowance(token: string, owner: string): Promise<bigint>;
    isTokenAllowed(token: string): Promise<boolean>;
    isNonceInvalidated?(owner: string, nonce: bigint): Promise<boolean>;
    blockTimestamp?(blockNumber: number): Promise<number>;
  };
}

interface StreamEvent {
  type: "order" | "fill" | "cancel";
  data: { orderHash: string } | PublicOrderRecord;
}

interface SocketLike {
  send(payload: string): void;
  on(event: "message", listener: (payload: unknown) => void): void;
  on(event: "close" | "error", listener: () => void): void;
  close?(): void;
}

interface StreamClient {
  socket: SocketLike;
  channels: Set<string>;
}

type Api = FastifyInstance & { broadcast: (event: StreamEvent) => void };

export function buildApi(deps: ApiDeps): Api {
  const { config, store, onNewOrder, chain, quoter } = deps;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const clients = new Set<StreamClient>();
  const books = new Map<string, { seq: number; book: BookSnapshot }>();
  const blockTimestamps = new Map<number, number>();
  const rateBuckets = new Map<string, { minute: number; count: number }>();
  const configuredPairs = publicPairs(config);

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && origin !== config.corsOrigin) {
      return reply.code(403).send({ error: "origin not allowed" });
    }
    if (req.method !== "OPTIONS") {
      const minute = Math.floor(Date.now() / 60_000);
      const bucket = rateBuckets.get(req.ip);
      const next = bucket?.minute === minute ? { minute, count: bucket.count + 1 } : { minute, count: 1 };
      rateBuckets.set(req.ip, next);
      if (next.count > config.apiRateLimitPerMinute) {
        reply.header("retry-after", "60");
        return reply.code(429).send({ error: "rate limit exceeded" });
      }
      if (rateBuckets.size > 10_000) {
        for (const [ip, value] of rateBuckets) if (value.minute < minute) rateBuckets.delete(ip);
      }
    }
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("access-control-allow-origin", config.corsOrigin);
    reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,x-seltra-cancel-signature");
    reply.header("vary", "origin");
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  app.options("/*", async (_req, reply) => reply.code(204).send());

  const send = (client: StreamClient, message: unknown) => {
    try {
      client.socket.send(JSON.stringify(message));
    } catch {
      client.socket.close?.();
    }
  };
  const sendChannel = (channel: string, message: unknown) => {
    for (const client of clients) if (client.channels.has(channel)) send(client, message);
  };

  const publicRecord = async (stored: StoredOrder): Promise<PublicOrderRecord> => {
    const fill = (await store.listFills(stored.orderHash))[0];
    let timestamp: number | undefined;
    if (fill && chain?.blockTimestamp) {
      timestamp = blockTimestamps.get(fill.blockNumber);
      if (timestamp === undefined) {
        timestamp = await chain.blockTimestamp(fill.blockNumber);
        blockTimestamps.set(fill.blockNumber, timestamp);
      }
    }
    return serializePublicOrder(config, stored, fill, timestamp);
  };

  const publicRecords = async (orders: StoredOrder[]): Promise<PublicOrderRecord[]> =>
    Promise.all(orders.map(publicRecord));

  const currentBook = async (pair: PublicPair): Promise<BookSnapshot> => {
    const orders = await store.listOrders({
      pair: [pair.baseAsset, pair.quoteAsset],
      status: "resting",
    });
    return buildBook(orders, pair);
  };

  const pushBook = async (pair: PublicPair) => {
    const book = await currentBook(pair);
    const previous = books.get(pair.id);
    if (!previous) {
      books.set(pair.id, { seq: 0, book });
      sendChannel(`book:${pair.id}`, {
        v: 1,
        type: "book.snapshot",
        pair: pair.id,
        seq: 0,
        book,
      });
      return;
    }
    const seq = previous.seq + 1;
    const changes = diffBookLevels(previous.book, book);
    books.set(pair.id, { seq, book });
    sendChannel(`book:${pair.id}`, {
      v: 1,
      type: "book.diff",
      pair: pair.id,
      seq,
      bids: changes.bids,
      asks: changes.asks,
      ts: book.ts,
    });
  };

  const publish = async (event: StreamEvent) => {
    const orderHash = "orderHash" in event.data ? event.data.orderHash : undefined;
    if (!orderHash) return;
    const stored = await store.getOrder(orderHash);
    if (!stored) return;
    const record = await publicRecord(stored);
    sendChannel(`user:${stored.order.maker.toLowerCase()}`, {
      v: 1,
      type: "user.order",
      order: record,
    });
    const pair = pairForOrder(config, stored);
    if (pair) await pushBook(pair);
  };

  let streamQueue = Promise.resolve();
  const broadcast = (event: StreamEvent) => {
    streamQueue = streamQueue
      .then(() => publish(event))
      .catch((error) => console.error("stream broadcast failed", error));
  };

  app.register(websocket);
  app.register(async (scoped) => {
    scoped.get("/stream", { websocket: true }, (connection) => {
      const socket = connection as unknown as SocketLike;
      const client: StreamClient = { socket, channels: new Set() };
      clients.add(client);
      socket.on("message", (payload) => {
        void handleStreamMessage(client, String(payload)).catch((error) => {
          console.error("stream message failed", error);
        });
      });
      socket.on("close", () => clients.delete(client));
      socket.on("error", () => {
        clients.delete(client);
        socket.close?.();
      });
    });
  });

  const handleStreamMessage = async (client: StreamClient, raw: string) => {
    let message: { type?: unknown; channel?: unknown };
    try {
      message = JSON.parse(raw) as { type?: unknown; channel?: unknown };
    } catch {
      return;
    }
    if (typeof message.channel !== "string") return;
    if (message.type === "unsubscribe") {
      client.channels.delete(message.channel.toLowerCase().startsWith("user:") ? message.channel.toLowerCase() : message.channel);
      return;
    }
    if (message.type !== "subscribe") return;
    if (message.channel.startsWith("book:")) {
      const pair = resolvePublicPair(config, message.channel.slice("book:".length));
      if (!pair) return;
      const channel = `book:${pair.id}`;
      client.channels.add(channel);
      let state = books.get(pair.id);
      if (!state) {
        state = { seq: 0, book: await currentBook(pair) };
        books.set(pair.id, state);
      }
      send(client, {
        v: 1,
        type: "book.snapshot",
        pair: pair.id,
        seq: state.seq,
        book: state.book,
      });
      return;
    }
    if (/^user:0x[0-9a-fA-F]{40}$/.test(message.channel)) {
      client.channels.add(message.channel.toLowerCase());
    }
  };

  const heartbeat = setInterval(() => {
    const payload = { v: 1, type: "heartbeat", ts: Date.now() };
    for (const client of clients) send(client, payload);
  }, 15_000);
  heartbeat.unref();
  app.addHook("onClose", async () => clearInterval(heartbeat));

  // Submit a signed order: {order, permit, signature}.
  app.get("/markets", async () =>
    configuredPairs.map((pair) => {
      const policy = quotePolicyFor(config, pair.quoteAsset);
      return {
        pair: pair.id,
        baseToken: pair.baseAsset,
        quoteToken: pair.quoteAsset,
        quoteSymbol: pair.quoteSymbol,
        quoteDecimals: pair.quoteDecimals,
        minOrderNotional: policy.minOrderNotional.toString(),
        minOrderNotionalFormatted: formatUnits(policy.minOrderNotional, pair.quoteDecimals),
      };
    }),
  );

  app.post("/orders", async (req, reply) => {
    let stored: StoredOrder;
    try {
      const body = req.body as Record<string, unknown>;
      const order = orderFromJson(body.order as Record<string, unknown>);
      const permit = permitFromJson(body.permit as Record<string, unknown>);
      const signature = String(body.signature);

      for (const address of [
        order.maker,
        order.receiver,
        order.makerAsset,
        order.takerAsset,
        order.allowedSender,
      ]) {
        if (!isAddress(address)) return reply.code(400).send({ error: `invalid address: ${address}` });
      }
      if (order.flags !== 0) return reply.code(400).send({ error: "flags must be 0 in V1" });
      if (order.makingAmount <= 0n || order.takingAmount <= 0n) {
        return reply.code(400).send({ error: "order amounts must be positive" });
      }
      if (order.salt < 0n || order.epoch < 0n || permit.nonce < 0n) {
        return reply.code(400).send({ error: "unsigned integer fields cannot be negative" });
      }
      if (order.receiver === "0x0000000000000000000000000000000000000000") {
        return reply.code(400).send({ error: "receiver must be nonzero" });
      }
      const now = BigInt(Math.floor(Date.now() / 1_000));
      if (order.expiry <= now) return reply.code(400).send({ error: "order already expired" });
      if (order.expiry > now + BigInt(config.maxOrderTtlSeconds)) {
        return reply.code(400).send({ error: "order expiry exceeds maximum TTL" });
      }
      if (permit.deadline !== order.expiry) {
        return reply.code(400).send({ error: "permit.deadline != order.expiry" });
      }
      if (permit.permitted.token.toLowerCase() !== order.makerAsset.toLowerCase()) {
        return reply.code(400).send({ error: "permit token != makerAsset" });
      }
      if (permit.permitted.amount !== order.makingAmount) {
        return reply.code(400).send({ error: "permit amount != makingAmount" });
      }

      const matchedPair = configuredPairs.find(
        (pair) =>
          (pair.baseAsset.toLowerCase() === order.makerAsset.toLowerCase() &&
            pair.quoteAsset.toLowerCase() === order.takerAsset.toLowerCase()) ||
          (pair.quoteAsset.toLowerCase() === order.makerAsset.toLowerCase() &&
            pair.baseAsset.toLowerCase() === order.takerAsset.toLowerCase()),
      );
      if (Object.keys(config.pairs).length > 0 && !matchedPair) {
        return reply.code(400).send({ error: "pair not supported" });
      }
      if (matchedPair) {
        const policy = quotePolicyFor(config, matchedPair.quoteAsset);
        const quoteNotional =
          order.makerAsset.toLowerCase() === matchedPair.quoteAsset.toLowerCase()
            ? order.makingAmount
            : order.takingAmount;
        if (policy.minOrderNotional > 0n && quoteNotional < policy.minOrderNotional) {
          return reply.code(400).send({
            error: `order is below minimum quote notional (${formatUnits(
              policy.minOrderNotional,
              matchedPair.quoteDecimals,
            )} ${matchedPair.quoteSymbol})`,
            minOrderNotional: policy.minOrderNotional.toString(),
            quoteToken: matchedPair.quoteAsset,
          });
        }
      }

      let recovered: string;
      try {
        recovered = recoverMaker(order, permit, signature, config.settlement, config.chainId, config.permit2);
      } catch {
        return reply.code(400).send({ error: "malformed signature" });
      }
      if (getAddress(recovered) !== getAddress(order.maker)) {
        return reply.code(400).send({ error: "signature does not recover to maker" });
      }

      if (chain) {
        const epoch = await chain.epochOf(order.maker);
        if (order.epoch !== epoch) return reply.code(400).send({ error: `stale epoch (current ${epoch})` });
        const balance = await chain.balanceOf(order.makerAsset, order.maker);
        if (balance < order.makingAmount) return reply.code(400).send({ error: "insufficient maker balance" });
        const allowance = await chain.permit2Allowance(order.makerAsset, order.maker);
        if (allowance < order.makingAmount) {
          return reply.code(400).send({ error: "insufficient Permit2 allowance" });
        }
        if (!(await chain.isTokenAllowed(order.makerAsset)) || !(await chain.isTokenAllowed(order.takerAsset))) {
          return reply.code(400).send({ error: "token not allowlisted on-chain" });
        }
      }

      stored = {
        order,
        permit,
        signature,
        orderHash: orderHash(order),
        status: "resting",
        createdAt: Date.now(),
      };
      const existing = await store.getOrder(stored.orderHash);
      if (existing) return reply.code(200).send({ orderHash: existing.orderHash, status: existing.status });
      await store.insertOrder(stored);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    onNewOrder?.(stored);
    broadcast({ type: "order", data: { orderHash: stored.orderHash } });
    return reply.code(200).send({ orderHash: stored.orderHash, status: stored.status });
  });

  app.get("/orders", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    let pair: [string, string] | undefined;
    if (query.pair) {
      const resolved = resolvePublicPair(config, query.pair);
      if (!resolved) return reply.code(404).send({ error: "pair not supported" });
      pair = [resolved.baseAsset, resolved.quoteAsset];
    }
    if (query.status === "unfillable") return [];
    const orders = await store.listOrders({
      maker: query.maker,
      status: query.status as StoredOrder["status"] | undefined,
      pair,
    });
    return (await publicRecords(orders)).sort((a, b) => b.createdAt - a.createdAt);
  });

  app.post("/orders/:hash/reconcile", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const order = await store.getOrder(hash);
    if (!order) return reply.code(404).send({ error: "not found" });
    let changed = false;
    if (order.status === "resting" || order.status === "fillable") {
      const now = BigInt(Math.floor(Date.now() / 1_000));
      if (order.order.expiry <= now) {
        await store.setStatus(hash, "expired");
        order.status = "expired";
        changed = true;
      } else if (chain) {
        const epoch = await chain.epochOf(order.order.maker);
        const invalidated = chain.isNonceInvalidated
          ? await chain.isNonceInvalidated(order.order.maker, order.permit.nonce)
          : false;
        if (order.order.epoch < epoch || invalidated) {
          await store.setStatus(hash, "cancelled");
          order.status = "cancelled";
          changed = true;
        }
      }
    }
    if (changed) broadcast({ type: "cancel", data: { orderHash: hash } });
    return publicRecord(order);
  });

  app.get("/orders/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const order = await store.getOrder(hash);
    if (!order) return reply.code(404).send({ error: "not found" });
    return publicRecord(order);
  });

  // Soft-cancel in the book only; binding cancellation is on-chain (Permit2
  // invalidateUnorderedNonces or epoch bump).
  app.delete("/orders/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const order = await store.getOrder(hash);
    if (!order) return reply.code(404).send({ error: "not found" });
    const signature = req.headers["x-seltra-cancel-signature"];
    if (typeof signature !== "string") return reply.code(401).send({ error: "cancel signature required" });
    try {
      const signer = verifyMessage(softCancelMessage(config.chainId, order.orderHash), signature);
      if (getAddress(signer) !== getAddress(order.order.maker)) {
        return reply.code(403).send({ error: "cancel signature is not from maker" });
      }
    } catch {
      return reply.code(400).send({ error: "malformed cancel signature" });
    }
    await store.setStatus(hash, "cancelled");
    broadcast({ type: "cancel", data: { orderHash: hash } });
    return { orderHash: hash, status: "cancelled" };
  });

  app.get("/orderbook/:pair", async (req, reply) => {
    const { pair: pairId } = req.params as { pair: string };
    const pair = resolvePublicPair(config, pairId);
    if (!pair) return reply.code(404).send({ error: "pair not supported" });
    return currentBook(pair);
  });

  app.get("/candles/:pair", async (req, reply) => {
    const { pair: pairId } = req.params as { pair: string };
    const pair = resolvePublicPair(config, pairId);
    if (!pair) return reply.code(404).send({ error: "pair not supported" });
    const interval = Number((req.query as { interval?: string }).interval ?? "3600");
    if (!ALLOWED_CANDLE_INTERVALS.has(interval)) {
      return reply.code(400).send({ error: "unsupported interval" });
    }
    const orders = await store.listOrders({
      pair: [pair.baseAsset, pair.quoteAsset],
      status: "filled",
    });
    return buildCandles(await publicRecords(orders), interval);
  });

  app.get("/trades/:pair", async (req, reply) => {
    const { pair: pairId } = req.params as { pair: string };
    const pair = resolvePublicPair(config, pairId);
    if (!pair) return reply.code(404).send({ error: "pair not supported" });
    const requested = Number((req.query as { limit?: string }).limit ?? "50");
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 200)) : 50;
    const orders = await store.listOrders({
      pair: [pair.baseAsset, pair.quoteAsset],
      status: "filled",
    });
    return buildTrades(await publicRecords(orders), limit);
  });

  app.get("/quote/:pair", async (req, reply) => {
    const { pair: pairId } = req.params as { pair: string };
    const pair = resolvePublicPair(config, pairId);
    if (!pair) return reply.code(404).send({ error: "pair not supported" });
    if (!quoter) return reply.code(404).send({ error: "no executable quote available" });
    try {
      const amountIn = parseUnits(pair.referenceBaseAmount, pair.baseDecimals);
      const referenceBaseAmount = Number(pair.referenceBaseAmount);
      const quotes = await quoter.quoteAll(pair.baseAsset, pair.quoteAsset, amountIn);
      const venues = quotes.map((quote) => ({
        name: quote.venue,
        price: Number(formatUnits(quote.amountOut, pair.quoteDecimals)) / referenceBaseAmount,
      }));
      const best = venues.reduce((current, candidate) =>
        candidate.price > current.price ? candidate : current,
      );
      const timestamp = Math.max(...quotes.map((quote) => quote.quotedAtMs));
      await Promise.all([
        store.insertQuotePoint(pair.id, timestamp, best.price),
        store.insertVenueQuotePoints(pair.id, timestamp, venues),
      ]);
      return {
        pair: pair.id,
        price: best.price,
        venue: best.name,
        venues,
        referenceBaseAmount: pair.referenceBaseAmount,
        ts: timestamp,
      };
    } catch {
      return reply.code(404).send({ error: "no executable quote available" });
    }
  });

  app.get("/quote-history/:pair", async (req, reply) => {
    const { pair: pairId } = req.params as { pair: string };
    const pair = resolvePublicPair(config, pairId);
    if (!pair) return reply.code(404).send({ error: "pair not supported" });
    const requested = Number((req.query as { from?: string }).from ?? Date.now() - 86_400_000);
    const from = Number.isFinite(requested) ? Math.max(0, requested) : Date.now() - 86_400_000;
    return store.listQuotePoints(pair.id, from);
  });

  app.get("/venue-quote-history/:pair", async (req, reply) => {
    const { pair: pairId } = req.params as { pair: string };
    const pair = resolvePublicPair(config, pairId);
    if (!pair) return reply.code(404).send({ error: "pair not supported" });
    const requested = Number((req.query as { from?: string }).from ?? Date.now() - 86_400_000);
    const from = Number.isFinite(requested) ? Math.max(0, requested) : Date.now() - 86_400_000;
    return store.listVenueQuotePoints(pair.id, from);
  });

  app.get("/stats", async (req, reply) => {
    const { pair: requestedPair } = req.query as { pair?: string };
    const selectedPair = requestedPair
      ? resolvePublicPair(config, requestedPair)
      : undefined;
    if (requestedPair && !selectedPair) {
      return reply.code(404).send({ error: "pair not supported" });
    }
    const orders = await store.listOrders();
    return protocolStats(await publicRecords(orders), configuredPairs, selectedPair);
  });

  app.get("/fills", async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const fills = await store.listFills(query.orderHash);
    return fills.map((fill) => ({
      ...fill,
      amountOut: fill.amountOut.toString(),
      makerImprovement: fill.makerImprovement.toString(),
      keeperReward: fill.keeperReward.toString(),
    }));
  });

  app.get("/health", async () => ({ ok: true, chainId: config.chainId }));

  return Object.assign(app, { broadcast });
}

export function softCancelMessage(chainId: number, orderHash: string): string {
  return `Seltra soft cancel\nchainId:${chainId}\norderHash:${orderHash.toLowerCase()}`;
}
