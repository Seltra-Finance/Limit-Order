import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { getAddress, isAddress } from "ethers";

import type { SeltraConfig } from "./config.js";
import type { Store } from "./store.js";
import { orderFromJson, orderToJson, permitFromJson, permitToJson, type StoredOrder } from "./types.js";
import { orderHash, recoverMaker } from "./permit2.js";

/** Orderbook REST + WebSocket API (revised spec 1.7). */

export interface ApiDeps {
  config: SeltraConfig;
  store: Store;
  /** called after an order is accepted, e.g. to feed the matching engine */
  onNewOrder?: (order: StoredOrder) => void;
  /** optional on-chain hooks (balance/allowance/epoch verification) */
  chain?: {
    epochOf(maker: string): Promise<bigint>;
    balanceOf(token: string, owner: string): Promise<bigint>;
    permit2Allowance(token: string, owner: string): Promise<bigint>;
    isTokenAllowed(token: string): Promise<boolean>;
  };
}

interface StreamEvent {
  type: "order" | "fill" | "cancel";
  data: unknown;
}

export function buildApi(deps: ApiDeps): FastifyInstance & { broadcast: (e: StreamEvent) => void } {
  const { config, store, onNewOrder, chain } = deps;
  const app = Fastify({ logger: false });
  const sockets = new Set<{ send: (s: string) => void }>();

  const broadcast = (e: StreamEvent) => {
    const msg = JSON.stringify(e);
    for (const s of sockets) {
      try {
        s.send(msg);
      } catch {
        /* dropped socket, cleaned up on close */
      }
    }
  };

  app.register(websocket);
  app.register(async (scoped) => {
    scoped.get("/stream", { websocket: true }, (conn) => {
      sockets.add(conn.socket);
      conn.socket.on("close", () => sockets.delete(conn.socket));
    });
  });

  // Submit a signed order: {order, permit, signature}.
  app.post("/orders", async (req, reply) => {
    let stored: StoredOrder;
    try {
      const body = req.body as Record<string, unknown>;
      const order = orderFromJson(body.order as Record<string, unknown>);
      const permit = permitFromJson(body.permit as Record<string, unknown>);
      const signature = String(body.signature);

      // Structural validation.
      for (const a of [order.maker, order.receiver, order.makerAsset, order.takerAsset, order.allowedSender]) {
        if (!isAddress(a)) return reply.code(400).send({ error: `invalid address: ${a}` });
      }
      if (order.flags !== 0) return reply.code(400).send({ error: "flags must be 0 in V1" });
      if (order.receiver === "0x0000000000000000000000000000000000000000") {
        return reply.code(400).send({ error: "receiver must be nonzero" });
      }
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (order.expiry <= now) return reply.code(400).send({ error: "order already expired" });
      if (permit.deadline !== order.expiry) return reply.code(400).send({ error: "permit.deadline != order.expiry" });
      if (permit.permitted.token.toLowerCase() !== order.makerAsset.toLowerCase()) {
        return reply.code(400).send({ error: "permit token != makerAsset" });
      }
      if (permit.permitted.amount !== order.makingAmount) {
        return reply.code(400).send({ error: "permit amount != makingAmount" });
      }

      // Pair allowlist mirror.
      const pairOk = Object.values(config.pairs).some(
        (p) =>
          (p.base.toLowerCase() === order.makerAsset.toLowerCase() &&
            p.quote.toLowerCase() === order.takerAsset.toLowerCase()) ||
          (p.quote.toLowerCase() === order.makerAsset.toLowerCase() &&
            p.base.toLowerCase() === order.takerAsset.toLowerCase()),
      );
      if (Object.keys(config.pairs).length > 0 && !pairOk) {
        return reply.code(400).send({ error: "pair not supported" });
      }

      // Signature: local Permit2 digest reconstruction (spec 1.7).
      let recovered: string;
      try {
        recovered = recoverMaker(order, permit, signature, config.settlement, config.chainId, config.permit2);
      } catch {
        return reply.code(400).send({ error: "malformed signature" });
      }
      if (getAddress(recovered) !== getAddress(order.maker)) {
        return reply.code(400).send({ error: "signature does not recover to maker" });
      }

      // On-chain mirrors, when wired.
      if (chain) {
        const epoch = await chain.epochOf(order.maker);
        if (order.epoch !== epoch) return reply.code(400).send({ error: `stale epoch (current ${epoch})` });
        const bal = await chain.balanceOf(order.makerAsset, order.maker);
        if (bal < order.makingAmount) return reply.code(400).send({ error: "insufficient maker balance" });
        const allowance = await chain.permit2Allowance(order.makerAsset, order.maker);
        if (allowance < order.makingAmount) return reply.code(400).send({ error: "insufficient Permit2 allowance" });
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
      await store.insertOrder(stored);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    onNewOrder?.(stored);
    broadcast({ type: "order", data: serialize(stored) });
    return reply.code(200).send({ orderHash: stored.orderHash, status: stored.status });
  });

  app.get("/orders", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const pair = q.pair?.includes(",") ? (q.pair.split(",") as [string, string]) : undefined;
    const orders = await store.listOrders({
      maker: q.maker,
      status: q.status as StoredOrder["status"] | undefined,
      pair,
    });
    return orders.map(serialize);
  });

  app.get("/orders/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const order = await store.getOrder(hash);
    if (!order) return reply.code(404).send({ error: "not found" });
    return serialize(order);
  });

  // Soft-cancel in the book only; binding cancellation is on-chain (Permit2
  // invalidateUnorderedNonces or epoch bump).
  app.delete("/orders/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const order = await store.getOrder(hash);
    if (!order) return reply.code(404).send({ error: "not found" });
    await store.setStatus(hash, "cancelled");
    broadcast({ type: "cancel", data: { orderHash: hash } });
    return { orderHash: hash, status: "cancelled" };
  });

  // Aggregated resting depth for a pair "tokenX,tokenY".
  app.get("/orderbook/:pair", async (req, reply) => {
    const { pair } = req.params as { pair: string };
    const [x, y] = pair.split(",");
    if (!x || !y) return reply.code(400).send({ error: "pair must be tokenX,tokenY" });
    const resting = await store.listOrders({ status: "resting", pair: [x, y] });
    const sellX = resting.filter((o) => o.order.makerAsset.toLowerCase() === x.toLowerCase());
    const sellY = resting.filter((o) => o.order.makerAsset.toLowerCase() === y.toLowerCase());
    return {
      pair: [x, y],
      asks: sellX.map(serialize), // selling base X
      bids: sellY.map(serialize), // selling quote Y (buying X)
    };
  });

  app.get("/fills", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const fills = await store.listFills(q.orderHash);
    return fills.map((f) => ({
      ...f,
      amountOut: f.amountOut.toString(),
      makerImprovement: f.makerImprovement.toString(),
      keeperReward: f.keeperReward.toString(),
    }));
  });

  return Object.assign(app, { broadcast });
}

function serialize(o: StoredOrder) {
  return {
    orderHash: o.orderHash,
    order: orderToJson(o.order),
    permit: permitToJson(o.permit),
    signature: o.signature,
    status: o.status,
    createdAt: o.createdAt,
  };
}
