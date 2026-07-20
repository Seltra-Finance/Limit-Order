import { AbiCoder, type Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import type { SeltraConfig } from "../src/config.js";
import { VenueQuoteCoordinator } from "../src/venues.js";

const TOKEN_A = "0x00000000000000000000000000000000000000A1";
const TOKEN_B = "0x00000000000000000000000000000000000000b2";
const ROUTER = "0x00000000000000000000000000000000000000C3";
const POOL = "0x00000000000000000000000000000000000000D4";

function config(): SeltraConfig {
  return {
    rpcUrl: "http://localhost:8545/",
    chainId: 43114,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    settlement: "0x0000000000000000000000000000000000000011",
    router: ROUTER,
    pairs: { "A/B": { base: TOKEN_A, quote: TOKEN_B } },
    apiPort: 8080,
    apiHost: "127.0.0.1",
    corsOrigin: "https://app.seltra.finance",
    apiRateLimitPerMinute: 120,
    dexVenues: [
      {
        kind: "blackhole",
        name: "Blackhole",
        adapterId: 2,
        routes: { "A/B": { pool: POOL, stable: false, concentrated: true } },
      },
      { kind: "pharaoh", name: "Pharaoh", adapterId: 3, routes: { "A/B": { tickSpacing: 10 } } },
    ],
    dexAdapterId: 0,
    keeperMinProfit: 1n,
    minOrderNotional: 1n,
    maxOrderTtlSeconds: 2_592_000,
    keeperMaxOrderNotional: 1n,
    keeperDailyNotionalCap: 1n,
    wrappedNative: TOKEN_A,
    gasCostBufferBps: 2000,
    quoteDeadlineSeconds: 30,
    maxQuoteAgeMs: 5000,
    pollIntervalMs: 2000,
    indexerStartBlock: 1,
    indexerConfirmations: 2,
    indexerBatchSize: 2000,
  };
}

describe("VenueQuoteCoordinator", () => {
  it("selects the best executable quote and binds the Blackhole pool and router receiver", async () => {
    const coordinator = new VenueQuoteCoordinator(config(), null as unknown as Provider, () => 1_000_000);
    const staticCall = vi.fn(async (...args: unknown[]) => (args[0] === 2 ? 200n : 190n));
    const router = { isRegistered: vi.fn().mockResolvedValue(true), quote: { staticCall } };
    (coordinator as unknown as { router: typeof router }).router = router;

    const best = await coordinator.quoteBest(TOKEN_A, TOKEN_B, 100n);
    expect(best.adapterId).toBe(2);
    expect(best.amountOut).toBe(200n);
    expect(best.quotedAtMs).toBe(1_000_000);

    const blackholeCall = staticCall.mock.calls.find((call) => call[0] === 2)!;
    const [deadline, routes] = AbiCoder.defaultAbiCoder().decode(
      [
        "uint256",
        "tuple(address pair,address from,address to,bool stable,bool concentrated,address receiver)[]",
      ],
      String(blackholeCall[4]),
    );
    expect(deadline).toBe(1030n);
    expect(routes[0].pair.toLowerCase()).toBe(POOL.toLowerCase());
    expect(routes[0].receiver.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(routes[0].concentrated).toBe(true);
  });

  it("skips a paused venue instead of returning its price", async () => {
    const cfg = config();
    const coordinator = new VenueQuoteCoordinator(cfg, null as unknown as Provider, () => 1_000_000);
    const staticCall = vi.fn().mockResolvedValue(190n);
    const router = {
      isRegistered: vi.fn(async (adapterId: number) => adapterId !== 2),
      quote: { staticCall },
    };
    (coordinator as unknown as { router: typeof router }).router = router;
    const best = await coordinator.quoteBest(TOKEN_A, TOKEN_B, 100n);
    expect(best.adapterId).toBe(3);
    expect(staticCall).toHaveBeenCalledOnce();
  });
});
