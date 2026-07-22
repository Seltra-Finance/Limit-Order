/**
 * Gradual-rollout notional caps (revised spec 2.4): while the team runs the
 * only keeper, every fill is bounded by a per-order cap and a per-day cap,
 * tracked per quote token. Caps are raised off-chain as clean fill data
 * accumulates; 0 disables a cap.
 */
export class NotionalCaps {
  private usedByToken = new Map<string, { day: number; amount: bigint }>();

  constructor(
    readonly perOrder: bigint,
    readonly daily: bigint,
    private readonly byToken: Record<string, { perOrder: bigint; daily: bigint }> = {},
  ) {}

  private limits(token: string): { perOrder: bigint; daily: bigint } {
    return this.byToken[token.toLowerCase()] ?? { perOrder: this.perOrder, daily: this.daily };
  }

  private dayOf(nowMs: number): number {
    return Math.floor(nowMs / 86_400_000); // UTC day bucket
  }

  usedToday(token: string, nowMs = Date.now()): bigint {
    const entry = this.usedByToken.get(token.toLowerCase());
    return entry && entry.day === this.dayOf(nowMs) ? entry.amount : 0n;
  }

  /** True if a fill of `amount` (quote units) is within both caps. */
  allows(token: string, amount: bigint, nowMs = Date.now()): boolean {
    const limits = this.limits(token);
    if (limits.perOrder > 0n && amount > limits.perOrder) return false;
    if (limits.daily > 0n && this.usedToday(token, nowMs) + amount > limits.daily) return false;
    return true;
  }

  /** Record a successful fill against the daily budget. */
  record(token: string, amount: bigint, nowMs = Date.now()): void {
    const day = this.dayOf(nowMs);
    const key = token.toLowerCase();
    const entry = this.usedByToken.get(key);
    if (entry && entry.day === day) entry.amount += amount;
    else this.usedByToken.set(key, { day, amount });
  }
}
