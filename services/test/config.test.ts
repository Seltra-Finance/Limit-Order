import { describe, expect, it } from "vitest";

import {
  MAINNET_BLACKHOLE_BTCB_WAVAX_POOL,
  MAINNET_BLACKHOLE_USDC_USDT_POOL,
  MAINNET_BLACKHOLE_WAVAX_USDC_POOL,
  MAINNET_BLACKHOLE_WETH_WAVAX_POOL,
  MAINNET_BTC_B,
  MAINNET_LFJ_QUOTER,
  MAINNET_USDC,
  MAINNET_USDT,
  MAINNET_WAVAX,
  MAINNET_WETH_E,
  BOOTSTRAP_EOA_GOVERNANCE_ACK,
  loadConfig,
} from "../src/config.js";

const PAIRS = JSON.stringify({
  "WAVAX/USDC": { base: MAINNET_WAVAX, quote: MAINNET_USDC },
  "WETH.e/WAVAX": { base: MAINNET_WETH_E, quote: MAINNET_WAVAX },
  "BTC.b/WAVAX": { base: MAINNET_BTC_B, quote: MAINNET_WAVAX },
  "USDC/USDt": { base: MAINNET_USDC, quote: MAINNET_USDT },
});
const VENUES = JSON.stringify([
  {
    kind: "lfj",
    name: "LFJ",
    adapterId: 1,
    quoter: MAINNET_LFJ_QUOTER,
    excludedPairs: ["BTC.b/WAVAX"],
  },
  {
    kind: "blackhole",
    name: "Blackhole",
    adapterId: 2,
    routes: {
      "WAVAX/USDC": { pool: MAINNET_BLACKHOLE_WAVAX_USDC_POOL, stable: false, concentrated: true },
      "WETH.e/WAVAX": { pool: MAINNET_BLACKHOLE_WETH_WAVAX_POOL, stable: false, concentrated: true },
      "BTC.b/WAVAX": { pool: MAINNET_BLACKHOLE_BTCB_WAVAX_POOL, stable: false, concentrated: true },
      "USDC/USDt": { pool: MAINNET_BLACKHOLE_USDC_USDT_POOL, stable: false, concentrated: true },
    },
  },
  {
    kind: "pharaoh",
    name: "Pharaoh",
    adapterId: 3,
    routes: {
      "WAVAX/USDC": { tickSpacing: 10 },
      "WETH.e/WAVAX": { tickSpacing: 5 },
      "BTC.b/WAVAX": { tickSpacing: 5 },
      "USDC/USDt": { tickSpacing: 1 },
    },
  },
]);
const QUOTE_POLICIES = JSON.stringify({
  [MAINNET_USDC]: {
    minOrderNotional: "10000000",
    keeperMinProfit: "10000",
    keeperMaxOrderNotional: "5000000000",
    keeperDailyNotionalCap: "50000000000",
  },
  [MAINNET_WAVAX]: {
    minOrderNotional: "1000000000000000000",
    keeperMinProfit: "2000000000000000",
    keeperMaxOrderNotional: "500000000000000000000",
    keeperDailyNotionalCap: "5000000000000000000000",
  },
  [MAINNET_USDT]: {
    minOrderNotional: "10000000",
    keeperMinProfit: "10000",
    keeperMaxOrderNotional: "5000000000",
    keeperDailyNotionalCap: "50000000000",
  },
});

function mainnetEnv(): NodeJS.ProcessEnv {
  return {
    CHAIN_ID: "43114",
    RPC_URLS: "https://primary-rpc.example.test,https://fallback-rpc.example.test",
    SETTLEMENT: "0x0000000000000000000000000000000000000011",
    ROUTER: "0x0000000000000000000000000000000000000022",
    PAIRS,
    DEX_VENUES: VENUES,
    DATABASE_URL: "postgresql://localhost/seltra",
    INDEXER_START_BLOCK: "70000000",
    CORS_ORIGIN: "https://app.seltra.finance",
    QUOTE_POLICIES,
    MAX_ORDER_TTL_SECONDS: "604800",
    MAINNET_CONFIRM: "SELTRA_MAINNET_CONFIG_REVIEWED",
  };
}

describe("mainnet service configuration", () => {
  it("accepts only the pinned four-pair, three-venue release config", () => {
    const config = loadConfig(mainnetEnv());
    expect(Object.keys(config.pairs)).toEqual(["WAVAX/USDC", "WETH.e/WAVAX", "BTC.b/WAVAX", "USDC/USDt"]);
    expect(config.dexVenues.map((venue) => venue.adapterId)).toEqual([1, 2, 3]);
    expect(config.quotePolicies?.[MAINNET_USDC.toLowerCase()]?.keeperMinProfit).toBe(10_000n);
    expect(config.quotePolicies?.[MAINNET_WAVAX.toLowerCase()]?.keeperMinProfit).toBe(
      2_000_000_000_000_000n,
    );
    expect(config.quotePolicies?.[MAINNET_USDT.toLowerCase()]?.keeperMinProfit).toBe(10_000n);
  });

  it("rejects a substituted Blackhole pool", () => {
    const env = mainnetEnv();
    env.DEX_VENUES = VENUES.replace(
      MAINNET_BLACKHOLE_USDC_USDT_POOL,
      "0x0000000000000000000000000000000000000099",
    );
    expect(() => loadConfig(env)).toThrow(/Blackhole USDC\/USDt/);
  });

  it("requires LFJ to exclude the low-depth BTC.b route", () => {
    const env = mainnetEnv();
    const venues = JSON.parse(VENUES);
    delete venues[0].excludedPairs;
    env.DEX_VENUES = JSON.stringify(venues);
    expect(() => loadConfig(env)).toThrow(/LFJ must exclude/);
  });

  it("requires quote-token-native policies for every mainnet quote asset", () => {
    const env = mainnetEnv();
    const policies = JSON.parse(QUOTE_POLICIES);
    delete policies[MAINNET_WAVAX];
    env.QUOTE_POLICIES = JSON.stringify(policies);
    expect(() => loadConfig(env)).toThrow(/missing WAVAX/);
  });

  it("requires two distinct https RPC endpoints on mainnet", () => {
    const env = mainnetEnv();
    env.RPC_URLS = "https://primary-rpc.example.test";
    expect(() => loadConfig(env)).toThrow(/primary and fallback/);
    env.RPC_URLS = "http://primary-rpc.example.test,https://fallback-rpc.example.test";
    expect(() => loadConfig(env)).toThrow(/must use https/);
  });

  it("requires an independent confirmation before a mainnet keeper key is loaded", () => {
    const env = mainnetEnv();
    env.KEEPER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    expect(() => loadConfig(env)).toThrow(/KEEPER_CONFIRM_LIVE/);
    env.KEEPER_CONFIRM_LIVE = "EXECUTE_REAL_MAINNET_ORDER_FILLS";
    expect(loadConfig(env).keeperPrivateKey).toBe(env.KEEPER_PRIVATE_KEY);
  });

  it("accepts only the exact bootstrap EOA governance acknowledgement", () => {
    const env = mainnetEnv();
    env.BOOTSTRAP_EOA_GOVERNANCE_ACK = "yes";
    expect(() => loadConfig(env)).toThrow(/must equal/);
    env.BOOTSTRAP_EOA_GOVERNANCE_ACK = BOOTSTRAP_EOA_GOVERNANCE_ACK;
    expect(loadConfig(env).bootstrapEoaGovernance).toBe(true);
  });

  it("keeps the empty-route mock fallback limited to development chains", () => {
    const config = loadConfig({
      SETTLEMENT: "0x0000000000000000000000000000000000000011",
      ROUTER: "0x0000000000000000000000000000000000000022",
    });
    expect(config.chainId).toBe(43113);
    expect(config.dexVenues).toEqual([{ kind: "mock", name: "Development mock", adapterId: 0 }]);
  });
});
