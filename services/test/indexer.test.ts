import type { Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import type { SeltraConfig } from "../src/config.js";
import { Indexer } from "../src/indexer.js";
import { MemoryStore } from "../src/store.js";

const SETTLEMENT = "0x0000000000000000000000000000000000000011";
const config: SeltraConfig = {
  rpcUrl: "http://localhost:8545/",
  chainId: 43113,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  settlement: SETTLEMENT,
  router: "0x0000000000000000000000000000000000000022",
  pairs: {},
  apiPort: 8080,
  apiHost: "127.0.0.1",
  corsOrigin: "http://localhost:3000",
  apiRateLimitPerMinute: 120,
  dexVenues: [{ kind: "mock", name: "Mock", adapterId: 0 }],
  dexAdapterId: 0,
  keeperMinProfit: 0n,
  maxOrderTtlSeconds: 2_592_000,
  wrappedNative: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
  gasCostBufferBps: 2000,
  quoteDeadlineSeconds: 30,
  maxQuoteAgeMs: 5000,
  pollIntervalMs: 60_000,
  indexerStartBlock: 100,
  indexerConfirmations: 2,
  indexerBatchSize: 3,
};

function emptyContract() {
  return {
    filters: {
      OrderFilledDEX: vi.fn(),
      OrderFilledP2P: vi.fn(),
      EpochIncremented: vi.fn(),
      UnorderedNonceInvalidation: vi.fn(),
      FillsPaused: vi.fn(),
      FillsUnpaused: vi.fn(),
    },
    queryFilter: vi.fn().mockResolvedValue([]),
  };
}

describe("Indexer checkpoints", () => {
  it("scans finalized history in bounded ranges and persists progress", async () => {
    const provider = { getBlockNumber: vi.fn().mockResolvedValue(108) } as unknown as Provider;
    const store = new MemoryStore();
    const indexer = new Indexer(config, provider, store);
    const settlement = emptyContract();
    const permit2 = emptyContract();
    (indexer as unknown as { settlement: typeof settlement }).settlement = settlement;
    (indexer as unknown as { permit2: typeof permit2 }).permit2 = permit2;

    await indexer.start();
    indexer.stop();

    expect(await store.getIndexerCheckpoint(`settlement:43113:${SETTLEMENT.toLowerCase()}`)).toBe(106);
    expect(settlement.queryFilter.mock.calls.map((call) => call.slice(1))).toContainEqual([100, 102]);
    expect(settlement.queryFilter.mock.calls.map((call) => call.slice(1))).toContainEqual([103, 105]);
    expect(settlement.queryFilter.mock.calls.map((call) => call.slice(1))).toContainEqual([106, 106]);

    const resumed = new Indexer(config, provider, store);
    const resumedSettlement = emptyContract();
    const resumedPermit2 = emptyContract();
    (resumed as unknown as { settlement: typeof resumedSettlement }).settlement = resumedSettlement;
    (resumed as unknown as { permit2: typeof resumedPermit2 }).permit2 = resumedPermit2;
    await resumed.start();
    resumed.stop();
    expect(resumedSettlement.queryFilter).not.toHaveBeenCalled();
  });

  it("deduplicates replayed fill identities in the store", async () => {
    const store = new MemoryStore();
    const fill = {
      orderHash: "0xabc",
      path: "dex" as const,
      adapterId: 2,
      keeper: "0xkeeper",
      txHash: "0xtx",
      amountOut: 1n,
      makerImprovement: 0n,
      keeperReward: 0n,
      blockNumber: 100,
    };
    expect(await store.insertFill(fill)).toBe(true);
    expect(await store.insertFill(fill)).toBe(false);
    expect(await store.listFills()).toHaveLength(1);
  });
});
