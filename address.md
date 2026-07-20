# Seltra Testnet Addresses

Network: Avalanche Fuji

Chain ID: `43113`

## Protocol

| Contract | Address |
|---|---|
| SeltraSettlement | `0x962F86c218eEdEbFd2AAc6cb35b5283232769848` |
| SeltraAggregationRouter | `0xba1f5399D6A09b73206EC9449e2ba1bA7db27257` |
| Mock DEX adapter (adapter ID 0) | `0xdaF27f9116801dC3afDB896721c25166A408282E` |
| Canonical Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Governance

| Component | Address |
|---|---|
| Safe guardian (1-of-1 testnet) | `0x14A34367a552e40B136Ac4b8c3E3970Be2d6eE77` |
| TimelockController (48 hours) | `0xE6690Ba148951140924DEE34415C4e49ADF6c1Ea` |
| Testnet deployer / Safe owner | `0x520F45f8e1A27EA7bcDfCe3A287C06f7a068C3a7` |

## Demo Tokens

| Token | Decimals | Address |
|---|---:|---|
| sWAVAX | 18 | `0x760D9a5B4ae94f5e6c3ce014e3C116544515C830` |
| sUSDC | 6 | `0x00B766567013BbCe12bF802f6E7C65F6da581Efe` |

## Arbitrage Executor Drill (Mock Only)

| Component | Address |
|---|---|
| SeltraArbExecutor | `0xD51461ffa0CCD3c249453a1F1C8DD1F5b72ee41E` |
| Mock venue A (adapter ID 1) | `0x6667173Db5DB14206AD66619FdCebD8025dEE527` |
| Mock venue B (adapter ID 3) | `0xBE00C7D159dB77C503c29d205f9ba73f8De508B9` |
| Owner / guardian / operator / treasury | `0x520F45f8e1A27EA7bcDfCe3A287C06f7a068C3a7` |

The following Fuji transactions were mined successfully on 2026-07-20:

| Check | Transaction hash |
|---|---|
| First two-leg arbitrage | `0x2cb0cf202959f08a5ef500ba80348176736f59125d823ee1b60d9f4d0a8f67ce` |
| Pause executions | `0x6e84cddbba616f00d3ca8587ef27ee7862475f5a0fb4c483c87e29e237277c2a` |
| Unpause executions | `0x7035e1f7bd740631d33fa257fcc06500eafa38f1b55c6437f26291ab5b41b8ca` |
| Second two-leg arbitrage | `0x7f8fde7a40cf60683ea2ba316e5d02ac81fe591e05a2181beadf852a1b02cd6a` |

Each test cycle swapped `1 sWAVAX` to `10 sUSDC` and back to
`1.02 sWAVAX`. After both cycles, the executor retained its `10 sWAVAX`
principal, held no residual `sUSDC`, transferred `0.04 sWAVAX` total test
profit to the treasury, and was left unpaused.

This drill uses open-mint demo tokens and deterministic mock prices. It has no
economic value and does not represent live DEX liquidity, organic protocol
volume, or a mainnet deployment.

## Safe Infrastructure

| Contract | Address |
|---|---|
| Safe v1.4.1 singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| Safe proxy factory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| Safe fallback handler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` |

These addresses are for Fuji testnet only. The original protocol stack was
deployed on 2026-07-17; the mock arbitrage drill was deployed on 2026-07-20.
All five original authored contracts have exact Sourcify matches. The Timelock
is the pending owner of Settlement and Router; its delayed acceptances became
executable on 2026-07-19 at 12:38 CEST. LFJ, Blackhole, and Pharaoh are not
registered in this testnet stack.
