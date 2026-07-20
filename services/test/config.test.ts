import { describe, expect, it } from "vitest";

import {
  MAINNET_BLACKHOLE_USDC_USDT_POOL,
  MAINNET_BLACKHOLE_WAVAX_USDC_POOL,
  MAINNET_USDC,
  MAINNET_USDT,
  MAINNET_WAVAX,
  loadConfig,
} from "../src/config.js";

const PAIRS = JSON.stringify({
  "WAVAX/USDC": { base: MAINNET_WAVAX, quote: MAINNET_USDC },
  "USDC/USDt": { base: MAINNET_USDC, quote: MAINNET_USDT },
});
const VENUES = JSON.stringify([
  {
    kind: "lfj",
    name: "LFJ",
    adapterId: 1,
    quoter: "0xd76019A16606FDa4651f636D9751f500Ed776250",
  },
  {
    kind: "blackhole",
    name: "Blackhole",
    adapterId: 2,
    routes: {
      "WAVAX/USDC": { pool: MAINNET_BLACKHOLE_WAVAX_USDC_POOL, stable: false, concentrated: true },
      "USDC/USDt": { pool: MAINNET_BLACKHOLE_USDC_USDT_POOL, stable: false, concentrated: true },
    },
  },
  {
    kind: "pharaoh",
    name: "Pharaoh",
    adapterId: 3,
    routes: { "WAVAX/USDC": { tickSpacing: 10 }, "USDC/USDt": { tickSpacing: 1 } },
  },
]);

function mainnetEnv(): NodeJS.ProcessEnv {
  return {
    CHAIN_ID: "43114",
    RPC_URL: "https://rpc.example.test",
    SETTLEMENT: "0x0000000000000000000000000000000000000011",
    ROUTER: "0x0000000000000000000000000000000000000022",
    PAIRS,
    DEX_VENUES: VENUES,
    DATABASE_URL: "postgresql://localhost/seltra",
    INDEXER_START_BLOCK: "70000000",
    CORS_ORIGIN: "https://app.seltra.finance",
    KEEPER_MIN_PROFIT: "250000",
    MIN_ORDER_NOTIONAL: "1000000",
    KEEPER_MAX_ORDER_NOTIONAL: "5000000000",
    KEEPER_DAILY_NOTIONAL_CAP: "50000000000",
    MAINNET_CONFIRM: "SELTRA_MAINNET_CONFIG_REVIEWED",
  };
}

describe("mainnet service configuration", () => {
  it("accepts only the pinned two-pair, three-venue release config", () => {
    const config = loadConfig(mainnetEnv());
    expect(Object.keys(config.pairs)).toEqual(["WAVAX/USDC", "USDC/USDt"]);
    expect(config.dexVenues.map((venue) => venue.adapterId)).toEqual([1, 2, 3]);
  });

  it("rejects a substituted Blackhole pool", () => {
    const env = mainnetEnv();
    env.DEX_VENUES = VENUES.replace(
      MAINNET_BLACKHOLE_USDC_USDT_POOL,
      "0x0000000000000000000000000000000000000099",
    );
    expect(() => loadConfig(env)).toThrow(/Blackhole USDC\/USDt/);
  });

  it("requires an independent confirmation before a mainnet keeper key is loaded", () => {
    const env = mainnetEnv();
    env.KEEPER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    expect(() => loadConfig(env)).toThrow(/KEEPER_CONFIRM_LIVE/);
    env.KEEPER_CONFIRM_LIVE = "EXECUTE_REAL_MAINNET_ORDER_FILLS";
    expect(loadConfig(env).keeperPrivateKey).toBe(env.KEEPER_PRIVATE_KEY);
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
