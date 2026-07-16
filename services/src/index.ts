import { Contract, JsonRpcProvider } from "ethers";

import { ERC20_ABI, SETTLEMENT_ABI } from "./abi.js";
import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { Indexer } from "./indexer.js";
import { Keeper } from "./keeper.js";
import { MatchingEngine, type Match } from "./matching.js";
import { emitAlert, SeltraMonitor } from "./monitor.js";
import { MemoryStore } from "./store.js";
import { PgStore } from "./pgStore.js";
import { PriceWatcher } from "./watcher.js";

/** Boots the full off-chain stack: orderbook API + matching engine + price
 *  watcher + keeper + indexer, wired together (revised spec 1.7-1.9). */
async function main(): Promise<void> {
  const config = loadConfig();
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  const store = config.databaseUrl ? new PgStore(config.databaseUrl) : new MemoryStore();
  const settlement = new Contract(config.settlement, SETTLEMENT_ABI, provider);

  const monitor = new SeltraMonitor(config, provider);

  const keeper = config.keeperPrivateKey
    ? new Keeper(config, provider, config.keeperPrivateKey, {
        onFilled: (hashes) => console.log("filled", hashes),
        onFailed: (hashes, reason) => {
          console.log("fill failed", hashes, reason.slice(0, 120));
          for (const alert of monitor.metrics.ingestKeeperFailure(Date.now())) {
            void emitAlert(alert, process.env.ALERT_WEBHOOK_URL);
          }
        },
      })
    : undefined;
  if (keeper) await keeper.sync();

  const engine = new MatchingEngine((match: Match) => {
    if (!keeper) return;
    void keeper.tryFillP2P(match).then((ok) => {
      if (ok) engine.settleMatch(match);
      else engine.releaseMatch(match, true, true); // re-evaluated; indexer prunes dead orders
    });
  });

  const api = buildApi({
    config,
    store,
    onNewOrder: (o) => engine.add(o),
    chain: {
      epochOf: async (maker) => BigInt(await settlement.currentEpoch(maker)),
      balanceOf: async (token, owner) => BigInt(await new Contract(token, ERC20_ABI, provider).balanceOf(owner)),
      permit2Allowance: async (token, owner) =>
        BigInt(await new Contract(token, ERC20_ABI, provider).allowance(owner, config.permit2)),
      isTokenAllowed: async (token) => Boolean(await settlement.allowedTokens(token)),
    },
  });

  const watcher = new PriceWatcher(config, provider, store, (order, quotedOut) => {
    if (keeper) void keeper.tryFillDEX(order, quotedOut);
  });

  const indexer = new Indexer(config, provider, store, {
    onFill: (orderHash) => {
      engine.remove(orderHash);
      api.broadcast({ type: "fill", data: { orderHash } });
    },
    onCancel: (orderHash) => {
      engine.remove(orderHash);
      api.broadcast({ type: "cancel", data: { orderHash } });
    },
  });

  await indexer.start();
  await monitor.start();
  watcher.start();
  await api.listen({ port: config.apiPort, host: "0.0.0.0" });
  console.log(`Seltra orderbook API on :${config.apiPort} (chain ${config.chainId})`);

  // Dashboard endpoint: rolling metrics snapshot (fills, match rate, surplus).
  api.get("/metrics", async () => ({
    ...monitor.metrics.snapshot(),
    fillsPerMinute: monitor.metrics.fillsPerMinute(),
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
