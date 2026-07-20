import type { Provider } from "ethers";
import type { SeltraConfig } from "./config.js";
import type { Order, PermitTransferFrom } from "./types.js";
import { VenueQuoteCoordinator } from "./venues.js";

/**
 * Market orders (frontend/SDK concern, no contract changes).
 *
 * A Seltra "market order" is a marketable limit order: takingAmount is set to
 * the current quote minus a slippage tolerance, with a short expiry. The
 * watcher flags it fillable immediately and the keeper fills it on the next
 * tick, or it can match P2P for zero slippage. All-or-nothing + short expiry
 * gives fill-or-kill semantics: it fills within seconds or expires and the
 * frontend re-quotes.
 *
 * Unlike a raw AMM swap, the slippage buffer is not dead headroom: whatever
 * the fill realizes above the limit is surplus, and the maker gets
 * makerSurplusBps (70%) of it back as price improvement.
 */

export interface MarketOrderParams {
  maker: string;
  /** proceeds destination; defaults to maker */
  receiver?: string;
  makerAsset: string;
  takerAsset: string;
  makingAmount: bigint;
  /** current quoted output for makingAmount (from quoteMarketOut / router.quote) */
  quotedOut: bigint;
  /** slippage tolerance below the quote, in bps (default 50 = 0.5%) */
  slippageBps?: number;
  /** seconds until the order dies unfilled (default 60) */
  ttlSeconds?: number;
  /** maker's current epoch (0 if never mass-cancelled) */
  epoch?: bigint;
  /** unix ms clock, injectable for tests */
  nowMs?: number;
}

/** Random 2^64-range Permit2 unordered nonce; collision-free in practice. */
export function randomNonce(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

/**
 * Build a marketable limit order + matching permit, ready for
 * typedDataForSigning / wallet.signTypedData and POST /orders.
 */
export function buildMarketOrder(p: MarketOrderParams): { order: Order; permit: PermitTransferFrom } {
  const slippageBps = BigInt(p.slippageBps ?? 50);
  if (slippageBps < 0n || slippageBps >= 10_000n) throw new Error("slippageBps must be in [0, 10000)");
  if (p.quotedOut <= 0n) throw new Error("quotedOut must be positive");

  const takingAmount = (p.quotedOut * (10_000n - slippageBps)) / 10_000n;
  if (takingAmount === 0n) throw new Error("slippage floor rounds to zero output");

  const nowMs = p.nowMs ?? Date.now();
  const expiry = BigInt(Math.floor(nowMs / 1000) + (p.ttlSeconds ?? 60));

  const order: Order = {
    maker: p.maker,
    receiver: p.receiver ?? p.maker,
    makerAsset: p.makerAsset,
    takerAsset: p.takerAsset,
    makingAmount: p.makingAmount,
    takingAmount,
    salt: BigInt(nowMs),
    epoch: p.epoch ?? 0n,
    expiry,
    allowedSender: "0x0000000000000000000000000000000000000000",
    flags: 0,
  };
  const permit: PermitTransferFrom = {
    permitted: { token: p.makerAsset, amount: p.makingAmount },
    nonce: randomNonce(),
    deadline: expiry,
  };
  return { order, permit };
}

/** Fetch the live executable quote for a market order's size. */
export async function quoteMarketOut(
  config: SeltraConfig,
  provider: Provider,
  makerAsset: string,
  takerAsset: string,
  makingAmount: bigint,
): Promise<bigint> {
  return (await new VenueQuoteCoordinator(config, provider).quoteBest(
    makerAsset,
    takerAsset,
    makingAmount,
  )).amountOut;
}
