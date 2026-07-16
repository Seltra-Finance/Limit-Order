/**
 * Fuji maker CLI: provisions a fresh maker (dust AVAX for the one-time
 * Permit2 approval, demo-token mint), signs a Permit2 witness order, and
 * submits it to the orderbook API like a real user would.
 *
 *   npx tsx scripts/fuji-maker.ts sellBase  <makingBase>  <takingQuote>
 *   npx tsx scripts/fuji-maker.ts sellQuote <makingQuote> <takingBase>
 *
 * Amounts in human units (base = 18 decimals, quote = 6).
 * Env: PRIVATE_KEY (funder), FUJI_RPC_URL, API_URL (default :8080).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Contract, JsonRpcProvider, NonceManager, Wallet, parseEther, parseUnits } from "ethers";

import { typedDataForSigning } from "../src/permit2.js";
import type { Order, PermitTransferFrom } from "../src/types.js";
import { orderToJson, permitToJson } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const addresses = JSON.parse(readFileSync(path.join(here, "../../contracts/addresses.fuji.json"), "utf8"));

const RPC = process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
const API = process.env.API_URL ?? "http://127.0.0.1:8080";
const CHAIN_ID = 43113;

const TOKEN_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address,uint256) returns (bool)",
];

async function main() {
  const [side, makingStr, takingStr] = process.argv.slice(2);
  if (!side || !makingStr || !takingStr) throw new Error("usage: fuji-maker.ts <sellBase|sellQuote> <making> <taking>");
  const sellBase = side === "sellBase";

  const provider = new JsonRpcProvider(RPC, CHAIN_ID);
  const funder = new NonceManager(new Wallet(process.env.PRIVATE_KEY!, provider));
  const maker = new Wallet(Wallet.createRandom().privateKey, provider);

  const makerAsset = sellBase ? addresses.baseToken : addresses.quoteToken;
  const takerAsset = sellBase ? addresses.quoteToken : addresses.baseToken;
  const makingAmount = parseUnits(makingStr, sellBase ? 18 : 6);
  const takingAmount = parseUnits(takingStr, sellBase ? 6 : 18);

  // Provision: dust gas, tokens, one-time ERC20 -> Permit2 approval.
  await (await funder.sendTransaction({ to: maker.address, value: parseEther("0.02") })).wait();
  const token = new Contract(makerAsset, TOKEN_ABI, funder);
  await (await token.mint(maker.address, makingAmount)).wait();
  await (await (token.connect(maker) as Contract).approve(addresses.permit2, 2n ** 256n - 1n)).wait();

  const order: Order = {
    maker: maker.address,
    receiver: maker.address,
    makerAsset,
    takerAsset,
    makingAmount,
    takingAmount,
    salt: BigInt(Date.now()),
    epoch: 0n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
    allowedSender: "0x0000000000000000000000000000000000000000",
    flags: 0,
  };
  const permit: PermitTransferFrom = {
    permitted: { token: makerAsset, amount: makingAmount },
    nonce: BigInt(Math.floor(Math.random() * 2 ** 48)),
    deadline: order.expiry,
  };
  const { domain, types, value } = typedDataForSigning(order, permit, addresses.settlement, CHAIN_ID, addresses.permit2);
  const signature = await maker.signTypedData(domain, types, value);

  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: orderToJson(order), permit: permitToJson(permit), signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`API rejected order: ${JSON.stringify(body)}`);
  console.log(JSON.stringify({ maker: maker.address, ...body }));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
