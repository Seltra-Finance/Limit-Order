import { Interface, type Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import type { SeltraConfig } from "../src/config.js";
import { SETTLEMENT_ABI } from "../src/abi.js";
import { Indexer } from "../src/indexer.js";
import { MemoryStore } from "../src/store.js";

const SETTLEMENT = "0x0000000000000000000000000000000000000011";
const config: SeltraConfig = {
  rpcUrl: "http://localhost:8545/",
  quoteRpcUrl: "http://localhost:8545/",
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
  watcherPollIntervalMs: 60_000,
  pollIntervalMs: 60_000,
  watcherMaxQuoteGroupsPerTick: 32,
  publicQuoteCacheMs: 5_000,
  indexerStartBlock: 100,
  indexerConfirmations: 2,
  indexerBatchSize: 3,
};

describe("Indexer checkpoints", () => {
  it("scans finalized history in bounded ranges and persists progress", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const provider = {
      getBlockNumber: vi.fn().mockResolvedValue(108),
      getLogs,
    } as unknown as Provider;
    const store = new MemoryStore();
    const indexer = new Indexer(config, provider, store);

    await indexer.start();
    indexer.stop();

    expect(await store.getIndexerCheckpoint(`settlement:43113:${SETTLEMENT.toLowerCase()}`)).toBe(106);
    expect(getLogs.mock.calls.map(([filter]) => [filter.fromBlock, filter.toBlock])).toEqual([
      [100, 102],
      [103, 105],
      [106, 106],
    ]);
    expect(getLogs).toHaveBeenCalledTimes(3);
    expect(indexer.rpcBudgetSnapshot()).toEqual({
      combinedLogRequests: 3,
      overlappingTicksSkipped: 0,
    });
    expect(getLogs.mock.calls[0]![0].address).toEqual([config.settlement, config.permit2]);
    expect(getLogs.mock.calls[0]![0].topics[0]).toHaveLength(6);

    const resumed = new Indexer(config, provider, store);
    getLogs.mockClear();
    await resumed.start();
    resumed.stop();
    expect(getLogs).not.toHaveBeenCalled();
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

  it("decodes a DEX fill from the combined eth_getLogs response", async () => {
    const settlementInterface = new Interface(SETTLEMENT_ABI);
    const fragment = settlementInterface.getEvent("OrderFilledDEX")!;
    const orderHash = `0x${"11".repeat(32)}`;
    const encoded = settlementInterface.encodeEventLog(fragment, [
      orderHash,
      "0x00000000000000000000000000000000000000A1",
      "0x00000000000000000000000000000000000000B2",
      2,
      10n,
      20n,
      2n,
      1n,
    ]);
    const provider = {
      getBlockNumber: vi.fn().mockResolvedValue(102),
      getLogs: vi.fn().mockResolvedValue([{
        address: SETTLEMENT,
        data: encoded.data,
        topics: encoded.topics,
        blockNumber: 100,
        index: 0,
        transactionHash: `0x${"22".repeat(32)}`,
      }]),
    } as unknown as Provider;
    const store = new MemoryStore();
    const indexer = new Indexer(config, provider, store);

    await indexer.start();
    indexer.stop();

    expect(await store.listFills(orderHash)).toMatchObject([{
      orderHash,
      path: "dex",
      adapterId: 2,
      amountOut: 20n,
      makerImprovement: 2n,
      keeperReward: 1n,
      blockNumber: 100,
    }]);
  });
});
