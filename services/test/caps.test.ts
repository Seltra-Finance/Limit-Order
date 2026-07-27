import { describe, expect, it } from "vitest";

import { NotionalCaps } from "../src/caps.js";

const USDC = "0x00B766567013BbCe12bF802f6E7C65F6da581Efe";
const USDT = "0x0000000000000000000000000000000000000123";
const DAY = 86_400_000;

describe("NotionalCaps (rollout, spec 2.4)", () => {
  it("per-order cap blocks oversized fills", () => {
    const caps = new NotionalCaps(1_000n * 10n ** 6n, 0n);
    expect(caps.allows(USDC, 1_000n * 10n ** 6n)).toBe(true);
    expect(caps.allows(USDC, 1_000n * 10n ** 6n + 1n)).toBe(false);
  });

  it("daily cap accumulates recorded fills per token", () => {
    const caps = new NotionalCaps(0n, 1_000n * 10n ** 6n);
    const t0 = Date.UTC(2026, 6, 10);

    expect(caps.allows(USDC, 600n * 10n ** 6n, t0)).toBe(true);
    caps.record(USDC, 600n * 10n ** 6n, t0);
    expect(caps.usedToday(USDC, t0)).toBe(600n * 10n ** 6n);

    expect(caps.allows(USDC, 400n * 10n ** 6n, t0)).toBe(true);
    expect(caps.allows(USDC, 400n * 10n ** 6n + 1n, t0)).toBe(false);

    // Independent budget per quote token.
    expect(caps.allows(USDT, 1_000n * 10n ** 6n, t0)).toBe(true);
  });

  it("daily budget resets on the next UTC day", () => {
    const caps = new NotionalCaps(0n, 1_000n * 10n ** 6n);
    const t0 = Date.UTC(2026, 6, 10, 23, 59);
    caps.record(USDC, 1_000n * 10n ** 6n, t0);
    expect(caps.allows(USDC, 1n, t0)).toBe(false);
    expect(caps.allows(USDC, 1_000n * 10n ** 6n, t0 + DAY)).toBe(true);
    expect(caps.usedToday(USDC, t0 + DAY)).toBe(0n);
  });

  it("zero disables a cap", () => {
    const caps = new NotionalCaps(0n, 0n);
    expect(caps.allows(USDC, 10n ** 30n)).toBe(true);
  });

  it("both caps apply together", () => {
    const caps = new NotionalCaps(500n, 800n);
    const t0 = Date.UTC(2026, 6, 10);
    expect(caps.allows(USDC, 501n, t0)).toBe(false); // per-order
    caps.record(USDC, 500n, t0);
    expect(caps.allows(USDC, 400n, t0)).toBe(false); // daily (500+400 > 800)
    expect(caps.allows(USDC, 300n, t0)).toBe(true);
  });

  it("applies native-unit limits per quote token", () => {
    const caps = new NotionalCaps(0n, 0n, {
      [USDC.toLowerCase()]: { perOrder: 5_000n * 10n ** 6n, daily: 50_000n * 10n ** 6n },
      [USDT.toLowerCase()]: { perOrder: 500n * 10n ** 18n, daily: 5_000n * 10n ** 18n },
    });
    expect(caps.allows(USDC, 5_001n * 10n ** 6n)).toBe(false);
    expect(caps.allows(USDT, 500n * 10n ** 18n)).toBe(true);
    expect(caps.allows(USDT, 501n * 10n ** 18n)).toBe(false);
  });
});
