import { Contract, FallbackProvider, JsonRpcProvider, Wallet, type Provider } from "ethers";

import { ArbitrageExecutorClient, ArbitrageSearcher } from "./arbitrage.js";
import { loadArbitrageConfig, type ArbitrageRuntimeConfig } from "./arbConfig.js";
import {
  LfjArbitrageVenue,
  NativeGasCostOracle,
  PharaohArbitrageVenue,
} from "./arbitrageVenues.js";
import {
  ArbitrageRunner,
  JsonlArbitrageJournal,
  emitArbitrageAlert,
} from "./arbitrageRunner.js";

const EXECUTOR_READ_ABI = [
  "function operator() view returns (address)",
  "function executionsPaused() view returns (bool)",
  "function allowedTokens(address) view returns (bool)",
  "function adapters(uint8) view returns (address)",
  "function adapterPaused(uint8) view returns (bool)",
];

const LFJ_ADAPTER_READ_ABI = [
  "function ROUTER() view returns (address)",
  "function LB_ROUTER() view returns (address)",
  "function LB_QUOTER() view returns (address)",
];

const PHARAOH_ADAPTER_READ_ABI = [
  "function ROUTER() view returns (address)",
  "function PHARAOH_ROUTER() view returns (address)",
  "function PHARAOH_QUOTER() view returns (address)",
];

export function createFallbackProvider(config: Pick<ArbitrageRuntimeConfig, "rpcUrls" | "chainId">): Provider {
  const providers = config.rpcUrls.map(
    (url) => new JsonRpcProvider(url, config.chainId, { staticNetwork: true }),
  );
  if (providers.length === 1) return providers[0];
  return new FallbackProvider(
    providers.map((provider, index) => ({ provider, priority: index + 1, stallTimeout: 1_000, weight: 1 })),
    config.chainId,
    { quorum: 1 },
  );
}

export async function buildArbitrageRunner(config: ArbitrageRuntimeConfig): Promise<{
  runner: ArbitrageRunner;
  provider: Provider;
  journal: JsonlArbitrageJournal;
}> {
  const provider = createFallbackProvider(config);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`RPC chain mismatch: expected ${config.chainId}, got ${network.chainId}`);
  }

  await requireCode(provider, config.lfjQuoter, "LFJ quoter");
  await requireCode(provider, config.pharaohQuoter, "Pharaoh quoter");

  const lfj = new LfjArbitrageVenue(config.lfjQuoter, provider);
  const pharaoh = new PharaohArbitrageVenue(config.pharaohQuoter, provider, config.pharaohTickSpacing);
  const gasOracle = new NativeGasCostOracle(provider, lfj, {
    estimatedGasUnits: config.estimatedGasUnits,
    gasCostBufferBps: config.gasCostBufferBps,
    wrappedNative: config.wrappedNative,
  });
  const searchers = new Map(
    config.cycles.map((cycle) => [
      cycle.name,
      new ArbitrageSearcher([lfj, pharaoh], gasOracle.estimate, {
        slippageBps: config.slippageBps,
        minNetProfit: cycle.minNetProfit,
        deadlineSeconds: config.deadlineSeconds,
      }),
    ]),
  );

  let executor: ArbitrageExecutorClient | undefined;
  if (config.mode === "live") {
    await validateLiveExecutor(provider, config);
    executor = new ArbitrageExecutorClient(config.executorAddress!, provider, config.operatorPrivateKey!);
  }

  const journal = new JsonlArbitrageJournal(config.journalPath);
  const runner = new ArbitrageRunner(
    {
      mode: config.mode,
      pollIntervalMs: config.pollIntervalMs,
      cooldownMs: config.cooldownMs,
      maxQuoteAgeMs: config.maxQuoteAgeMs,
      maxFeePerGasWei: config.maxFeePerGasWei,
      maxConsecutiveFailures: config.maxConsecutiveFailures,
      failurePauseMs: config.failurePauseMs,
      slippageBps: config.slippageBps,
    },
    provider,
    searchers,
    journal,
    (nativeCost, tokenIn, deadline) => gasOracle.convertActual(nativeCost, tokenIn, deadline),
    executor,
    (alert) => emitArbitrageAlert(alert, config.alertWebhookUrl),
  );
  return { runner, provider, journal };
}

async function validateLiveExecutor(provider: Provider, config: ArbitrageRuntimeConfig): Promise<void> {
  const executorAddress = config.executorAddress!;
  await requireCode(provider, executorAddress, "arbitrage executor");
  const executor = new Contract(executorAddress, EXECUTOR_READ_ABI, provider);
  const expectedOperator = new Wallet(config.operatorPrivateKey!).address;
  const [operator, paused, lfjPaused, pharaohPaused, lfjAdapter, pharaohAdapter] = await Promise.all([
    executor.operator() as Promise<string>,
    executor.executionsPaused() as Promise<boolean>,
    executor.adapterPaused(1) as Promise<boolean>,
    executor.adapterPaused(3) as Promise<boolean>,
    executor.adapters(1) as Promise<string>,
    executor.adapters(3) as Promise<string>,
  ]);
  if (operator.toLowerCase() !== expectedOperator.toLowerCase()) throw new Error("operator key does not match executor");
  if (paused) throw new Error("arbitrage executor is paused");
  if (lfjPaused || pharaohPaused) throw new Error("an arbitrage adapter is paused");
  await requireCode(provider, lfjAdapter, "executor LFJ adapter");
  await requireCode(provider, pharaohAdapter, "executor Pharaoh adapter");
  const lfj = new Contract(lfjAdapter, LFJ_ADAPTER_READ_ABI, provider);
  const pharaoh = new Contract(pharaohAdapter, PHARAOH_ADAPTER_READ_ABI, provider);
  const [lfjExecutor, lfjRouter, lfjQuoter, pharaohExecutor, pharaohRouter, pharaohQuoter] = await Promise.all([
    lfj.ROUTER() as Promise<string>,
    lfj.LB_ROUTER() as Promise<string>,
    lfj.LB_QUOTER() as Promise<string>,
    pharaoh.ROUTER() as Promise<string>,
    pharaoh.PHARAOH_ROUTER() as Promise<string>,
    pharaoh.PHARAOH_QUOTER() as Promise<string>,
  ]);
  assertAddress(lfjExecutor, executorAddress, "LFJ adapter executor binding");
  assertAddress(pharaohExecutor, executorAddress, "Pharaoh adapter executor binding");
  assertAddress(lfjRouter, config.lfjRouter, "LFJ router");
  assertAddress(lfjQuoter, config.lfjQuoter, "LFJ quoter");
  assertAddress(pharaohRouter, config.pharaohRouter, "Pharaoh router");
  assertAddress(pharaohQuoter, config.pharaohQuoter, "Pharaoh quoter");

  for (const token of new Set(config.cycles.flatMap((cycle) => [cycle.tokenIn, cycle.tokenMid]))) {
    if (!await executor.allowedTokens(token)) throw new Error(`executor token is not allowlisted: ${token}`);
  }
}

function assertAddress(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function requireCode(provider: Provider, address: string, label: string): Promise<void> {
  if (await provider.getCode(address) === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

async function main(): Promise<void> {
  const config = loadArbitrageConfig();
  const { runner } = await buildArbitrageRunner(config);
  const once = process.argv.includes("--once");

  console.log(`Seltra arbitrage ${config.mode} on chain ${config.chainId}; cycles=${config.cycles.length}`);
  if (config.mode === "dry-run") console.log("dry-run: transaction submission is disabled");

  if (once) {
    for (const cycle of config.cycles) {
      const result = await runner.scanOnce(cycle);
      console.log(cycle.name, result.status);
    }
    return;
  }

  process.once("SIGINT", () => runner.stop());
  process.once("SIGTERM", () => runner.stop());
  await runner.start(config.cycles);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
