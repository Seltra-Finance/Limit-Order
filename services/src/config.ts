export interface SeltraConfig {
  rpcUrl: string;
  chainId: number;
  permit2: string;
  settlement: string;
  router: string;
  /** allowlisted pairs, e.g. "WAVAX/USDC" -> {base, quote} token addresses */
  pairs: Record<string, { base: string; quote: string }>;
  apiPort: number;
  keeperPrivateKey?: string;
  databaseUrl?: string;
  /** adapterId the keeper routes DEX fills through */
  dexAdapterId: number;
  /** min keeper profit in quote-token wei before a DEX fill is submitted */
  keeperMinProfit: bigint;
  /** rollout caps (spec 2.4), quote-token units; 0 disables */
  keeperMaxOrderNotional: bigint;
  keeperDailyNotionalCap: bigint;
  pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SeltraConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing required env var ${k}`);
    return v;
  };
  return {
    rpcUrl: env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
    chainId: Number(env.CHAIN_ID ?? 43113),
    permit2: env.PERMIT2 ?? "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    settlement: required("SETTLEMENT"),
    router: required("ROUTER"),
    pairs: env.PAIRS ? JSON.parse(env.PAIRS) : {},
    apiPort: Number(env.API_PORT ?? 8080),
    keeperPrivateKey: env.KEEPER_PRIVATE_KEY,
    databaseUrl: env.DATABASE_URL,
    dexAdapterId: Number(env.DEX_ADAPTER_ID ?? 0),
    keeperMinProfit: BigInt(env.KEEPER_MIN_PROFIT ?? "0"),
    keeperMaxOrderNotional: BigInt(env.KEEPER_MAX_ORDER_NOTIONAL ?? "0"),
    keeperDailyNotionalCap: BigInt(env.KEEPER_DAILY_NOTIONAL_CAP ?? "0"),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 2000),
  };
}
