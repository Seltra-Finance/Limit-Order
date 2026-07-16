/**
 * Seed a small sequence of real Fuji P2P fills at distinct prices.
 *
 * Requires FILLER_PRIVATE_KEY and COUNTERPARTY_PRIVATE_KEY. Both accounts use
 * Fuji demo tokens only. Each fill is simulated before it is broadcast.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";

import { SETTLEMENT_ABI } from "../src/abi.js";
import { typedDataForSigning } from "../src/permit2.js";
import { orderToJson, permitToJson, type Order, type PermitTransferFrom } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const addresses = JSON.parse(readFileSync(path.join(here, "../../contracts/addresses.fuji.json"), "utf8"));
const RPC = process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
const TOKEN_ABI = ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"];
const OFFERS = ["40.02", "40.12", "40.22", "40.32", "40.42"];
const BASE_AMOUNT = parseUnits("1", 18);
const SURPLUS = parseUnits("0.10", 6);

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomUint256(): bigint {
  return BigInt(`0x${randomBytes(32).toString("hex")}`);
}

async function main() {
  const provider = new JsonRpcProvider(RPC, 43113);
  const filler = new Wallet(required(process.env.FILLER_PRIVATE_KEY, "FILLER_PRIVATE_KEY"), provider);
  const counterparty = new Wallet(required(process.env.COUNTERPARTY_PRIVATE_KEY, "COUNTERPARTY_PRIVATE_KEY"), provider);
  const settlement = new Contract(addresses.settlement, SETTLEMENT_ABI, filler);
  const base = new Contract(addresses.baseToken, TOKEN_ABI, filler);
  const quote = new Contract(addresses.quoteToken, TOKEN_ABI, filler);

  if (await settlement.fillsPaused()) throw new Error("fills are paused");
  if ((await provider.getBalance(counterparty.address)) < parseEther("0.01")) {
    await (await filler.sendTransaction({ to: counterparty.address, value: parseEther("0.01") })).wait();
  }

  const offerAmounts = OFFERS.map((price) => parseUnits(price, 6));
  const totalQuote = offerAmounts.reduce((total, amount) => total + amount, 0n);
  await (await base.mint(filler.address, BASE_AMOUNT * BigInt(OFFERS.length))).wait();
  await (await base.approve(addresses.permit2, 2n ** 256n - 1n)).wait();
  await (await quote.mint(counterparty.address, totalQuote)).wait();
  await (await (quote.connect(counterparty) as Contract).approve(addresses.permit2, 2n ** 256n - 1n)).wait();

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const fillerEpoch = BigInt(await settlement.currentEpoch(filler.address));
  const counterpartyEpoch = BigInt(await settlement.currentEpoch(counterparty.address));
  const results: Array<{ offer: string; txHash: string }> = [];

  for (let index = 0; index < offerAmounts.length; index += 1) {
    const offer = offerAmounts[index];
    const sell: Order = {
      maker: filler.address,
      receiver: filler.address,
      makerAsset: addresses.baseToken,
      takerAsset: addresses.quoteToken,
      makingAmount: BASE_AMOUNT,
      takingAmount: offer - SURPLUS,
      salt: randomUint256(),
      epoch: fillerEpoch,
      expiry,
      allowedSender: "0x0000000000000000000000000000000000000000",
      flags: 0,
    };
    const buy: Order = {
      maker: counterparty.address,
      receiver: counterparty.address,
      makerAsset: addresses.quoteToken,
      takerAsset: addresses.baseToken,
      makingAmount: offer,
      takingAmount: BASE_AMOUNT,
      salt: randomUint256(),
      epoch: counterpartyEpoch,
      expiry,
      allowedSender: "0x0000000000000000000000000000000000000000",
      flags: 0,
    };
    const sellPermit: PermitTransferFrom = { permitted: { token: sell.makerAsset, amount: sell.makingAmount }, nonce: randomUint256(), deadline: expiry };
    const buyPermit: PermitTransferFrom = { permitted: { token: buy.makerAsset, amount: buy.makingAmount }, nonce: randomUint256(), deadline: expiry };
    const sellTypedData = typedDataForSigning(sell, sellPermit, addresses.settlement, 43113, addresses.permit2);
    const buyTypedData = typedDataForSigning(buy, buyPermit, addresses.settlement, 43113, addresses.permit2);
    const sellSignature = await filler.signTypedData(sellTypedData.domain, sellTypedData.types, sellTypedData.value);
    const buySignature = await counterparty.signTypedData(buyTypedData.domain, buyTypedData.types, buyTypedData.value);
    const args = [orderToJson(sell), permitToJson(sellPermit), sellSignature, orderToJson(buy), permitToJson(buyPermit), buySignature];

    await settlement.fillOrderP2P.staticCall(...args);
    const receipt = await (await settlement.fillOrderP2P(...args)).wait();
    results.push({ offer: OFFERS[index], txHash: receipt.hash });
  }

  console.log(JSON.stringify({ filler: filler.address, counterparty: counterparty.address, fills: results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
