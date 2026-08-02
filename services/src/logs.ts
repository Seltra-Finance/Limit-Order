import type { Interface, Log, Provider, Result } from "ethers";

export interface ContractLogSource {
  address: string;
  interface: Interface;
  events: string[];
}

export interface ParsedContractLog {
  address: string;
  name: string;
  args: Result;
  blockNumber: number;
  index: number;
  transactionHash: string;
}

/**
 * Queries several event signatures and contract addresses through one
 * eth_getLogs request. Alchemy charges each eth_getLogs call independently,
 * so OR-ing topic zero avoids the former one-request-per-event multiplier.
 */
export async function queryParsedContractLogs(
  provider: Provider,
  sources: ContractLogSource[],
  fromBlock: number,
  toBlock: number,
): Promise<ParsedContractLog[]> {
  const topicZero = sources.flatMap((source) =>
    source.events.map((name) => {
      const fragment = source.interface.getEvent(name);
      if (!fragment) throw new Error(`event ${name} is missing from the contract interface`);
      return fragment.topicHash;
    })
  );
  const logs = await provider.getLogs({
    address: sources.map((source) => source.address),
    topics: [topicZero],
    fromBlock,
    toBlock,
  });

  const parsed: ParsedContractLog[] = [];
  for (const log of logs as Log[]) {
    const source = sources.find((candidate) =>
      candidate.address.toLowerCase() === log.address.toLowerCase()
    );
    if (!source) continue;
    const decoded = source.interface.parseLog({ data: log.data, topics: [...log.topics] });
    if (!decoded || !source.events.includes(decoded.name)) continue;
    parsed.push({
      address: log.address,
      name: decoded.name,
      args: decoded.args,
      blockNumber: log.blockNumber,
      index: log.index,
      transactionHash: log.transactionHash,
    });
  }
  return parsed.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
}
