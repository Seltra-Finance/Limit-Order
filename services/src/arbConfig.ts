import { getAddress, parseUnits } from "ethers";

export const AVALANCHE_MAINNET_CHAIN_ID = 43_114;
export const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
export const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
export const LFJ_LB_ROUTER_V21 = "0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30";
export const LFJ_LB_QUOTER_V21 = "0xd76019A16606FDa4651f636D9751f500Ed776250";
export const PHARAOH_SWAP_ROUTER = "0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c";
export const PHARAOH_QUOTER_V2 = "0xB7297301b7CC659BB96D51754643A0Df6eEA2138";

export type ArbitrageMode = "dry-run" | "live";

export interface ArbitrageCycleConfig {
  name: string;
  tokenIn: string;
  tokenMid: string;
  amountIn: bigint;
  minNetProfit: bigint;
}

export interface ArbitrageRuntimeConfig {
  mode: ArbitrageMode;
  chainId: number;
  rpcUrls: string[];
  cycles: ArbitrageCycleConfig[];
  pollIntervalMs: number;
  cooldownMs: number;
  maxQuoteAgeMs: number;
  deadlineSeconds: number;
  slippageBps: number;
  estimatedGasUnits: bigint;
  gasCostBufferBps: number;
  maxFeePerGasWei: bigint;
  maxConsecutiveFailures: number;
  failurePauseMs: number;
  wrappedNative: string;
  lfjRouter: string;
  lfjQuoter: string;
  pharaohRouter: string;
  pharaohQuoter: string;
  pharaohTickSpacing: number;
  executorAddress?: string;
  operatorPrivateKey?: string;
  journalPath: string;
  alertWebhookUrl?: string;
}

const DEFAULT_CYCLES = JSON.stringify([
  {
    name: "WAVAX-USDC",
    tokenIn: WAVAX,
    tokenMid: USDC,
    amountIn: "1000000000000000000",
    minNetProfit: "500000000000000",
  },
]);

/**
 * Loads the isolated arbitrage runtime. Dry-run is the unconditional default.
 * Live mode needs three independent gates so accidentally injecting a key can
 * never start transaction submission.
 */
export function loadArbitrageConfig(env: NodeJS.ProcessEnv = process.env): ArbitrageRuntimeConfig {
  const mode = env.ARB_MODE ?? "dry-run";
  if (mode !== "dry-run" && mode !== "live") throw new Error("ARB_MODE must be dry-run or live");

  const chainId = integer(env.ARB_CHAIN_ID ?? String(AVALANCHE_MAINNET_CHAIN_ID), "ARB_CHAIN_ID", 1);
  if (chainId !== AVALANCHE_MAINNET_CHAIN_ID) {
    throw new Error(`arbitrage runtime is pinned to Avalanche C-Chain ${AVALANCHE_MAINNET_CHAIN_ID}`);
  }

  const rpcUrls = (env.ARB_RPC_URLS ?? "https://api.avax.network/ext/bc/C/rpc")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (rpcUrls.length === 0) throw new Error("ARB_RPC_URLS requires at least one URL");
  for (const url of rpcUrls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("ARB_RPC_URLS supports only http(s)");
    }
  }

  const cycles = parseCycles(env.ARB_CYCLES ?? DEFAULT_CYCLES);
  const config: ArbitrageRuntimeConfig = {
    mode,
    chainId,
    rpcUrls,
    cycles,
    pollIntervalMs: integer(env.ARB_POLL_INTERVAL_MS ?? "3000", "ARB_POLL_INTERVAL_MS", 250),
    cooldownMs: integer(env.ARB_COOLDOWN_MS ?? "30000", "ARB_COOLDOWN_MS", 0),
    maxQuoteAgeMs: integer(env.ARB_MAX_QUOTE_AGE_MS ?? "5000", "ARB_MAX_QUOTE_AGE_MS", 250),
    deadlineSeconds: integer(env.ARB_DEADLINE_SECONDS ?? "30", "ARB_DEADLINE_SECONDS", 5),
    slippageBps: integer(env.ARB_SLIPPAGE_BPS ?? "30", "ARB_SLIPPAGE_BPS", 0, 500),
    estimatedGasUnits: positiveBigInt(env.ARB_ESTIMATED_GAS_UNITS ?? "650000", "ARB_ESTIMATED_GAS_UNITS"),
    gasCostBufferBps: integer(env.ARB_GAS_COST_BUFFER_BPS ?? "2000", "ARB_GAS_COST_BUFFER_BPS", 0, 10_000),
    maxFeePerGasWei: parsePositiveUnits(env.ARB_MAX_FEE_GWEI ?? "100", 9, "ARB_MAX_FEE_GWEI"),
    maxConsecutiveFailures: integer(
      env.ARB_MAX_CONSECUTIVE_FAILURES ?? "5",
      "ARB_MAX_CONSECUTIVE_FAILURES",
      1,
      100,
    ),
    failurePauseMs: integer(env.ARB_FAILURE_PAUSE_MS ?? "60000", "ARB_FAILURE_PAUSE_MS", 1_000),
    wrappedNative: address(env.ARB_WRAPPED_NATIVE ?? WAVAX, "ARB_WRAPPED_NATIVE"),
    lfjRouter: address(env.ARB_LFJ_ROUTER ?? LFJ_LB_ROUTER_V21, "ARB_LFJ_ROUTER"),
    lfjQuoter: address(env.ARB_LFJ_QUOTER ?? LFJ_LB_QUOTER_V21, "ARB_LFJ_QUOTER"),
    pharaohRouter: address(env.ARB_PHARAOH_ROUTER ?? PHARAOH_SWAP_ROUTER, "ARB_PHARAOH_ROUTER"),
    pharaohQuoter: address(env.ARB_PHARAOH_QUOTER ?? PHARAOH_QUOTER_V2, "ARB_PHARAOH_QUOTER"),
    pharaohTickSpacing: integer(env.ARB_PHARAOH_TICK_SPACING ?? "10", "ARB_PHARAOH_TICK_SPACING", 1, 8_388_607),
    journalPath: env.ARB_JOURNAL_PATH?.trim() || "data/arbitrage.jsonl",
    alertWebhookUrl: optionalHttpUrl(env.ARB_ALERT_WEBHOOK_URL, "ARB_ALERT_WEBHOOK_URL"),
  };

  if (mode === "live") {
    if (env.ARB_CONFIRM_LIVE !== "EXECUTE_REAL_MAINNET_TRADES") {
      throw new Error("live arbitrage requires ARB_CONFIRM_LIVE=EXECUTE_REAL_MAINNET_TRADES");
    }
    config.executorAddress = address(required(env, "ARB_EXECUTOR"), "ARB_EXECUTOR");
    const privateKey = required(env, "ARB_OPERATOR_PRIVATE_KEY");
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("ARB_OPERATOR_PRIVATE_KEY is invalid");
    config.operatorPrivateKey = privateKey;
    if (config.cycles.some((cycle) => cycle.tokenIn.toLowerCase() !== config.wrappedNative.toLowerCase())) {
      throw new Error("live MVP cycles must start in the wrapped native token for deterministic gas accounting");
    }
  }

  return config;
}

function parseCycles(raw: string): ArbitrageCycleConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ARB_CYCLES must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
    throw new Error("ARB_CYCLES requires 1 to 20 cycles");
  }

  const names = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`ARB_CYCLES[${index}] must be an object`);
    const value = item as Record<string, unknown>;
    const name = String(value.name ?? "").trim();
    if (!name) throw new Error(`ARB_CYCLES[${index}].name is required`);
    if (names.has(name)) throw new Error("ARB_CYCLES names must be unique");
    names.add(name);

    const tokenIn = address(String(value.tokenIn ?? ""), `ARB_CYCLES[${index}].tokenIn`);
    const tokenMid = address(String(value.tokenMid ?? ""), `ARB_CYCLES[${index}].tokenMid`);
    if (tokenIn.toLowerCase() === tokenMid.toLowerCase()) throw new Error("arbitrage cycle tokens must differ");
    return {
      name,
      tokenIn,
      tokenMid,
      amountIn: positiveBigInt(String(value.amountIn ?? ""), `ARB_CYCLES[${index}].amountIn`),
      minNetProfit: positiveBigInt(String(value.minNetProfit ?? ""), `ARB_CYCLES[${index}].minNetProfit`),
    };
  });
}

function address(value: string, label: string): string {
  try {
    const parsed = getAddress(value);
    if (parsed === "0x0000000000000000000000000000000000000000") throw new Error("zero");
    return parsed;
  } catch {
    throw new Error(`${label} must be a nonzero address`);
  }
}

function integer(value: string, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

function positiveBigInt(value: string, label: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error("non-positive");
    return parsed;
  } catch {
    throw new Error(`${label} must be a positive integer`);
  }
}

function parsePositiveUnits(value: string, decimals: number, label: string): bigint {
  try {
    const parsed = parseUnits(value, decimals);
    if (parsed <= 0n) throw new Error("non-positive");
    return parsed;
  } catch {
    throw new Error(`${label} must be a positive decimal`);
  }
}

function optionalHttpUrl(value: string | undefined, label: string): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${label} must use http(s)`);
  return parsed.toString();
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}
