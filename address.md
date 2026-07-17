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

## Safe Infrastructure

| Contract | Address |
|---|---|
| Safe v1.4.1 singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| Safe proxy factory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| Safe fallback handler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` |

These addresses are for Fuji testnet only and were deployed on 2026-07-17.
All five authored contracts have exact Sourcify matches. The Timelock is the
pending owner of Settlement and Router; its delayed acceptances become
executable on 2026-07-19 at 12:38 CEST. LFJ, Blackhole, and Pharaoh are not
registered in this testnet stack.
