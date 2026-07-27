import type { StoredOrder } from "./types.js";

/**
 * Continuous matching engine (revised spec 1.8). V1 match condition, evaluated
 * with the exact integer math the settlement contract uses on-chain (bigint,
 * no floats):
 *   - opposite-asset mirror: a.makerAsset == b.takerAsset && a.takerAsset == b.makerAsset
 *   - exact size (X leg):    a.makingAmount == b.takingAmount
 *   - cross condition:       b.makingAmount >= a.takingAmount
 * Convention: `a` sells base X for quote Y; `b` sells quote Y for base X
 * (fillOrderP2P must be called with the orders in this position).
 */

export interface Match {
  a: StoredOrder;
  b: StoredOrder;
  /** crossed spread in quote token Y: b.makingAmount - a.takingAmount */
  surplus: bigint;
}

/** Mirrors the overflow-safe reduction used by SeltraSettlement. */
export function crosses(a: StoredOrder["order"], b: StoredOrder["order"]): boolean {
  return b.makingAmount >= a.takingAmount;
}

export function isMirrorPair(a: StoredOrder["order"], b: StoredOrder["order"]): boolean {
  return (
    a.makerAsset.toLowerCase() === b.takerAsset.toLowerCase() &&
    a.takerAsset.toLowerCase() === b.makerAsset.toLowerCase()
  );
}

export function isExactSize(a: StoredOrder["order"], b: StoredOrder["order"]): boolean {
  return a.makingAmount === b.takingAmount;
}

export function matchable(a: StoredOrder, b: StoredOrder): boolean {
  return (
    a.status === "resting" &&
    b.status === "resting" &&
    a.orderHash !== b.orderHash &&
    isMirrorPair(a.order, b.order) &&
    isExactSize(a.order, b.order) &&
    crosses(a.order, b.order)
  );
}

export class MatchingEngine {
  /** resting orders by hash; the engine owns match bookkeeping only, order
   *  lifecycle status lives in the store. */
  private resting = new Map<string, StoredOrder>();
  /** orders currently part of an emitted, unresolved match: at most one match
   *  per order (spec 1.8). */
  private inFlight = new Set<string>();

  constructor(private readonly onMatch: (m: Match) => void) {}

  /** Add or refresh a resting order and try to match it. */
  add(order: StoredOrder): boolean {
    if (order.status !== "resting") return false;
    this.resting.set(order.orderHash, order);
    return this.evaluate(order);
  }

  remove(orderHash: string): void {
    this.resting.delete(orderHash);
    this.inFlight.delete(orderHash);
  }

  /** On on-chain failure (nonce consumed, epoch bumped, race lost), release
   *  both sides and re-evaluate what remains (spec 1.8). */
  releaseMatch(m: Match, aStillResting: boolean, bStillResting: boolean, reevaluate = true): void {
    this.inFlight.delete(m.a.orderHash);
    this.inFlight.delete(m.b.orderHash);
    if (!aStillResting) this.resting.delete(m.a.orderHash);
    if (!bStillResting) this.resting.delete(m.b.orderHash);
    if (reevaluate) {
      if (aStillResting) this.evaluate(m.a);
      else if (bStillResting) this.evaluate(m.b);
    }
  }

  settleMatch(m: Match): void {
    this.remove(m.a.orderHash);
    this.remove(m.b.orderHash);
  }

  /** Scan the opposite side for the best crossing counterparty. "Best" is the
   *  largest quote-token surplus; ties broken by earliest submission. */
  private evaluate(incoming: StoredOrder): boolean {
    if (this.inFlight.has(incoming.orderHash)) return false;

    let best: { counter: StoredOrder; surplus: bigint } | undefined;
    for (const candidate of this.resting.values()) {
      if (this.inFlight.has(candidate.orderHash)) continue;
      const pair = this.orient(incoming, candidate);
      if (!pair) continue;
      if (!matchable(pair.a, pair.b)) continue;
      const surplus = pair.b.order.makingAmount - pair.a.order.takingAmount;
      if (
        best === undefined ||
        surplus > best.surplus ||
        (surplus === best.surplus && candidate.createdAt < best.counter.createdAt)
      ) {
        best = { counter: candidate, surplus };
      }
    }
    if (!best) return false;

    const oriented = this.orient(incoming, best.counter)!;
    this.inFlight.add(incoming.orderHash);
    this.inFlight.add(best.counter.orderHash);
    this.onMatch({ a: oriented.a, b: oriented.b, surplus: best.surplus });
    return true;
  }

  /**
   * Put two orders into the (a = base seller, b = quote seller) convention the
   * settlement contract expects, using the exact-size X leg to decide which
   * side is base. Returns undefined if the two orders are not a mirror pair.
   */
  private orient(x: StoredOrder, y: StoredOrder): { a: StoredOrder; b: StoredOrder } | undefined {
    if (!isMirrorPair(x.order, y.order)) return undefined;
    // Try x as base seller (a); fall back to y as base seller.
    if (isExactSize(x.order, y.order)) return { a: x, b: y };
    if (isExactSize(y.order, x.order)) return { a: y, b: x };
    return undefined;
  }
}
