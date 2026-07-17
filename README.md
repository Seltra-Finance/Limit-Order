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
    libraries/OrderLib.sol       Order struct, witness typehash + type string
    adapters/
      LFJLBAdapter.sol           V1 production adapter (LFJ Liquidity Book)
      BlackholeAdapter.sol       quarantined Blackhole pre-work, full-route gated
      PharaohAdapter.sol         Pharaoh concentrated-liquidity adapter
      MockDEXAdapter.sol         Fuji/testing adapter with settable price
  test/                unit, fuzz, invariant suites; fork tests in test/fork
  script/Deploy.s.sol  one-command stack deploy, writes addresses.json
services/             TypeScript off-chain stack (Node 20+, ESM)
  src/
    permit2.ts         witness signing/hashing SDK (cross-checked vs Foundry)
    api.ts             orderbook REST + WebSocket (Fastify)
    matching.ts        continuous exact-size P2P matcher (overflow-safe comparison)
    watcher.ts         pool-state price watcher (per-order fillability)
    keeper.ts          simulate-then-submit keeper bot
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
there). Adapter ids are `0` mock, `1` LFJ, and `3` Pharaoh. ID `2` remains
reserved for Blackhole but is deliberately not registered by the production
deploy script until executable pool binding receives independent validation.

Then run the off-chain stack:

```sh
cd services
SETTLEMENT=0x... ROUTER=0x... RPC_URL=$FUJI_RPC_URL CHAIN_ID=43113 \
KEEPER_PRIVATE_KEY=0x... \
PAIRS='{"WAVAX/USDC":{"base":"0x760D...","quote":"0x00B7..."}}' \
npm run dev
```

Postgres is optional: set `DATABASE_URL` (apply `services/schema.sql` first) or
run on the in-memory store for dev.

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
  router through it (`deploy` → wait → `acceptOwnership`), plus generic
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
- The mainnet LBQuoter v2.1 in the fork tests was verified live on-chain at
  `0x64b57F4249aA99a812212cee7DAEFEDC40B203cD`; the LBRouter v2.1 address is
  the documented `0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30`.
- Blackhole route authorization binds the pair, endpoints, stable flag, and
  concentrated flag into one allowlist key. The adapter remains unregistered
  in V1 while its upstream pool-resolution behavior receives independent
  validation. Pharaoh quotes use its deployed non-view QuoterV2 through
  client-side `eth_call`/`staticCall`.
- Goldsky subgraph manifests are not included; `services/src/indexer.ts` is the
  local reconciler over the same events and is the source of truth for the
  event schema a subgraph would index.
