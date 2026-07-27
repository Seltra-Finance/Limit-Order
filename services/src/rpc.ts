import { FallbackProvider, JsonRpcProvider, type Provider } from "ethers";

import type { SeltraConfig } from "./config.js";

/** Primary-first RPC failover. Quorum one avoids coupling liveness to both providers. */
export function createRpcProvider(config: Pick<SeltraConfig, "rpcUrl" | "rpcUrls" | "chainId">): Provider {
  const urls = config.rpcUrls?.length ? config.rpcUrls : [config.rpcUrl];
  const providers = urls.map(
    (url) => new JsonRpcProvider(url, config.chainId, { staticNetwork: true }),
  );
  if (providers.length === 1) return providers[0];
  return new FallbackProvider(
    providers.map((provider, index) => ({ provider, priority: index + 1, stallTimeout: 1_000, weight: 1 })),
    config.chainId,
    { quorum: 1 },
  );
}
