/** Seltra Order (revised spec 1.2). Signed exclusively as a Permit2 witness. */
export interface Order {
  maker: string;
  receiver: string;
  makerAsset: string;
  takerAsset: string;
  makingAmount: bigint;
  takingAmount: bigint;
  salt: bigint;
  epoch: bigint;
  expiry: bigint; // uint40, unix seconds
  allowedSender: string;
  flags: number; // must be 0 in V1
}

/** Permit2 PermitTransferFrom carried alongside the order (spec 1.2). */
export interface PermitTransferFrom {
  permitted: { token: string; amount: bigint };
  nonce: bigint;
  deadline: bigint;
}

/** What a maker submits: POST /orders {order, permit, signature}. */
export interface SignedOrder {
  order: Order;
  permit: PermitTransferFrom;
  signature: string;
}

export type OrderStatus = "resting" | "fillable" | "filled" | "cancelled" | "expired";

export interface StoredOrder extends SignedOrder {
  orderHash: string;
  status: OrderStatus;
  createdAt: number;
}

export interface Fill {
  orderHash: string;
  path: "dex" | "p2p";
  /** Registered venue identifier for DEX fills; absent for P2P fills. */
  adapterId?: number;
  keeper: string;
  txHash: string;
  amountOut: bigint;
  makerImprovement: bigint;
  keeperReward: bigint;
  blockNumber: number;
}

/** JSON (de)serialization helpers: bigints travel as decimal strings. */
export function orderToJson(o: Order): Record<string, string | number> {
  return {
    maker: o.maker,
    receiver: o.receiver,
    makerAsset: o.makerAsset,
    takerAsset: o.takerAsset,
    makingAmount: o.makingAmount.toString(),
    takingAmount: o.takingAmount.toString(),
    salt: o.salt.toString(),
    epoch: o.epoch.toString(),
    expiry: o.expiry.toString(),
    allowedSender: o.allowedSender,
    flags: o.flags,
  };
}

export function orderFromJson(j: Record<string, unknown>): Order {
  return {
    maker: String(j.maker),
    receiver: String(j.receiver),
    makerAsset: String(j.makerAsset),
    takerAsset: String(j.takerAsset),
    makingAmount: BigInt(String(j.makingAmount)),
    takingAmount: BigInt(String(j.takingAmount)),
    salt: BigInt(String(j.salt)),
    epoch: BigInt(String(j.epoch)),
    expiry: BigInt(String(j.expiry)),
    allowedSender: String(j.allowedSender),
    flags: Number(j.flags),
  };
}

export function permitFromJson(j: Record<string, unknown>): PermitTransferFrom {
  const permitted = j.permitted as Record<string, unknown>;
  return {
    permitted: { token: String(permitted.token), amount: BigInt(String(permitted.amount)) },
    nonce: BigInt(String(j.nonce)),
    deadline: BigInt(String(j.deadline)),
  };
}

export function permitToJson(p: PermitTransferFrom): Record<string, unknown> {
  return {
    permitted: { token: p.permitted.token, amount: p.permitted.amount.toString() },
    nonce: p.nonce.toString(),
    deadline: p.deadline.toString(),
  };
}
