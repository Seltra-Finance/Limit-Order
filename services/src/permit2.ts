import { TypedDataEncoder, verifyTypedData, type TypedDataDomain } from "ethers";
import type { Order, PermitTransferFrom } from "./types.js";

/**
 * Permit2 witness signing (revised spec 1.2). The maker signs a single
 * PermitWitnessTransferFrom typed message with the Seltra Order struct as the
 * witness; ethers' TypedDataEncoder applies the EIP-712 rules (alphabetical
 * subtype ordering) that Permit2's PermitHash library expects. The resulting
 * digest is cross-checked against the Foundry fixture in
 * contracts/test/OrderHash.t.sol.
 */

export const ORDER_TYPE = [
  { name: "maker", type: "address" },
  { name: "receiver", type: "address" },
  { name: "makerAsset", type: "address" },
  { name: "takerAsset", type: "address" },
  { name: "makingAmount", type: "uint256" },
  { name: "takingAmount", type: "uint256" },
  { name: "salt", type: "uint256" },
  { name: "epoch", type: "uint256" },
  { name: "expiry", type: "uint40" },
  { name: "allowedSender", type: "address" },
  { name: "flags", type: "uint8" },
] as const;

export const PERMIT_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Order" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Order: [...ORDER_TYPE],
};

export function permit2Domain(chainId: number | bigint, permit2Address: string): TypedDataDomain {
  return { name: "Permit2", chainId, verifyingContract: permit2Address };
}

function witnessValue(order: Order, permit: PermitTransferFrom, settlement: string) {
  return {
    permitted: { token: permit.permitted.token, amount: permit.permitted.amount },
    spender: settlement,
    nonce: permit.nonce,
    deadline: permit.deadline,
    witness: order,
  };
}

/** keccak256 struct hash of the Order witness (mirrors OrderLib.hash). */
export function orderHash(order: Order): string {
  return TypedDataEncoder.from({ Order: [...ORDER_TYPE] }).hash(order);
}

/** Full PermitWitnessTransferFrom EIP-712 digest the maker signs. */
export function permitWitnessDigest(
  order: Order,
  permit: PermitTransferFrom,
  settlement: string,
  chainId: number | bigint,
  permit2Address: string,
): string {
  return TypedDataEncoder.hash(
    permit2Domain(chainId, permit2Address),
    PERMIT_WITNESS_TYPES,
    witnessValue(order, permit, settlement),
  );
}

/** Signer-side helper: arguments for wallet.signTypedData(...). */
export function typedDataForSigning(
  order: Order,
  permit: PermitTransferFrom,
  settlement: string,
  chainId: number | bigint,
  permit2Address: string,
) {
  return {
    domain: permit2Domain(chainId, permit2Address),
    types: PERMIT_WITNESS_TYPES,
    value: witnessValue(order, permit, settlement),
  };
}

/** Local signature validation for POST /orders (spec 1.7). */
export function recoverMaker(
  order: Order,
  permit: PermitTransferFrom,
  signature: string,
  settlement: string,
  chainId: number | bigint,
  permit2Address: string,
): string {
  return verifyTypedData(
    permit2Domain(chainId, permit2Address),
    PERMIT_WITNESS_TYPES,
    witnessValue(order, permit, settlement),
    signature,
  );
}

/**
 * Cancellation helper (spec 1.3): maps an order's Permit2 unordered nonce to
 * the (wordPos, mask) arguments of invalidateUnorderedNonces.
 */
export function nonceToInvalidation(nonce: bigint): { wordPos: bigint; mask: bigint } {
  return { wordPos: nonce >> 8n, mask: 1n << (nonce & 0xffn) };
}
