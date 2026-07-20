import { getAddress } from "ethers";

export const AVALANCHE_MAINNET_CHAIN_ID = 43_114;
export const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const MAINNET_WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
export const MAINNET_USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
export const MAINNET_USDT = "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7";
export const MAINNET_BLACKHOLE_WAVAX_USDC_POOL = "0x41100C6D2c6920B10d12Cd8D59c8A9AA2eF56fC7";
export const MAINNET_BLACKHOLE_USDC_USDT_POOL = "0x859592A4A469610E573f96Ef87A0e5565F9a94c8";
export const MAINNET_LFJ_ROUTER = "0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30";
export const MAINNET_LFJ_QUOTER = "0xd76019A16606FDa4651f636D9751f500Ed776250";
export const MAINNET_BLACKHOLE_ROUTER = "0xe946A9f39312E2346BA79DAb865B0e9A74f2F981";
export const MAINNET_BLACKHOLE_HELPER = "0x53D569BC4B37ADbBDB6ab447D92ADf42514AE480";
export const MAINNET_PHARAOH_ROUTER = "0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c";
export const MAINNET_PHARAOH_QUOTER = "0xB7297301b7CC659BB96D51754643A0Df6eEA2138";

export interface PairConfig {
  base: string;
  quote: string;
}

interface DexVenueBase {
  adapterId: number;
  name: string;
}

export interface MockVenueConfig extends DexVenueBase {
  kind: "mock";
}

export interface LfjVenueConfig extends DexVenueBase {
  kind: "lfj";
  quoter: string;
}

export interface PharaohVenueConfig extends DexVenueBase {
  kind: "pharaoh";
  routes: Record<string, { tickSpacing: number }>;
}

export interface BlackholeVenueConfig extends DexVenueBase {
  kind: "blackhole";
  routes: Record<string, { pool: string; stable: boolean; concentrated: boolean }>;
}

export type DexVenueConfig = MockVenueConfig | LfjVenueConfig | PharaohVenueConfig | BlackholeVenueConfig;

export interface SeltraConfig {
  rpcUrl: string;
  chainId: number;
  permit2: string;
  settlement: string;
  router: string;
  /** Allowlisted pairs, e.g. WAVAX/USDC -> token addresses. */
  pairs: Record<string, PairConfig>;
  apiPort: number;
  apiHost: string;
  corsOrigin: string;
  apiRateLimitPerMinute: number;
  keeperPrivateKey?: string;
  databaseUrl?: string;
  /** Executable venue configurations. Empty only for isolated API tests. */
  dexVenues: DexVenueConfig[];
  /** Legacy single-adapter fallback, restricted to non-mainnet development. */
  dexAdapterId: number;
  keeperMinProfit: bigint;
  minOrderNotional: bigint;
  maxOrderTtlSeconds: number;
  keeperMaxOrderNotional: bigint;
  keeperDailyNotionalCap: bigint;
  wrappedNative: string;
  gasCostBufferBps: number;
  quoteDeadlineSeconds: number;
  maxQuoteAgeMs: number;
  pollIntervalMs: number;
  indexerStartBlock: number;
  indexerConfirmations: number;
  indexerBatchSize: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SeltraConfig {
  const chainId = integer(env.CHAIN_ID ?? "43113", "CHAIN_ID", 1);
  const mainnet = chainId === AVALANCHE_MAINNET_CHAIN_ID;
  const settlement = address(required(env, "SETTLEMENT"), "SETTLEMENT");
  const router = address(required(env, "ROUTER"), "ROUTER");
  const pairs = parsePairs(env.PAIRS ?? "{}");
  const dexAdapterId = integer(env.DEX_ADAPTER_ID ?? "0", "DEX_ADAPTER_ID", 0, 255);
  const dexVenues = env.DEX_VENUES
    ? parseDexVenues(env.DEX_VENUES, pairs)
    : [{ kind: "mock", name: "Development mock", adapterId: dexAdapterId } satisfies MockVenueConfig];

  const config: SeltraConfig = {
    rpcUrl: httpUrl(env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc", "RPC_URL"),
    chainId,
    permit2: address(env.PERMIT2 ?? CANONICAL_PERMIT2, "PERMIT2"),
    settlement,
    router,
    pairs,
    apiPort: integer(env.API_PORT ?? "8080", "API_PORT", 1, 65_535),
    apiHost: env.API_HOST?.trim() || "127.0.0.1",
    corsOrigin: env.CORS_ORIGIN?.trim() || "http://localhost:3000",
    apiRateLimitPerMinute: integer(env.API_RATE_LIMIT_PER_MINUTE ?? "120", "API_RATE_LIMIT_PER_MINUTE", 1, 10_000),
    keeperPrivateKey: optionalPrivateKey(env.KEEPER_PRIVATE_KEY),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    dexVenues,
    dexAdapterId,
    keeperMinProfit: nonNegativeBigInt(env.KEEPER_MIN_PROFIT ?? "0", "KEEPER_MIN_PROFIT"),
    minOrderNotional: nonNegativeBigInt(env.MIN_ORDER_NOTIONAL ?? "0", "MIN_ORDER_NOTIONAL"),
    maxOrderTtlSeconds: integer(
      env.MAX_ORDER_TTL_SECONDS ?? "2592000",
      "MAX_ORDER_TTL_SECONDS",
      60,
      31_536_000,
    ),
    keeperMaxOrderNotional: nonNegativeBigInt(
      env.KEEPER_MAX_ORDER_NOTIONAL ?? "0",
      "KEEPER_MAX_ORDER_NOTIONAL",
    ),
    keeperDailyNotionalCap: nonNegativeBigInt(
      env.KEEPER_DAILY_NOTIONAL_CAP ?? "0",
      "KEEPER_DAILY_NOTIONAL_CAP",
    ),
    wrappedNative: address(
      env.WRAPPED_NATIVE ?? (mainnet ? MAINNET_WAVAX : "0xd00ae08403B9bbb9124bB305C09058E32C39A48c"),
      "WRAPPED_NATIVE",
    ),
    gasCostBufferBps: integer(env.GAS_COST_BUFFER_BPS ?? "2000", "GAS_COST_BUFFER_BPS", 0, 10_000),
    quoteDeadlineSeconds: integer(env.QUOTE_DEADLINE_SECONDS ?? "30", "QUOTE_DEADLINE_SECONDS", 5, 300),
    maxQuoteAgeMs: integer(env.MAX_QUOTE_AGE_MS ?? "5000", "MAX_QUOTE_AGE_MS", 250, 60_000),
    pollIntervalMs: integer(env.POLL_INTERVAL_MS ?? "2000", "POLL_INTERVAL_MS", 250, 60_000),
    indexerStartBlock: integer(env.INDEXER_START_BLOCK ?? "0", "INDEXER_START_BLOCK", 0),
    indexerConfirmations: integer(env.INDEXER_CONFIRMATIONS ?? "2", "INDEXER_CONFIRMATIONS", 0, 100),
    indexerBatchSize: integer(env.INDEXER_BATCH_SIZE ?? "2000", "INDEXER_BATCH_SIZE", 1, 20_000),
  };

  if (mainnet) validateMainnet(config, env);
  return config;
}

function validateMainnet(config: SeltraConfig, env: NodeJS.ProcessEnv): void {
  if (!env.RPC_URL) throw new Error("Avalanche mainnet requires an explicit RPC_URL");
  if (!config.rpcUrl.startsWith("https://")) throw new Error("mainnet RPC_URL must use https");
  if (env.MAINNET_CONFIRM !== "SELTRA_MAINNET_CONFIG_REVIEWED") {
    throw new Error("mainnet requires MAINNET_CONFIRM=SELTRA_MAINNET_CONFIG_REVIEWED");
  }
  if (config.permit2.toLowerCase() !== CANONICAL_PERMIT2.toLowerCase()) {
    throw new Error("mainnet requires canonical Permit2");
  }
  if (!config.databaseUrl) throw new Error("mainnet requires DATABASE_URL; MemoryStore is development-only");
  if (config.indexerStartBlock === 0) throw new Error("mainnet requires the deployment INDEXER_START_BLOCK");
  if (config.indexerConfirmations < 1) throw new Error("mainnet requires at least one indexer confirmation");
  if (config.keeperMinProfit <= 0n) throw new Error("mainnet KEEPER_MIN_PROFIT must be positive");
  if (config.minOrderNotional <= 0n) throw new Error("mainnet MIN_ORDER_NOTIONAL must be positive");
  if (config.keeperMaxOrderNotional <= 0n || config.keeperDailyNotionalCap <= 0n) {
    throw new Error("mainnet keeper rollout caps must be positive");
  }
  if (config.keeperMaxOrderNotional > config.keeperDailyNotionalCap) {
    throw new Error("KEEPER_MAX_ORDER_NOTIONAL cannot exceed KEEPER_DAILY_NOTIONAL_CAP");
  }
  if (config.minOrderNotional > config.keeperMaxOrderNotional) {
    throw new Error("MIN_ORDER_NOTIONAL cannot exceed KEEPER_MAX_ORDER_NOTIONAL");
  }
  if (config.wrappedNative.toLowerCase() !== MAINNET_WAVAX.toLowerCase()) {
    throw new Error("mainnet WRAPPED_NATIVE must be canonical WAVAX");
  }
  if (config.corsOrigin === "*" || !config.corsOrigin.startsWith("https://")) {
    throw new Error("mainnet CORS_ORIGIN must be one explicit https origin");
  }
  if (config.keeperPrivateKey && env.KEEPER_CONFIRM_LIVE !== "EXECUTE_REAL_MAINNET_ORDER_FILLS") {
    throw new Error("a mainnet keeper key requires KEEPER_CONFIRM_LIVE=EXECUTE_REAL_MAINNET_ORDER_FILLS");
  }

  assertPair(config.pairs["WAVAX/USDC"], MAINNET_WAVAX, MAINNET_USDC, "WAVAX/USDC");
  assertPair(config.pairs["USDC/USDt"], MAINNET_USDC, MAINNET_USDT, "USDC/USDt");
  if (Object.keys(config.pairs).length !== 2) {
    throw new Error("initial mainnet registry is pinned to WAVAX/USDC and USDC/USDt");
  }

  if (config.dexVenues.length !== 3) throw new Error("mainnet requires exactly three production venues");
  const lfj = config.dexVenues.find((venue): venue is LfjVenueConfig => venue.adapterId === 1 && venue.kind === "lfj");
  const blackhole = config.dexVenues.find(
    (venue): venue is BlackholeVenueConfig => venue.adapterId === 2 && venue.kind === "blackhole",
  );
  const pharaoh = config.dexVenues.find(
    (venue): venue is PharaohVenueConfig => venue.adapterId === 3 && venue.kind === "pharaoh",
  );
  if (!lfj || lfj.quoter.toLowerCase() !== MAINNET_LFJ_QUOTER.toLowerCase()) {
    throw new Error("mainnet adapter 1 must be the pinned LFJ venue");
  }
  if (!blackhole) throw new Error("mainnet adapter 2 must be Blackhole");
  if (!pharaoh) throw new Error("mainnet adapter 3 must be Pharaoh");
  assertBlackholeRoute(blackhole.routes["WAVAX/USDC"], MAINNET_BLACKHOLE_WAVAX_USDC_POOL, "WAVAX/USDC");
  assertBlackholeRoute(blackhole.routes["USDC/USDt"], MAINNET_BLACKHOLE_USDC_USDT_POOL, "USDC/USDt");
  if (pharaoh.routes["WAVAX/USDC"]?.tickSpacing !== 10 || pharaoh.routes["USDC/USDt"]?.tickSpacing !== 1) {
    throw new Error("Pharaoh launch-pair tick spacings do not match the validated pools");
  }
}

function parsePairs(raw: string): Record<string, PairConfig> {
  const parsed = parseJsonObject(raw, "PAIRS");
  const pairs: Record<string, PairConfig> = {};
  for (const [name, item] of Object.entries(parsed)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`PAIRS.${name} must be an object`);
    const pair = item as Record<string, unknown>;
    const base = address(String(pair.base ?? ""), `PAIRS.${name}.base`);
    const quote = address(String(pair.quote ?? ""), `PAIRS.${name}.quote`);
    if (base.toLowerCase() === quote.toLowerCase()) throw new Error(`PAIRS.${name} tokens must differ`);
    pairs[name] = { base, quote };
  }
  return pairs;
}

function parseDexVenues(raw: string, pairs: Record<string, PairConfig>): DexVenueConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DEX_VENUES must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) {
    throw new Error("DEX_VENUES requires 1 to 16 venues");
  }
  const ids = new Set<number>();
  const names = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`DEX_VENUES[${index}] must be an object`);
    }
    const value = item as Record<string, unknown>;
    const adapterId = integer(String(value.adapterId ?? ""), `DEX_VENUES[${index}].adapterId`, 0, 255);
    const name = String(value.name ?? "").trim();
    const kind = String(value.kind ?? "");
    if (!name) throw new Error(`DEX_VENUES[${index}].name is required`);
    if (ids.has(adapterId)) throw new Error("DEX_VENUES adapter ids must be unique");
    if (names.has(name.toLowerCase())) throw new Error("DEX_VENUES names must be unique");
    ids.add(adapterId);
    names.add(name.toLowerCase());

    if (kind === "mock") return { kind, name, adapterId };
    if (kind === "lfj") {
      return { kind, name, adapterId, quoter: address(String(value.quoter ?? ""), `${name}.quoter`) };
    }
    if (kind === "pharaoh") {
      const routeItems = parseRoutes(value.routes, pairs, name);
      const routes: PharaohVenueConfig["routes"] = {};
      for (const [pairName, route] of Object.entries(routeItems)) {
        const spacing = integer(String(route.tickSpacing ?? ""), `${name}.${pairName}.tickSpacing`, 1, 8_388_607);
        routes[pairName] = { tickSpacing: spacing };
      }
      return { kind, name, adapterId, routes };
    }
    if (kind === "blackhole") {
      const routeItems = parseRoutes(value.routes, pairs, name);
      const routes: BlackholeVenueConfig["routes"] = {};
      for (const [pairName, route] of Object.entries(routeItems)) {
        if (typeof route.stable !== "boolean" || typeof route.concentrated !== "boolean") {
          throw new Error(`${name}.${pairName} flags must be booleans`);
        }
        routes[pairName] = {
          pool: address(String(route.pool ?? ""), `${name}.${pairName}.pool`),
          stable: route.stable,
          concentrated: route.concentrated,
        };
      }
      return { kind, name, adapterId, routes };
    }
    throw new Error(`DEX_VENUES[${index}].kind is unsupported`);
  });
}

function parseRoutes(
  value: unknown,
  pairs: Record<string, PairConfig>,
  venue: string,
): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${venue}.routes is required`);
  const routes = value as Record<string, Record<string, unknown>>;
  for (const pairName of Object.keys(routes)) {
    if (!pairs[pairName]) throw new Error(`${venue} route references unknown pair ${pairName}`);
  }
  return routes;
}

function assertPair(pair: PairConfig | undefined, base: string, quote: string, name: string): void {
  if (!pair || pair.base.toLowerCase() !== base.toLowerCase() || pair.quote.toLowerCase() !== quote.toLowerCase()) {
    throw new Error(`mainnet ${name} token addresses do not match the pinned registry`);
  }
}

function assertBlackholeRoute(
  route: BlackholeVenueConfig["routes"][string] | undefined,
  pool: string,
  pairName: string,
): void {
  if (
    !route || route.pool.toLowerCase() !== pool.toLowerCase() || route.stable || !route.concentrated
  ) {
    throw new Error(`Blackhole ${pairName} route does not match the validated concentrated pool`);
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
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

function nonNegativeBigInt(value: string, label: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function httpUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    return url.toString();
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
}

function optionalPrivateKey(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("KEEPER_PRIVATE_KEY is invalid");
  return value;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}
