import { AbiCoder } from "ethers";
import { describe, expect, it } from "vitest";

import { Keeper } from "../src/keeper.js";

describe("Keeper LFJ route encoding", () => {
  const tokenA = "0x00000000000000000000000000000000000000a1";
  const tokenB = "0x00000000000000000000000000000000000000b2";
  const tokenC = "0x00000000000000000000000000000000000000c3";

  it("encodes a direct route", () => {
    const encoded = Keeper.encodeLfjExtra(123n, [20n], [2], [tokenA, tokenB]);
    const decoded = AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256[]", "uint8[]", "address[]"],
      encoded,
    );
    expect(decoded[0]).toBe(123n);
    expect(decoded[3].map((token: string) => token.toLowerCase())).toEqual([tokenA, tokenB]);
  });

  it("rejects intermediate tokens", () => {
    expect(() => Keeper.encodeLfjExtra(123n, [20n, 20n], [2, 2], [tokenA, tokenC, tokenB])).toThrow(
      "Seltra V1 supports only direct LFJ routes",
    );
  });
});
