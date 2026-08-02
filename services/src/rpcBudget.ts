import type { SeltraConfig } from "./config.js";

const DAY_MS = 86_400_000;
const ETH_CALL_CU = 26;
const ETH_GET_LOGS_CU = 60;
const ETH_BLOCK_NUMBER_CU = 10;
const REGISTRATION_CACHE_MS = 60_000;

/**
 * Conservative steady-state Alchemy bound. It assumes every public pair is
 * requested continuously, every watcher slot is used, and both log scanners
 * find a new finalized range every cycle. Quote calls count only if the quote
 * endpoint is the paid primary endpoint. Rare order submissions, fills,
 * startup replay, retries and failover-provider duplication are not included.
 */
export function estimateSteadyStateDailyAlchemyCu(config: SeltraConfig): number {
  const pollCycles = Math.ceil(DAY_MS / config.pollIntervalMs);
  const watcherCycles = Math.ceil(DAY_MS / config.watcherPollIntervalMs);
  const publicRefreshes = Math.ceil(DAY_MS / config.publicQuoteCacheMs);

  const callsForPair = (pairName: string): number => {
    const venues = config.dexVenues.filter((venue) => !venue.excludedPairs?.includes(pairName));
    const lfjRouteBuilds = venues.filter((venue) => venue.kind === "lfj").length;
    return venues.length + lfjRouteBuilds;
  };
  const pairCalls = Object.keys(config.pairs).map(callsForPair);
  const worstExactQuoteCalls = Math.max(1, ...pairCalls);
  const watcherEthCalls = watcherCycles
    * config.watcherMaxQuoteGroupsPerTick
    * worstExactQuoteCalls;
  const publicEthCalls = publicRefreshes
    * pairCalls.reduce((sum, calls) => sum + calls, 0);
  const registrationEthCalls = Math.ceil(DAY_MS / REGISTRATION_CACHE_MS)
    * config.dexVenues.length;

  // Indexer and monitor each use one OR-filtered eth_getLogs request and one
  // block-number read per cycle in the busy-chain steady state.
  const logCalls = pollCycles * 2;
  const blockNumberCalls = pollCycles * 2;

  const paidQuoteEthCalls = config.quoteRpcUrl === config.rpcUrl
    ? watcherEthCalls + publicEthCalls + registrationEthCalls
    : 0;

  return paidQuoteEthCalls * ETH_CALL_CU
    + logCalls * ETH_GET_LOGS_CU
    + blockNumberCalls * ETH_BLOCK_NUMBER_CU;
}
