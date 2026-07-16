import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";

import { nonceToInvalidation, orderHash, permitWitnessDigest, recoverMaker, typedDataForSigning } from "../src/permit2.js";
import type { Order, PermitTransferFrom } from "../src/types.js";

/**
 * Cross-check against contracts/test/OrderHash.t.sol (revised spec 1.2
 * acceptance): the TS signer and the Solidity witness hashing must produce
 * identical digests for the canonical fixture.
 */

const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const FIXTURE_SETTLEMENT = "0x00000000000000000000000000000000DeaDBeef";
const FIXTURE_CHAIN_ID = 43113;
const FIXTURE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Pinned in contracts/test/OrderHash.t.sol.
const EXPECTED_WITNESS_HASH = "0x717f8e5da37156a43f1668adc570a75834280ea423294ae06d004ae8578bd347";
const EXPECTED_PERMIT_DIGEST = "0xa73198c609e2a5ebd586c57df3e40b121675a426c6eb799f89ba4c2756a39ba8";

const fixtureOrder: Order = {
  maker: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  receiver: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  makerAsset: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
  takerAsset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  makingAmount: 10n * 10n ** 18n,
  takingAmount: 400n * 10n ** 6n,
  salt: 12345n,
  epoch: 0n,
  expiry: 1893456000n,
  allowedSender: "0x0000000000000000000000000000000000000000",
  flags: 0,
};

const fixturePermit: PermitTransferFrom = {
  permitted: { token: fixtureOrder.makerAsset, amount: fixtureOrder.makingAmount },
  nonce: 42n,
  deadline: fixtureOrder.expiry,
};

describe("Permit2 witness hashing (Solidity cross-check)", () => {
  it("order witness hash matches the Foundry fixture", () => {
    expect(orderHash(fixtureOrder)).toBe(EXPECTED_WITNESS_HASH);
  });

  it("full PermitWitnessTransferFrom digest matches the Foundry fixture", () => {
    const digest = permitWitnessDigest(
      fixtureOrder,
      fixturePermit,
      FIXTURE_SETTLEMENT,
      FIXTURE_CHAIN_ID,
      CANONICAL_PERMIT2,
    );
    expect(digest).toBe(EXPECTED_PERMIT_DIGEST);
  });

  it("signTypedData -> recoverMaker roundtrip", async () => {
    const wallet = new Wallet(FIXTURE_KEY);
    const { domain, types, value } = typedDataForSigning(
      fixtureOrder,
      fixturePermit,
      FIXTURE_SETTLEMENT,
      FIXTURE_CHAIN_ID,
      CANONICAL_PERMIT2,
    );
    const signature = await wallet.signTypedData(domain, types, value);
    const recovered = recoverMaker(
      fixtureOrder,
      fixturePermit,
      signature,
      FIXTURE_SETTLEMENT,
      FIXTURE_CHAIN_ID,
      CANONICAL_PERMIT2,
    );
    expect(recovered).toBe(wallet.address);
  });

  it("a modified witness field changes the digest", () => {
    const tampered = { ...fixtureOrder, takingAmount: 1n };
    expect(orderHash(tampered)).not.toBe(EXPECTED_WITNESS_HASH);
    expect(
      permitWitnessDigest(tampered, fixturePermit, FIXTURE_SETTLEMENT, FIXTURE_CHAIN_ID, CANONICAL_PERMIT2),
    ).not.toBe(EXPECTED_PERMIT_DIGEST);
  });

  it("nonce -> invalidateUnorderedNonces (wordPos, mask)", () => {
    expect(nonceToInvalidation(0n)).toEqual({ wordPos: 0n, mask: 1n });
    expect(nonceToInvalidation(255n)).toEqual({ wordPos: 0n, mask: 1n << 255n });
    expect(nonceToInvalidation(256n)).toEqual({ wordPos: 1n, mask: 1n });
    expect(nonceToInvalidation(42n)).toEqual({ wordPos: 0n, mask: 1n << 42n });
  });
});
