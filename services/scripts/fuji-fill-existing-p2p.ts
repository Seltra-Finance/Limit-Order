/**
 * Fill an existing Fuji base-sell order with a newly funded quote-side maker.
 *
 * Requires FILLER_PRIVATE_KEY and a running local order API. The script mints
 * Fuji demo sUSDC to the filler, creates a crossing witness order, simulates
 * fillOrderP2P, and broadcasts only after the simulation succeeds.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, parseUnits } from "ethers";

import { SETTLEMENT_ABI } from "../src/abi.js";
import { typedDataForSigning } from "../src/permit2.js";
import { orderFromJson, orderToJson, permitFromJson, permitToJson, type Order, type PermitTransferFrom } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const addresses = JSON.parse(readFileSync(path.join(here, "../../contracts/addresses.fuji.json"), "utf8"));

const RPC = process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
const API = process.env.API_URL ?? "http://127.0.0.1:8080";
const ORDER_HASH = process.env.ORDER_HASH ?? "0xfec9218d9fde56631fee0fd448fdaeab9b08597617f03698c9019ec9909030be";
const COUNTER_OFFER = parseUnits(process.env.COUNTER_OFFER ?? "40.30", 6);
const TOKEN_ABI = ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"];

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const provider = new JsonRpcProvider(RPC, 43113);
  const filler = new Wallet(required(process.env.FILLER_PRIVATE_KEY, "FILLER_PRIVATE_KEY"), provider);
  const settlement = new Contract(addresses.settlement, [...SETTLEMENT_ABI, "function protocolFeeBps() view returns (uint16)"], filler);
  const quote = new Contract(addresses.quoteToken, TOKEN_ABI, filler);

  const response = await fetch(`${API}/orders/${ORDER_HASH}`);
  if (!response.ok) throw new Error(`order API returned ${response.status}`);
  const stored = await response.json() as { order: Record<string, unknown>; permit: Record<string, unknown>; signature: string; status: string };
  if (stored.status !== "resting") throw new Error(`target order is ${stored.status}, not resting`);

  const target = orderFromJson(stored.order);
  const targetPermit = permitFromJson(stored.permit);
  if (target.makerAsset.toLowerCase() !== addresses.baseToken.toLowerCase() || target.takerAsset.toLowerCase() !== addresses.quoteToken.toLowerCase()) {
    throw new Error("target is not a base-sell / quote-buy Fuji demo order");
  }
  if (await settlement.fillsPaused()) throw new Error("fills are paused");
  if (BigInt(await settlement.currentEpoch(target.maker)) !== target.epoch) throw new Error("target maker epoch changed");
  if (target.expiry <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("target order expired");
  if (COUNTER_OFFER < target.takingAmount) throw new Error("counter offer does not cross target limit");

  const expiry = target.expiry < BigInt(Math.floor(Date.now() / 1000) + 3600) ? target.expiry : BigInt(Math.floor(Date.now() / 1000) + 3600);
  const counter: Order = {
    maker: filler.address,
    receiver: filler.address,
    makerAsset: addresses.quoteToken,
    takerAsset: addresses.baseToken,
    makingAmount: COUNTER_OFFER,
    takingAmount: target.makingAmount,
    salt: BigInt(`0x${randomBytes(32).toString("hex")}`),
    epoch: BigInt(await settlement.currentEpoch(filler.address)),
    expiry,
    allowedSender: "0x0000000000000000000000000000000000000000",
    flags: 0,
  };
  const permit: PermitTransferFrom = {
    permitted: { token: counter.makerAsset, amount: counter.makingAmount },
    nonce: BigInt(`0x${randomBytes(32).toString("hex")}`),
    deadline: counter.expiry,
  };
  const typedData = typedDataForSigning(counter, permit, addresses.settlement, 43113, addresses.permit2);
  const signature = await filler.signTypedData(typedData.domain, typedData.types, typedData.value);

  // Testnet-only demo token provisioning and the one-time ERC-20 -> Permit2 approval.
  await (await quote.mint(filler.address, counter.makingAmount)).wait();
  await (await quote.approve(addresses.permit2, 2n ** 256n - 1n)).wait();

  const args = [
    orderToJson(target), permitToJson(targetPermit), stored.signature,
    orderToJson(counter), permitToJson(permit), signature,
  ];
  await settlement.fillOrderP2P.staticCall(...args);

  const receipt = await (await settlement.fillOrderP2P(...args)).wait();
  const surplus = counter.makingAmount - target.takingAmount;
  const makerShare = (surplus * 7000n) / 10_000n;
  const protocolFeeBps = BigInt(await settlement.protocolFeeBps());
  const keeperSide = surplus - makerShare;
  const protocolFee = (keeperSide * protocolFeeBps) / 10_000n;

  console.log(JSON.stringify({
    txHash: receipt.hash,
    filler: filler.address,
    targetOrderHash: ORDER_HASH,
    counterOffer: counter.makingAmount.toString(),
    targetReceive: (target.takingAmount + makerShare / 2n).toString(),
    countermakerRefund: (makerShare - makerShare / 2n).toString(),
    keeperReward: (keeperSide - protocolFee).toString(),
    protocolFee: protocolFee.toString(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
