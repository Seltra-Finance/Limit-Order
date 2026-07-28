import { formatUnits } from "ethers";

import type { PairConfig, SeltraConfig } from "./config.js";
import type { Fill, StoredOrder } from "./types.js";

export interface PublicPair {
  configName: string;
  id: string;
  baseAsset: string;
  quoteAsset: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  pricePrecision: number;
  amountPrecision: number;
  referenceBaseAmount: string;
}

export interface PublicFillInfo {
  path: "dex" | "p2p";
  adapterId?: number;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  makerImprovement: string;
  keeperReward: string;
  amountOut: string;
}

export interface PublicOrderRecord {
  orderHash: string;
  chainId: number;
  pair: string;
  side: "buy" | "sell";
  price: string;
  baseAmount: string;
  status: "resting" | "unfillable" | "filled" | "cancelled" | "expired";
  softCancelled: boolean;
  createdAt: number;
  updatedAt: number;
  order: Record<string, string | number>;
  permit: Record<string, unknown>;
  signature: string;
  fill?: PublicFillInfo;
}

export interface ProtocolStats {
  /**
   * Present for a scoped request, or when every represented fill shares one
   * quote token. Mixed-quote all-market totals are intentionally null.
   */
  totalVolumeQuote: string | null;
  quoteSymbol: string | null;
  volumeByQuote: { quoteSymbol: string; amount: string }[];
  ordersFilled: number;
  ordersResting: number;
  avgImprovementBps: number | null;
  p2pMatchRateBps: number | null;
}

export interface BookLevel {
  price: number;
  size: number;
  total: number;
}

export interface BookSnapshot {
  pair: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export interface LevelChange {
  price: number;
  size: number;
}

export interface TradePrint {
  time: number;
  price: number;
  size: number;
  side: "buy" | "sell";
  path: "dex" | "p2p";
  txHash: string;
  orderHash: string;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TOKEN_METADATA: Record<
  string,
  { decimals: number; amountPrecision: number; referenceBaseAmount: string }
> = {
  WAVAX: { decimals: 18, amountPrecision: 4, referenceBaseAmount: "1" },
  USDC: { decimals: 6, amountPrecision: 2, referenceBaseAmount: "100" },
  USDt: { decimals: 6, amountPrecision: 2, referenceBaseAmount: "100" },
  "WETH.e": { decimals: 18, amountPrecision: 5, referenceBaseAmount: "0.01" },
  "BTC.b": { decimals: 8, amountPrecision: 6, referenceBaseAmount: "0.001" },
};

export const ALLOWED_CANDLE_INTERVALS = new Set([60, 300, 900, 3_600, 14_400, 86_400]);

export function publicPairs(config: SeltraConfig): PublicPair[] {
  return Object.entries(config.pairs).map(([configName, pair]) => publicPair(configName, pair));
}

export function resolvePublicPair(config: SeltraConfig, value: string): PublicPair | undefined {
  const pairs = publicPairs(config);
  if (value.includes(",")) {
    const [first, second] = value.split(",");
    if (!first || !second) return undefined;
    const from = first.toLowerCase();
    const to = second.toLowerCase();
    return pairs.find((pair) => {
      const base = pair.baseAsset.toLowerCase();
      const quote = pair.quoteAsset.toLowerCase();
      return (base === from && quote === to) || (base === to && quote === from);
    });
  }
  const normalized = value.toLowerCase();
  return pairs.find(
    (pair) => pair.id.toLowerCase() === normalized || pair.configName.toLowerCase() === normalized,
  );
}

export function pairForOrder(config: SeltraConfig, order: StoredOrder): PublicPair | undefined {
  const maker = order.order.makerAsset.toLowerCase();
  const taker = order.order.takerAsset.toLowerCase();
  return publicPairs(config).find((pair) => {
    const base = pair.baseAsset.toLowerCase();
    const quote = pair.quoteAsset.toLowerCase();
    return (base === maker && quote === taker) || (base === taker && quote === maker);
  });
}

export function serializePublicOrder(
  config: SeltraConfig,
  stored: StoredOrder,
  fill?: Fill,
  fillTimestamp?: number,
): PublicOrderRecord {
  const pair = pairForOrder(config, stored);
  if (!pair) throw new Error(`order ${stored.orderHash} is for an unconfigured pair`);
  const side = stored.order.makerAsset.toLowerCase() === pair.baseAsset.toLowerCase() ? "sell" : "buy";
  const { price, size } = priceAndSize(stored, pair, side);
  const publicFill = fill
    ? {
        path: fill.path,
        ...(fill.adapterId === undefined ? {} : { adapterId: fill.adapterId }),
        txHash: fill.txHash,
        blockNumber: fill.blockNumber,
        timestamp: fillTimestamp ?? Math.floor(stored.createdAt / 1_000),
        makerImprovement: fill.makerImprovement.toString(),
        keeperReward: fill.keeperReward.toString(),
        amountOut: fill.amountOut.toString(),
      }
    : undefined;
  return {
    orderHash: stored.orderHash,
    chainId: config.chainId,
    pair: pair.id,
    side,
    price: price.toFixed(Math.max(pair.pricePrecision, 6)),
    baseAmount: size.toString(),
    status: stored.status === "fillable" ? "resting" : stored.status,
    softCancelled: false,
    createdAt: stored.createdAt,
    updatedAt: publicFill ? publicFill.timestamp * 1_000 : stored.createdAt,
    order: {
      maker: stored.order.maker,
      receiver: stored.order.receiver,
      makerAsset: stored.order.makerAsset,
      takerAsset: stored.order.takerAsset,
      makingAmount: stored.order.makingAmount.toString(),
      takingAmount: stored.order.takingAmount.toString(),
      salt: stored.order.salt.toString(),
      epoch: stored.order.epoch.toString(),
      expiry: stored.order.expiry.toString(),
      allowedSender: stored.order.allowedSender,
      flags: stored.order.flags,
    },
    permit: {
      permitted: {
        token: stored.permit.permitted.token,
        amount: stored.permit.permitted.amount.toString(),
      },
      nonce: stored.permit.nonce.toString(),
      deadline: stored.permit.deadline.toString(),
    },
    signature: stored.signature,
    ...(publicFill ? { fill: publicFill } : {}),
  };
}

export function buildBook(records: StoredOrder[], pair: PublicPair): BookSnapshot {
  const bidLevels = new Map<number, number>();
  const askLevels = new Map<number, number>();
  for (const record of records) {
    const side = record.order.makerAsset.toLowerCase() === pair.baseAsset.toLowerCase() ? "sell" : "buy";
    const { price, size } = priceAndSize(record, pair, side);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) continue;
    const level = Number(price.toFixed(pair.pricePrecision));
    const target = side === "buy" ? bidLevels : askLevels;
    target.set(level, (target.get(level) ?? 0) + size);
  }
  return {
    pair: pair.id,
    bids: levels(bidLevels, true),
    asks: levels(askLevels, false),
    ts: Date.now(),
  };
}

export function diffBookLevels(
  previous: BookSnapshot,
  next: BookSnapshot,
): { bids: LevelChange[]; asks: LevelChange[] } {
  const diff = (before: BookLevel[], after: BookLevel[]): LevelChange[] => {
    const remaining = new Map(before.map((level) => [level.price, level.size]));
    const changes: LevelChange[] = [];
    for (const level of after) {
      if (remaining.get(level.price) !== level.size) changes.push({ price: level.price, size: level.size });
      remaining.delete(level.price);
    }
    for (const price of remaining.keys()) changes.push({ price, size: 0 });
    return changes;
  };
  return { bids: diff(previous.bids, next.bids), asks: diff(previous.asks, next.asks) };
}

export function buildTrades(records: PublicOrderRecord[], limit: number): TradePrint[] {
  return dedupeP2p(records)
    .map((record): TradePrint | undefined => {
      if (!record.fill) return undefined;
      const priced = effectiveFill(record);
      if (!priced) return undefined;
      return {
        time: record.fill.timestamp,
        price: priced.price,
        size: priced.baseVolume,
        side: record.side,
        path: record.fill.path,
        txHash: record.fill.txHash,
        orderHash: record.orderHash,
      };
    })
    .filter((trade): trade is TradePrint => trade !== undefined)
    .sort((a, b) => b.time - a.time)
    .slice(0, limit);
}

export function buildCandles(records: PublicOrderRecord[], intervalSeconds: number): Candle[] {
  const fills = buildTrades(records, Number.MAX_SAFE_INTEGER).sort((a, b) => a.time - b.time);
  const buckets = new Map<number, Candle>();
  for (const fill of fills) {
    const bucket = Math.floor(fill.time / intervalSeconds) * intervalSeconds;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        open: fill.price,
        high: fill.price,
        low: fill.price,
        close: fill.price,
        volume: fill.size,
      });
    } else {
      existing.high = Math.max(existing.high, fill.price);
      existing.low = Math.min(existing.low, fill.price);
      existing.close = fill.price;
      existing.volume += fill.size;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export function protocolStats(
  records: PublicOrderRecord[],
  pairs: PublicPair[],
  selectedPair?: PublicPair,
): ProtocolStats {
  const scopedRecords = selectedPair
    ? records.filter((record) => record.pair === selectedPair.id)
    : records;
  const filled = scopedRecords.filter((record) => record.status === "filled");
  const improvements = filled
    .filter((record) => record.fill)
    .map((record) => {
      const taking = BigInt(record.order.takingAmount);
      return taking === 0n ? 0 : Number((BigInt(record.fill!.makerImprovement) * 10_000n) / taking);
    });
  const p2p = filled.filter((record) => record.fill?.path === "p2p").length;

  // Quote volume is meaningful only within one denomination. Keep mixed
  // all-market totals separated instead of adding USDC, WAVAX and USDt.
  const pairsById = new Map(pairs.map((pair) => [pair.id, pair]));
  const volumeByQuoteToken = new Map<string, { amount: bigint; decimals: number }>();
  for (const record of dedupeP2p(filled)) {
    const pair = pairsById.get(record.pair);
    if (!pair) continue;
    const quoteAmount = BigInt(
      record.side === "buy" ? record.order.makingAmount : record.order.takingAmount,
    );
    const current = volumeByQuoteToken.get(pair.quoteSymbol);
    volumeByQuoteToken.set(pair.quoteSymbol, {
      amount: (current?.amount ?? 0n) + quoteAmount,
      decimals: pair.quoteDecimals,
    });
  }
  const volumeByQuote = [...volumeByQuoteToken.entries()]
    .map(([quoteSymbol, volume]) => ({
      quoteSymbol,
      amount: formatUnits(volume.amount, volume.decimals),
    }))
    .sort((a, b) => a.quoteSymbol.localeCompare(b.quoteSymbol));
  const singleQuote = selectedPair?.quoteSymbol
    ?? (volumeByQuoteToken.size === 1 ? volumeByQuote[0]?.quoteSymbol : undefined);
  const singleVolume = singleQuote
    ? volumeByQuoteToken.get(singleQuote) ?? {
        amount: 0n,
        decimals: selectedPair?.quoteDecimals ?? 0,
      }
    : undefined;

  return {
    totalVolumeQuote: singleVolume
      ? formatUnits(singleVolume.amount, singleVolume.decimals)
      : null,
    quoteSymbol: singleQuote ?? null,
    volumeByQuote: selectedPair ? [] : volumeByQuote,
    ordersFilled: filled.length,
    ordersResting: scopedRecords.filter(
      (record) => record.status === "resting" && !record.softCancelled,
    ).length,
    avgImprovementBps:
      improvements.length === 0
        ? null
        : Math.round(improvements.reduce((sum, value) => sum + value, 0) / improvements.length),
    p2pMatchRateBps: filled.length === 0 ? null : Math.round((p2p / filled.length) * 10_000),
  };
}

function publicPair(configName: string, pair: PairConfig): PublicPair {
  const [baseSymbol = "BASE", quoteSymbol = "QUOTE"] = configName.split("/");
  const base = TOKEN_METADATA[baseSymbol] ?? {
    decimals: 18,
    amountPrecision: 4,
    referenceBaseAmount: "1",
  };
  const quote = TOKEN_METADATA[quoteSymbol] ?? {
    decimals: 18,
    amountPrecision: 4,
    referenceBaseAmount: "1",
  };
  return {
    configName,
    id: `${baseSymbol}-${quoteSymbol}`,
    baseAsset: pair.base,
    quoteAsset: pair.quote,
    baseSymbol,
    quoteSymbol,
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
    pricePrecision: quoteSymbol === "USDC" || quoteSymbol === "USDt" ? 2 : 4,
    amountPrecision: base.amountPrecision,
    referenceBaseAmount: base.referenceBaseAmount,
  };
}

function priceAndSize(
  record: StoredOrder,
  pair: PublicPair,
  side: "buy" | "sell",
): { price: number; size: number } {
  if (side === "sell") {
    const size = Number(formatUnits(record.order.makingAmount, pair.baseDecimals));
    const quote = Number(formatUnits(record.order.takingAmount, pair.quoteDecimals));
    return { price: quote / size, size };
  }
  const size = Number(formatUnits(record.order.takingAmount, pair.baseDecimals));
  const quote = Number(formatUnits(record.order.makingAmount, pair.quoteDecimals));
  return { price: quote / size, size };
}

function levels(map: Map<number, number>, descending: boolean): BookLevel[] {
  const sorted = [...map.entries()].sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  let total = 0;
  return sorted.map(([price, size]) => {
    total += size;
    return { price, size, total };
  });
}

function effectiveFill(record: PublicOrderRecord): { price: number; baseVolume: number } | undefined {
  if (!record.fill) return undefined;
  const pairDecimals = pairDecimalsFromRecord(record);
  const improvement = BigInt(record.fill.makerImprovement);
  if (record.side === "sell") {
    const base = Number(formatUnits(BigInt(record.order.makingAmount), pairDecimals.base));
    const quote = Number(
      formatUnits(BigInt(record.order.takingAmount) + improvement, pairDecimals.quote),
    );
    return base > 0 ? { price: quote / base, baseVolume: base } : undefined;
  }
  const quote = Number(formatUnits(BigInt(record.order.makingAmount), pairDecimals.quote));
  const base = Number(formatUnits(BigInt(record.order.takingAmount) + improvement, pairDecimals.base));
  return base > 0 ? { price: quote / base, baseVolume: base } : undefined;
}

function pairDecimalsFromRecord(record: PublicOrderRecord): { base: number; quote: number } {
  const [baseSymbol = "BASE", quoteSymbol = "QUOTE"] = record.pair.split("-");
  return {
    base: (TOKEN_METADATA[baseSymbol] ?? { decimals: 18 }).decimals,
    quote: (TOKEN_METADATA[quoteSymbol] ?? { decimals: 18 }).decimals,
  };
}

function dedupeP2p(records: PublicOrderRecord[]): PublicOrderRecord[] {
  const byTransaction = new Map<string, PublicOrderRecord>();
  const result: PublicOrderRecord[] = [];
  for (const record of records) {
    if (record.fill?.path !== "p2p") {
      result.push(record);
      continue;
    }
    const existing = byTransaction.get(record.fill.txHash);
    if (!existing) {
      byTransaction.set(record.fill.txHash, record);
      result.push(record);
    } else if (existing.side !== "sell" && record.side === "sell") {
      result[result.indexOf(existing)] = record;
      byTransaction.set(record.fill.txHash, record);
    }
  }
  return result;
}
