import { Contract, Wallet, type Provider } from "ethers";

import { ROUTER_ABI, SETTLEMENT_ABI } from "./abi.js";
import {
  AVALANCHE_MAINNET_CHAIN_ID,
  MAINNET_BLACKHOLE_HELPER,
  MAINNET_BLACKHOLE_ROUTER,
  MAINNET_LFJ_QUOTER,
  MAINNET_LFJ_ROUTER,
  MAINNET_PHARAOH_QUOTER,
  MAINNET_PHARAOH_ROUTER,
  type SeltraConfig,
} from "./config.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const OWNABLE_ABI = ["function owner() view returns (address)", "function pendingOwner() view returns (address)"];
const ADAPTER_ABI = [
  "function ROUTER() view returns (address)",
  "function LB_ROUTER() view returns (address)",
  "function LB_QUOTER() view returns (address)",
  "function BH_ROUTER() view returns (address)",
  "function BH_HELPER() view returns (address)",
  "function PHARAOH_ROUTER() view returns (address)",
  "function PHARAOH_QUOTER() view returns (address)",
  "function routeKey(address pair,address from,address to,bool stable,bool concentrated) pure returns (bytes32)",
  "function allowedRoutes(bytes32 key) view returns (bool)",
];
const TIMELOCK_ABI = [
  "function getMinDelay() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
];
const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

/** Read-only topology and release checks run before a signer is constructed. */
export async function preflightRuntime(config: SeltraConfig, provider: Provider): Promise<void> {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`RPC chain id ${network.chainId} does not match configured ${config.chainId}`);
  }
  const head = await provider.getBlockNumber();
  if (config.indexerStartBlock > head) throw new Error("INDEXER_START_BLOCK is ahead of the RPC head");

  for (const [name, target] of [["Permit2", config.permit2], ["settlement", config.settlement], ["router", config.router]] as const) {
    if ((await provider.getCode(target)) === "0x") throw new Error(`${name} has no code at ${target}`);
  }

  const settlement = new Contract(config.settlement, SETTLEMENT_ABI, provider);
  const router = new Contract(config.router, ROUTER_ABI, provider);
  const [wiredPermit2, wiredRouter, routerSettlement] = await Promise.all([
    settlement.PERMIT2(),
    settlement.ROUTER(),
    router.settlement(),
  ]);
  assertSame(wiredPermit2, config.permit2, "settlement Permit2");
  assertSame(wiredRouter, config.router, "settlement router");
  assertSame(routerSettlement, config.settlement, "router settlement");

  for (const venue of config.dexVenues) {
    if (!(await router.isRegistered(venue.adapterId))) {
      throw new Error(`${venue.name} adapter ${venue.adapterId} is missing or paused`);
    }
    const adapter = String(await router.adapters(venue.adapterId));
    if (adapter === ZERO || (await provider.getCode(adapter)) === "0x") {
      throw new Error(`${venue.name} adapter has no deployed code`);
    }
    const adapterContract = new Contract(adapter, ADAPTER_ABI, provider);
    assertSame(await adapterContract.ROUTER(), config.router, `${venue.name} Seltra router`);
    if (config.chainId === AVALANCHE_MAINNET_CHAIN_ID && venue.kind === "lfj") {
      assertSame(await adapterContract.LB_ROUTER(), MAINNET_LFJ_ROUTER, "LFJ upstream router");
      assertSame(await adapterContract.LB_QUOTER(), MAINNET_LFJ_QUOTER, "LFJ upstream quoter");
    } else if (config.chainId === AVALANCHE_MAINNET_CHAIN_ID && venue.kind === "blackhole") {
      assertSame(await adapterContract.BH_ROUTER(), MAINNET_BLACKHOLE_ROUTER, "Blackhole upstream router");
      assertSame(await adapterContract.BH_HELPER(), MAINNET_BLACKHOLE_HELPER, "Blackhole upstream helper");
      for (const [pairName, route] of Object.entries(venue.routes)) {
        const pair = config.pairs[pairName];
        for (const [from, to] of [[pair.base, pair.quote], [pair.quote, pair.base]]) {
          const key = await adapterContract.routeKey(route.pool, from, to, route.stable, route.concentrated);
          if (!(await adapterContract.allowedRoutes(key))) throw new Error(`Blackhole ${pairName} route is not allowlisted`);
        }
      }
    } else if (config.chainId === AVALANCHE_MAINNET_CHAIN_ID && venue.kind === "pharaoh") {
      assertSame(await adapterContract.PHARAOH_ROUTER(), MAINNET_PHARAOH_ROUTER, "Pharaoh upstream router");
      assertSame(await adapterContract.PHARAOH_QUOTER(), MAINNET_PHARAOH_QUOTER, "Pharaoh upstream quoter");
    }
  }
  for (const pair of Object.values(config.pairs)) {
    for (const token of [pair.base, pair.quote]) {
      if (!(await settlement.allowedTokens(token))) throw new Error(`token is not allowlisted on settlement: ${token}`);
    }
  }

  if (config.chainId === AVALANCHE_MAINNET_CHAIN_ID) {
    const [settlementOwner, routerOwner, settlementPending, routerPending] = await Promise.all([
      settlement.owner(),
      router.owner(),
      settlement.pendingOwner(),
      router.pendingOwner(),
    ]);
    assertSame(settlementOwner, routerOwner, "governance owner");
    if (settlementPending !== ZERO || routerPending !== ZERO) throw new Error("governance ownership is still pending");
    if ((await provider.getCode(settlementOwner)) === "0x") {
      throw new Error("mainnet owner must be a deployed timelock, not an EOA");
    }
    const [settlementGuardian, routerGuardian] = await Promise.all([settlement.guardian(), router.guardian()]);
    assertSame(settlementGuardian, routerGuardian, "guardian");
    if ((await provider.getCode(settlementGuardian)) === "0x") {
      throw new Error("mainnet guardian must be a deployed multisig, not an EOA");
    }
    const timelock = new Contract(settlementOwner, TIMELOCK_ABI, provider);
    const safe = new Contract(settlementGuardian, SAFE_ABI, provider);
    const [minDelay, proposerRole, executorRole, safeThreshold, safeOwners] = await Promise.all([
      timelock.getMinDelay(),
      timelock.PROPOSER_ROLE(),
      timelock.EXECUTOR_ROLE(),
      safe.getThreshold(),
      safe.getOwners(),
    ]);
    if (BigInt(minDelay) < 172_800n) throw new Error("mainnet timelock delay is below 48 hours");
    if (BigInt(safeThreshold) < 2n || safeOwners.length < Number(safeThreshold)) {
      throw new Error("mainnet guardian Safe threshold is below 2");
    }
    if (!(await timelock.hasRole(proposerRole, settlementGuardian))) {
      throw new Error("guardian Safe does not hold the timelock proposer role");
    }
    if (!(await timelock.hasRole(executorRole, settlementGuardian))) {
      throw new Error("guardian Safe does not hold the timelock executor role");
    }
    const blackholeAddress = String(await router.adapters(2));
    const blackhole = new Contract(blackholeAddress, OWNABLE_ABI, provider);
    const [blackholeOwner, blackholePending] = await Promise.all([blackhole.owner(), blackhole.pendingOwner()]);
    assertSame(blackholeOwner, settlementOwner, "Blackhole governance owner");
    if (blackholePending !== ZERO) throw new Error("Blackhole governance ownership is still pending");
    if (config.keeperPrivateKey) {
      const keeper = new Wallet(config.keeperPrivateKey).address;
      if ((await provider.getBalance(keeper)) === 0n) throw new Error("mainnet keeper has no AVAX for gas");
      if (await settlement.fillsPaused()) throw new Error("settlement fills are paused");
    }
  }
}

function assertSame(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} mismatch: ${actual} != ${expected}`);
  }
}
