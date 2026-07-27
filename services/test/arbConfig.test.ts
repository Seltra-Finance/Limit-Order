import { describe, expect, it } from "vitest";

import {
  AVALANCHE_MAINNET_CHAIN_ID,
  LFJ_LB_QUOTER_V22,
  loadArbitrageConfig,
} from "../src/arbConfig.js";

const EXECUTOR = "0x00000000000000000000000000000000000000e1";
const PRIVATE_KEY = `0x${"11".repeat(32)}`;

describe("loadArbitrageConfig", () => {
  it("defaults to an Avalanche dry-run with official venue references", () => {
    const config = loadArbitrageConfig({});
    expect(config.mode).toBe("dry-run");
    expect(config.chainId).toBe(AVALANCHE_MAINNET_CHAIN_ID);
    expect(config.lfjQuoter).toBe(LFJ_LB_QUOTER_V22);
    expect(config.executorAddress).toBeUndefined();
    expect(config.operatorPrivateKey).toBeUndefined();
    expect(config.cycles).toHaveLength(1);
  });

  it("requires every independent live-trading gate", () => {
    expect(() => loadArbitrageConfig({ ARB_MODE: "live" })).toThrow("ARB_CONFIRM_LIVE");
    expect(() => loadArbitrageConfig({
      ARB_MODE: "live",
      ARB_CONFIRM_LIVE: "EXECUTE_REAL_MAINNET_TRADES",
    })).toThrow("ARB_EXECUTOR");
    expect(() => loadArbitrageConfig({
      ARB_MODE: "live",
      ARB_CONFIRM_LIVE: "EXECUTE_REAL_MAINNET_TRADES",
      ARB_EXECUTOR: EXECUTOR,
    })).toThrow("ARB_OPERATOR_PRIVATE_KEY");

    const live = loadArbitrageConfig({
      ARB_MODE: "live",
      ARB_CONFIRM_LIVE: "EXECUTE_REAL_MAINNET_TRADES",
      ARB_EXECUTOR: EXECUTOR,
      ARB_OPERATOR_PRIVATE_KEY: PRIVATE_KEY,
    });
    expect(live.mode).toBe("live");
    expect(live.executorAddress).toBe(EXECUTOR);

    const nonNative = JSON.stringify([{
      name: "USDC-WAVAX",
      tokenIn: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      tokenMid: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
      amountIn: "1000000",
      minNetProfit: "1000",
    }]);
    expect(() => loadArbitrageConfig({
      ARB_MODE: "live",
      ARB_CONFIRM_LIVE: "EXECUTE_REAL_MAINNET_TRADES",
      ARB_EXECUTOR: EXECUTOR,
      ARB_OPERATOR_PRIVATE_KEY: PRIVATE_KEY,
      ARB_CYCLES: nonNative,
    })).toThrow("must start in the wrapped native token");
  });

  it("rejects unsafe chains, duplicate cycles and invalid bounds", () => {
    expect(() => loadArbitrageConfig({ ARB_CHAIN_ID: "43113" })).toThrow("pinned to Avalanche");
    expect(() => loadArbitrageConfig({ ARB_SLIPPAGE_BPS: "501" })).toThrow("ARB_SLIPPAGE_BPS");
    const duplicate = JSON.stringify([
      {
        name: "same",
        tokenIn: "0x0000000000000000000000000000000000000001",
        tokenMid: "0x0000000000000000000000000000000000000002",
        amountIn: "1",
        minNetProfit: "1",
      },
      {
        name: "same",
        tokenIn: "0x0000000000000000000000000000000000000002",
        tokenMid: "0x0000000000000000000000000000000000000001",
        amountIn: "1",
        minNetProfit: "1",
      },
    ]);
    expect(() => loadArbitrageConfig({ ARB_CYCLES: duplicate })).toThrow("names must be unique");
  });
});
