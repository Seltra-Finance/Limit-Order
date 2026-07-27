# Seltra Protocol — Hybrid Limit Order DEX Aggregation on Avalanche C-Chain

Implementation of Seltra's revised V1 locked architecture: gasless resting
limit orders signed as Permit2 witnesses, settled either against aggregated
AMM liquidity (DEX path) or peer-to-peer between two crossing makers (P2P
path), with the maker always receiving at least their signed minimum plus a
70% share of any surplus.

## Layout

```
contracts/            Foundry project (Solidity 0.8.24)
  src/
    SeltraSettlement.sol          immutable settlement: witness checks, epoch,
                                 surplus split, guardian pause, token allowlist
    SeltraAggregationRouter.sol   settlement-only router, write-once adapter ids,
                                 per-adapter guardian pause
    SeltraArbExecutor.sol         isolated treasury-funded, atomic two-venue
                                 arbitrage; never consumes Seltra orders
    libraries/OrderLib.sol       Order struct, witness typehash + type string
    adapters/
      LFJLBAdapter.sol           V1 production adapter (LFJ Liquidity Book)
      BlackholeAdapter.sol       full-route-gated Blackhole launch adapter
      PharaohAdapter.sol         Pharaoh concentrated-liquidity adapter
      MockDEXAdapter.sol         Fuji/testing adapter with settable price
  test/                unit, fuzz, invariant suites; fork tests in test/fork
  script/Deploy.s.sol  one-command stack deploy, writes addresses.json
  script/DeployArbExecutor.s.sol  separate arb executor + dedicated adapters;
                                 never funds or trades from the deploy script
services/             TypeScript off-chain stack (Node 20+, ESM)
  src/
    permit2.ts         witness signing/hashing SDK (cross-checked vs Foundry)
    api.ts             orderbook REST + WebSocket (Fastify)
    matching.ts        continuous exact-size P2P matcher (overflow-safe comparison)
    watcher.ts         pool-state price watcher (per-order fillability)
    keeper.ts          route-bound, gas-aware simulate-then-submit keeper bot
    arbitrage.ts       cross-venue search, gas-aware profit bounds, execution,
                       and realized P&L accounting
    strategies.ts      bounded grid/DCA strategy lifecycle; martingale is
                       disabled unless explicitly feature-gated
    indexer.ts         event reconciler (fills, epochs, Permit2 cancels)
    store.ts/pgStore.ts  MemoryStore + Postgres store (schema.sql)
```

## Signature model (one signature per order)

There is **no Seltra EIP-712 domain and no Seltra nonce bitmap**. The maker signs
a single Permit2 `PermitWitnessTransferFrom` whose witness is the Seltra `Order`
struct (UniswapX architecture). Permit2 verifies the signature and consumes the
unordered nonce; `SeltraSettlement` verifies the economics in the witness.

- **Replay protection:** Permit2 unordered nonces.
- **Single-order cancel:** `permit2.invalidateUnorderedNonces(wordPos, mask)`
  (`services/src/permit2.ts: nonceToInvalidation`).
- **Cancel-all:** signed `order.epoch` must equal `currentEpoch[maker]`;
  `incrementEpoch()` kills all outstanding orders in one write.
- **Guardian pause** blocks fills only; both cancellation paths and expiry stay
  live while paused (tested).

The witness type string, order typehash, and full permit digest are pinned as
fixtures in **both** `contracts/test/OrderHash.t.sol` and
`services/test/permit2.test.ts`, so the Solidity hashing and the ethers signer
can never drift silently.

## Building and testing

Contracts (Foundry):

```sh
cd contracts
forge build
forge test                    # fork suites explicitly skip by default
FOUNDRY_PROFILE=ci forge test --mc InvariantsTest   # 10k+ run invariants

# all live venue forks (LFJ, Blackhole, Pharaoh) + canonical Permit2:
RUN_MAINNET_FORKS=1 AVAX_RPC_URL=https://api.avax.network/ext/bc/C/rpc \
  forge test --match-path 'test/fork/*.t.sol'
```

Services (Node):

```sh
cd services
npm install
npm test                      # digest cross-check, matcher property tests, API
npm run typecheck
```

## Deploying (Fuji)

The current accepted staging addresses are in `contracts/addresses.fuji.json`;
copyable public frontend values are in `fuji.frontend.env.example`. The staged
flow is `DeploySafe.s.sol` → `DeployFujiDemo.s.sol` → `Governance.s.sol`, then
both `acceptOwnership()` operations execute after the configured delay.

The script resolves the canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`),
deploying from vendored bytecode only if the chain lacks it, wires
router/settlement/adapters, applies the token allowlist, optionally hands
ownership to `OWNER` (multisig/timelock), and writes a deployment manifest.
`DEPLOY_MOCK_ADAPTER=false` for mainnet (the mock must never be registered
there). Adapter ids are `0` mock, `1` LFJ, `2` Blackhole, and `3` Pharaoh.
Mainnet Blackhole registration is pinned to the fork-validated WAVAX/USDC and
USDC/USDt concentrated pools in `Deploy.s.sol`.

Then run the off-chain stack:

```sh
cd services
SETTLEMENT=0x... ROUTER=0x... RPC_URL=$FUJI_RPC_URL CHAIN_ID=43113 \
KEEPER_PRIVATE_KEY=0x... \
PAIRS='{"WAVAX/USDC":{"base":"0x760D...","quote":"0x00B7..."}}' \
npm run dev
```

Postgres is mandatory on mainnet (apply `services/schema.sql` first); the
in-memory store remains available only for development. Copy
`services/.env.mainnet.example` for the strict production configuration.
The indexer resumes from a durable finalized-block checkpoint and replays
idempotently. Soft orderbook cancellation requires a maker signature over
`Seltra soft cancel\nchainId:<id>\norderHash:<lowercase hash>`; binding
cancellation remains Permit2 nonce invalidation or an epoch bump on-chain.

## Cross-DEX arbitrage and automation foundation

The arbitrage path is deliberately isolated from `SeltraSettlement` and the
public orderbook. `SeltraArbExecutor` can execute only a two-leg round trip
through two different write-once adapters, only for owner-allowlisted tokens,
and reverts atomically unless the starting-token balance grows by the required
minimum profit. Realized profit goes to the configured treasury; principal
stays in the executor. This activity is protocol-owned liquidity management,
not user order flow and must not be reported as Seltra volume or traction.

`services/src/arbitrage.ts` provides the corresponding off-chain primitives:
venue quotes, a two-leg slippage reserve, gas-cost conversion into the starting
token, exact-call simulation/submission, an in-flight guard, and realized P&L
records. `services/src/arbBot.ts` adds a dry-run-by-default continuous runner
with RPC failover, quote-age and gas-price gates, cooldowns, nonce locking,
circuit breaking, an append-only JSONL journal, and optional webhook alerts.
Run one non-submitting scan with `cd services && npm run arb:dry-run`; configure
it from `.env.arb.example`. Live mode is separately triple-gated and validates
the deployed executor before constructing a signer. `DeployArbExecutor.s.sol`
only deploys and configures the isolated contracts. It does not fund the
executor or submit a trade.

`services/src/strategies.ts` starts the user-automation control plane with
bounded finite-grid and DCA schemas, lifecycle transitions, expiry, per-order,
daily, and total-notional limits. Martingale remains disabled by default and,
even when feature-gated for development, is capped at six steps and 2x. These
are backend safety primitives—not authorization to trade user funds. A future
DCA executor still needs an explicit user authorization model (finite
pre-signatures or audited smart-account session permissions) before it can be
connected to live execution.

## Key invariants (enforced on-chain, verified in tests)

1. **Maker never shorted:** `amountOut >= order.takingAmount` is measured by
   balance delta at the settlement, and every payout must increase the
   receiver's balance by the exact nominal amount. Fee-on-transfer or anomalous
   rebasing behavior reverts atomically. Surplus splits only apply above the
   signed minimum (rounding dust goes to the keeper side).
2. **No double spend:** a Permit2 nonce consumed on either fill path can never
   be spent again (tested across paths, fuzzed, and invariant-tested).
3. **Token conservation on P2P:** X in == X out, Y in == Y out across maker
   receivers, keeper, and treasury.
4. **No arbitrary calls:** `RouteData` is `{adapterId, extra}` only — no
   targets, tokens, amounts, or receivers; the router is settlement-only,
   never delegatecalls, and adapter ids are write-once (LI.FI/Socket
   exploit-class hardening).
5. **No standing approvals to Seltra:** funds move per-fill via witness-bound
   Permit2 pulls; router approvals are exact-amount and reset to zero.

## Market orders

Market orders are an SDK/frontend concern, not a contract feature: a market
order is a **marketable limit order** — `takingAmount` set to the live quote
minus a slippage tolerance, with a short expiry (fill-or-kill semantics).
`services/src/market.ts` (`quoteMarketOut` + `buildMarketOrder`) builds one
ready for signing and `POST /orders`; the watcher flags it fillable on the
next tick and the keeper fills it in seconds. Unlike a raw AMM swap, the
slippage buffer is not dead headroom: the maker gets `makerSurplusBps` (70%)
of anything realized above the limit back as price improvement, and the order
can still match P2P for zero slippage.

## Phase 2 operations (implemented)

- **Governance**: `contracts/script/Governance.s.sol` deploys an OZ
  `TimelockController` (48h default; self-administered, multisig as
  proposer/executor) and walks the Ownable2Step handover of settlement +
  router + the Blackhole adapter through it (`deploy` → wait →
  `acceptOwnership`), plus generic
  `schedule`/`execute` for any owner action. A replacement topology is live on
  Fuji with Safe guardian
  `0x14A34367a552e40B136Ac4b8c3E3970Be2d6eE77` and 48-hour Timelock
  `0xE6690Ba148951140924DEE34415C4e49ADF6c1Ea`. Acceptance is scheduled for
  2026-07-18; until execution, ownership is deliberately still pending.
  Guardian pause remains instant; only the owner can unpause
  (`test/Governance.t.sol`).
- **Rollout caps** (spec 2.4): the keeper enforces `KEEPER_MAX_ORDER_NOTIONAL`
  and `KEEPER_DAILY_NOTIONAL_CAP` (quote-token units, per token, UTC-day
  budget, 0 disables) in `services/src/caps.ts`; fills outside the caps are
  never attempted.
- **Monitoring/alerting** (spec 2.3/3.5): `services/src/monitor.ts` tracks
  fills per path, P2P match rate, surplus/improvement/reward totals, and
  fires alerts for guardian pauses (critical), near-limit fill streaks
  (griefing signal), independent-quote deviation, and keeper revert spikes.
  Alerts go to console and an optional `ALERT_WEBHOOK_URL` (Slack-compatible
  JSON); `GET /metrics` on the API serves the dashboard snapshot.

## Deviations / notes for reviewers

- `unpauseFills` is `onlyOwner`; production sets owner = 48h timelock behind a
  multisig (spec: "owner or timelock"). Same for `addAdapter` ("onlyTimelock").
- LFJ V1 accepts direct routes only. It takes an explicit short deadline from
  the keeper inside `extra` and pins both path endpoints to the order.
- Pharaoh `extra` is `abi.encode(uint256 deadline, int24 tickSpacing)`; the
  adapter rejects expired deadlines and forwards the keeper value unchanged.
- The LFJ V2.2 fork tests use the official Avalanche LBQuoter
  `0x9A550a522BBaDFB69019b0432800Ed17855A51C3` and LBRouter
  `0x18556DA13313f3532c54711497A8FedAC273220E`.
- Blackhole route authorization binds the pair, endpoints, stable flag, and
  concentrated flag into one allowlist key. All four launch-pool bindings are
  independently quoted and swap-tested on an Avalanche mainnet fork. Pharaoh quotes use its deployed non-view QuoterV2 through
  client-side `eth_call`/`staticCall`.
- Goldsky subgraph manifests are not included; `services/src/indexer.ts` is the
  local reconciler over the same events and is the source of truth for the
  event schema a subgraph would index.
