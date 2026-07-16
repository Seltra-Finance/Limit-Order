import pg from "pg";
import type { Fill, OrderStatus, StoredOrder } from "./types.js";
import { orderFromJson, permitFromJson } from "./types.js";
import type { Store } from "./store.js";

/** Postgres-backed Store over schema.sql. Apply the schema before boot:
 *  psql $DATABASE_URL -f schema.sql */
export class PgStore implements Store {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async insertOrder(o: StoredOrder): Promise<void> {
    await this.pool.query(
      `INSERT INTO orders (order_hash, maker, receiver, maker_asset, taker_asset, making_amount,
         taking_amount, salt, epoch, expiry, allowed_sender, flags, permit_nonce, permit_deadline,
         signature, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        o.orderHash,
        o.order.maker,
        o.order.receiver,
        o.order.makerAsset,
        o.order.takerAsset,
        o.order.makingAmount.toString(),
        o.order.takingAmount.toString(),
        o.order.salt.toString(),
        o.order.epoch.toString(),
        o.order.expiry.toString(),
        o.order.allowedSender,
        o.order.flags,
        o.permit.nonce.toString(),
        o.permit.deadline.toString(),
        o.signature,
        o.status,
      ],
    );
  }

  private rowToStored(r: Record<string, unknown>): StoredOrder {
    return {
      orderHash: String(r.order_hash),
      order: orderFromJson({
        maker: r.maker,
        receiver: r.receiver,
        makerAsset: r.maker_asset,
        takerAsset: r.taker_asset,
        makingAmount: r.making_amount,
        takingAmount: r.taking_amount,
        salt: r.salt,
        epoch: r.epoch,
        expiry: r.expiry,
        allowedSender: r.allowed_sender,
        flags: r.flags,
      }),
      permit: permitFromJson({
        permitted: { token: r.maker_asset, amount: r.making_amount },
        nonce: r.permit_nonce,
        deadline: r.permit_deadline,
      }),
      signature: String(r.signature),
      status: r.status as OrderStatus,
      createdAt: new Date(String(r.created_at)).getTime(),
    };
  }

  async getOrder(orderHash: string): Promise<StoredOrder | undefined> {
    const res = await this.pool.query("SELECT * FROM orders WHERE order_hash = $1", [orderHash]);
    return res.rows[0] ? this.rowToStored(res.rows[0]) : undefined;
  }

  async listOrders(filter?: {
    maker?: string;
    pair?: [string, string];
    status?: OrderStatus;
  }): Promise<StoredOrder[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.maker) {
      params.push(filter.maker.toLowerCase());
      clauses.push(`LOWER(maker) = $${params.length}`);
    }
    if (filter?.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filter?.pair) {
      params.push(filter.pair[0].toLowerCase(), filter.pair[1].toLowerCase());
      const i = params.length;
      clauses.push(
        `((LOWER(maker_asset) = $${i - 1} AND LOWER(taker_asset) = $${i}) OR (LOWER(maker_asset) = $${i} AND LOWER(taker_asset) = $${i - 1}))`,
      );
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM orders${where}`, params);
    return res.rows.map((r) => this.rowToStored(r));
  }

  async setStatus(orderHash: string, status: OrderStatus): Promise<void> {
    await this.pool.query("UPDATE orders SET status = $2 WHERE order_hash = $1", [orderHash, status]);
  }

  async insertFill(f: Fill): Promise<void> {
    await this.pool.query(
      `INSERT INTO fills (order_hash, path, adapter_id, keeper, tx_hash, amount_out, maker_improvement, keeper_reward, block_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        f.orderHash,
        f.path,
        f.adapterId ?? null,
        f.keeper,
        f.txHash,
        f.amountOut.toString(),
        f.makerImprovement.toString(),
        f.keeperReward.toString(),
        f.blockNumber,
      ],
    );
  }

  async listFills(orderHash?: string): Promise<Fill[]> {
    const res = orderHash
      ? await this.pool.query("SELECT * FROM fills WHERE order_hash = $1", [orderHash])
      : await this.pool.query("SELECT * FROM fills");
    return res.rows.map((r) => ({
      orderHash: String(r.order_hash),
      path: r.path as "dex" | "p2p",
      adapterId: r.adapter_id == null ? undefined : Number(r.adapter_id),
      keeper: String(r.keeper),
      txHash: String(r.tx_hash),
      amountOut: BigInt(String(r.amount_out)),
      makerImprovement: BigInt(String(r.maker_improvement)),
      keeperReward: BigInt(String(r.keeper_reward)),
      blockNumber: Number(r.block_number),
    }));
  }

  async getEpoch(maker: string): Promise<bigint> {
    const res = await this.pool.query("SELECT epoch FROM maker_epochs WHERE LOWER(maker) = $1", [
      maker.toLowerCase(),
    ]);
    return res.rows[0] ? BigInt(String(res.rows[0].epoch)) : 0n;
  }

  async setEpoch(maker: string, epoch: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO maker_epochs (maker, epoch) VALUES ($1, $2)
       ON CONFLICT (maker) DO UPDATE SET epoch = EXCLUDED.epoch`,
      [maker.toLowerCase(), epoch.toString()],
    );
  }
}
