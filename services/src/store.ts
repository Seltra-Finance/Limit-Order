import type { Fill, OrderStatus, StoredOrder } from "./types.js";

/** Persistence interface (spec 1.7). MemoryStore for dev/tests; PgStore in
 *  pgStore.ts implements the same interface over the schema in schema.sql. */
export interface Store {
  insertOrder(order: StoredOrder): Promise<void>;
  getOrder(orderHash: string): Promise<StoredOrder | undefined>;
  listOrders(filter?: { maker?: string; pair?: [string, string]; status?: OrderStatus }): Promise<StoredOrder[]>;
  setStatus(orderHash: string, status: OrderStatus): Promise<void>;
  /** Returns true only when a new event-backed fill was inserted. */
  insertFill(fill: Fill): Promise<boolean>;
  listFills(orderHash?: string): Promise<Fill[]>;
  getEpoch(maker: string): Promise<bigint>;
  setEpoch(maker: string, epoch: bigint): Promise<void>;
  getIndexerCheckpoint(key: string): Promise<number | undefined>;
  setIndexerCheckpoint(key: string, blockNumber: number): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryStore implements Store {
  private orders = new Map<string, StoredOrder>();
  private fills: Fill[] = [];
  private epochs = new Map<string, bigint>();
  private checkpoints = new Map<string, number>();

  async insertOrder(order: StoredOrder): Promise<void> {
    if (this.orders.has(order.orderHash)) throw new Error("duplicate order");
    this.orders.set(order.orderHash, order);
  }

  async getOrder(orderHash: string): Promise<StoredOrder | undefined> {
    return this.orders.get(orderHash.toLowerCase()) ?? this.orders.get(orderHash);
  }

  async listOrders(filter?: {
    maker?: string;
    pair?: [string, string];
    status?: OrderStatus;
  }): Promise<StoredOrder[]> {
    let all = [...this.orders.values()];
    if (filter?.maker) all = all.filter((o) => o.order.maker.toLowerCase() === filter.maker!.toLowerCase());
    if (filter?.status) all = all.filter((o) => o.status === filter.status);
    if (filter?.pair) {
      const [x, y] = filter.pair.map((t) => t.toLowerCase());
      all = all.filter((o) => {
        const mk = o.order.makerAsset.toLowerCase();
        const tk = o.order.takerAsset.toLowerCase();
        return (mk === x && tk === y) || (mk === y && tk === x);
      });
    }
    return all;
  }

  async setStatus(orderHash: string, status: OrderStatus): Promise<void> {
    const o = this.orders.get(orderHash);
    if (o) o.status = status;
  }

  async insertFill(fill: Fill): Promise<boolean> {
    const duplicate = this.fills.some(
      (existing) =>
        existing.orderHash.toLowerCase() === fill.orderHash.toLowerCase()
        && existing.txHash.toLowerCase() === fill.txHash.toLowerCase()
        && existing.path === fill.path,
    );
    if (duplicate) return false;
    this.fills.push(fill);
    return true;
  }

  async listFills(orderHash?: string): Promise<Fill[]> {
    return orderHash ? this.fills.filter((f) => f.orderHash === orderHash) : [...this.fills];
  }

  async getEpoch(maker: string): Promise<bigint> {
    return this.epochs.get(maker.toLowerCase()) ?? 0n;
  }

  async setEpoch(maker: string, epoch: bigint): Promise<void> {
    this.epochs.set(maker.toLowerCase(), epoch);
  }

  async getIndexerCheckpoint(key: string): Promise<number | undefined> {
    return this.checkpoints.get(key);
  }

  async setIndexerCheckpoint(key: string, blockNumber: number): Promise<void> {
    this.checkpoints.set(key, blockNumber);
  }

  async close(): Promise<void> {}
}
