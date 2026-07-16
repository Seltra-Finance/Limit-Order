/**
 * Live Fuji end-to-end test (Phase 1 acceptance).
 *
 * Prereqs: contracts deployed via DeployFujiDemo.s.sol (addresses.fuji.json),
 * and PRIVATE_KEY funded with Fuji AVAX.
 *
 *   cd services && npx tsx scripts/fuji-e2e.ts
 *
 * Flow:
 *   1. Spin up two fresh makers, fund them with dust AVAX for their one-time
 *      ERC-20 -> Permit2 approvals, and mint them demo tokens (open mint).
 *   2. DEX path: maker A signs a witness order (sell 10 sWAVAX >= 400 sUSDC);
 *      the keeper simulates then fills through the mock adapter at 41.
 *      Assert maker got 407 (taking + 70% of surplus), keeper 3.
 *   3. Replay the same fill: must revert inside Permit2 (nonce consumed).
 *   4. P2P path: maker A signs sell 10 sWAVAX >= 400 sUSDC, maker B signs
 *      sell 405 sUSDC for exactly 10 sWAVAX; keeper settles fillOrderP2P.
 *      Assert the 5 sUSDC spread split 1.75 / 1.75 / 1.5.
 *   5. Cancellation: maker A invalidates a nonce on Permit2; fill reverts.
 *   6. Optional guardian pause drill: pause -> fill reverts -> epoch bump still
 *      works -> unpause. Set SKIP_PAUSE_DRILL=1 when guardian is a Safe; exercise
 *      that role separately through the Safe action script.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Contract, JsonRpcProvider, NonceManager, Wallet, formatEther, parseEther } from "ethers";

import { typedDataForSigning, nonceToInvalidation } from "../src/permit2.js";
import type { Order, PermitTransferFrom } from "../src/types.js";
import { orderToJson, permitToJson } from "../src/types.js";
import { ERC20_ABI, PERMIT2_ABI, SETTLEMENT_ABI } from "../src/abi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const addresses = JSON.parse(readFileSync(path.join(here, "../../contracts/addresses.fuji.json"), "utf8"));

const RPC = process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
const CHAIN_ID = 43113;
const MOCK_ADAPTER_ID = 0;

const TESTERC20_ABI = [...ERC20_ABI, "function mint(address to, uint256 amount)", "function approve(address,uint256) returns (bool)"];

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const snowtrace = (tx: string) => `https://testnet.snowtrace.io/tx/${tx}`;

async function main() {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID);
  const pk = process.env.PRIVATE_KEY;
  req(pk, "PRIVATE_KEY env var required");
  const keeper = new NonceManager(new Wallet(pk, provider));
  const keeperAddr = await keeper.getAddress();

  const bal = await provider.getBalance(keeperAddr);
  console.log(`keeper/deployer ${keeperAddr} balance: ${formatEther(bal)} AVAX`);
  req(bal > parseEther("0.2"), "fund the deployer with Fuji AVAX first");

  const settlement = new Contract(addresses.settlement, SETTLEMENT_ABI, keeper);
  const permit2 = new Contract(addresses.permit2, PERMIT2_ABI, keeper);
  const base = new Contract(addresses.baseToken, TESTERC20_ABI, keeper); // sWAVAX (18)
  const quote = new Contract(addresses.quoteToken, TESTERC20_ABI, keeper); // sUSDC (6)

  // ---- 1. fresh makers -----------------------------------------------------
  const makerA = new Wallet(Wallet.createRandom().privateKey, provider);
  const makerB = new Wallet(Wallet.createRandom().privateKey, provider);
  console.log(`maker A ${makerA.address}\nmaker B ${makerB.address}`);

  for (const m of [makerA, makerB]) {
    await (await keeper.sendTransaction({ to: m.address, value: parseEther("0.05") })).wait();
  }
  await (await base.mint(makerA.address, 100n * 10n ** 18n)).wait();
  await (await quote.mint(makerB.address, 10_000n * 10n ** 6n)).wait();

  // One-time (and only) approval a maker ever grants: ERC-20 -> Permit2.
  await (await (base.connect(makerA) as Contract).approve(addresses.permit2, 2n ** 256n - 1n)).wait();
  await (await (quote.connect(makerB) as Contract).approve(addresses.permit2, 2n ** 256n - 1n)).wait();
  console.log("makers funded, minted, Permit2-approved");

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const mkOrder = (o: Partial<Order>): Order => ({
    maker: makerA.address,
    receiver: makerA.address,
    makerAsset: addresses.baseToken,
    takerAsset: addresses.quoteToken,
    makingAmount: 10n * 10n ** 18n,
    takingAmount: 400n * 10n ** 6n,
    salt: BigInt(Date.now()),
    epoch: 0n,
    expiry,
    allowedSender: "0x0000000000000000000000000000000000000000",
    flags: 0,
    ...o,
  });
  const mkPermit = (order: Order, nonce: bigint): PermitTransferFrom => ({
    permitted: { token: order.makerAsset, amount: order.makingAmount },
    nonce,
    deadline: order.expiry,
  });
  const sign = async (wallet: Wallet, order: Order, permit: PermitTransferFrom) => {
    const { domain, types, value } = typedDataForSigning(order, permit, addresses.settlement, CHAIN_ID, addresses.permit2);
    return wallet.signTypedData(domain, types, value);
  };

  // ---- 2. DEX fill ---------------------------------------------------------
  const orderA = mkOrder({ salt: 1n });
  const permitA = mkPermit(orderA, 1n);
  const sigA = await sign(makerA, orderA, permitA);
  const dexArgs = [orderToJson(orderA), permitToJson(permitA), sigA, { adapterId: MOCK_ADAPTER_ID, extra: "0x" }];

  await settlement.fillOrderDEX.staticCall(...dexArgs); // simulate first
  const dexTx = await (await settlement.fillOrderDEX(...dexArgs)).wait();
  console.log(`DEX fill confirmed: ${snowtrace(dexTx.hash)}`);

  const makerAQuote = BigInt(await quote.balanceOf(makerA.address));
  const keeperQuote = BigInt(await quote.balanceOf(keeperAddr));
  req(makerAQuote === 407n * 10n ** 6n, `maker A should hold 407 hUSDC, has ${makerAQuote}`);
  req(keeperQuote === 3n * 10n ** 6n, `keeper should hold 3 hUSDC, has ${keeperQuote}`);
  console.log("PASS: maker received 407 sUSDC (400 limit + 70% of 10 surplus), keeper 3 sUSDC");

  // ---- 3. replay must revert ----------------------------------------------
  let replayReverted = false;
  try {
    await settlement.fillOrderDEX.staticCall(...dexArgs);
  } catch {
    replayReverted = true;
  }
  req(replayReverted, "replay of a consumed Permit2 nonce must revert");
  console.log("PASS: replay reverted on consumed Permit2 nonce");

  // ---- 4. P2P match --------------------------------------------------------
  const p2pA = mkOrder({ salt: 2n });
  const p2pPermitA = mkPermit(p2pA, 2n);
  const p2pSigA = await sign(makerA, p2pA, p2pPermitA);

  const p2pB = mkOrder({
    maker: makerB.address,
    receiver: makerB.address,
    makerAsset: addresses.quoteToken,
    takerAsset: addresses.baseToken,
    makingAmount: 405n * 10n ** 6n,
    takingAmount: 10n * 10n ** 18n,
    salt: 3n,
  });
  const p2pPermitB = mkPermit(p2pB, 3n);
  const p2pSigB = await sign(makerB, p2pB, p2pPermitB);

  const p2pArgs = [
    orderToJson(p2pA), permitToJson(p2pPermitA), p2pSigA,
    orderToJson(p2pB), permitToJson(p2pPermitB), p2pSigB,
  ];
  await settlement.fillOrderP2P.staticCall(...p2pArgs);
  const p2pTx = await (await settlement.fillOrderP2P(...p2pArgs)).wait();
  console.log(`P2P fill confirmed: ${snowtrace(p2pTx.hash)}`);

  const aAfter = BigInt(await quote.balanceOf(makerA.address));
  const bBase = BigInt(await base.balanceOf(makerB.address));
  const bQuote = BigInt(await quote.balanceOf(makerB.address));
  const kAfter = BigInt(await quote.balanceOf(keeperAddr));
  req(aAfter - makerAQuote === 401_750_000n, `A should gain 401.75 hUSDC, gained ${aAfter - makerAQuote}`);
  req(bBase === 10n * 10n ** 18n, `B should hold 10 sWAVAX, has ${bBase}`);
  req(bQuote === 10_000n * 10n ** 6n - 405n * 10n ** 6n + 1_750_000n, `B quote balance off: ${bQuote}`);
  req(kAfter - keeperQuote === 1_500_000n, `keeper should gain 1.5 sUSDC, gained ${kAfter - keeperQuote}`);
  console.log("PASS: P2P spread 5 sUSDC split 1.75 / 1.75 / 1.5 (A / B / keeper)");

  // ---- 5. on-chain cancellation -------------------------------------------
  const cOrder = mkOrder({ salt: 4n });
  const cPermit = mkPermit(cOrder, 4n);
  const cSig = await sign(makerA, cOrder, cPermit);
  const inv = nonceToInvalidation(4n);
  await (await (permit2.connect(makerA) as Contract).invalidateUnorderedNonces(inv.wordPos, inv.mask)).wait();
  let cancelWorked = false;
  try {
    await settlement.fillOrderDEX.staticCall(orderToJson(cOrder), permitToJson(cPermit), cSig, {
      adapterId: MOCK_ADAPTER_ID,
      extra: "0x",
    });
  } catch {
    cancelWorked = true;
  }
  req(cancelWorked, "fill after invalidateUnorderedNonces must revert");
  console.log("PASS: Permit2 nonce cancellation blocks the fill");

  // ---- 6. guardian pause drill (spec 2.2) ----------------------------------
  if (process.env.SKIP_PAUSE_DRILL === "1") {
    console.log("SKIP: pause drill delegated to the deployed Safe guardian");
  } else {
    await (await settlement.getFunction("pauseFills")()).wait();
    let pausedBlocked = false;
    const pOrder = mkOrder({ salt: 5n });
    const pPermit = mkPermit(pOrder, 5n);
    const pSig = await sign(makerA, pOrder, pPermit);
    try {
      await settlement.fillOrderDEX.staticCall(orderToJson(pOrder), permitToJson(pPermit), pSig, {
        adapterId: MOCK_ADAPTER_ID,
        extra: "0x",
      });
    } catch {
      pausedBlocked = true;
    }
    req(pausedBlocked, "fills must be blocked while paused");
    // cancellation stays live while paused:
    await (await (settlement.connect(makerA) as Contract).incrementEpoch()).wait();
    await (await settlement.getFunction("unpauseFills")()).wait();
    console.log("PASS: pause drill (fills blocked, epoch bump live while paused, unpaused)");
  }

  console.log("\nAll live Fuji checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
