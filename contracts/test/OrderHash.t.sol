// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {Order, OrderLib} from "../src/libraries/OrderLib.sol";

/// @notice Revised spec 1.2 acceptance: the TS signer and on-chain
///         verification must agree on the Permit2 witness digest. This test
///         pins (a) the Order witness hash and (b) the full
///         PermitWitnessTransferFrom digest for a canonical fixture under the
///         canonical Permit2 address and Fuji chainId. The same constants are
///         asserted by services/test/permit2.test.ts against ethers'
///         TypedDataEncoder.
contract OrderHashTest is Test {
    address internal constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant FIXTURE_SETTLEMENT = 0x00000000000000000000000000000000DeaDBeef;
    uint256 internal constant FIXTURE_CHAIN_ID = 43113;
    uint256 internal constant FIXTURE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant FIXTURE_NONCE = 42;

    /// @dev Pinned fixtures, recomputed independently by the TS test suite.
    bytes32 internal constant EXPECTED_WITNESS_HASH =
        0x717f8e5da37156a43f1668adc570a75834280ea423294ae06d004ae8578bd347;
    bytes32 internal constant EXPECTED_PERMIT_DIGEST =
        0xa73198c609e2a5ebd586c57df3e40b121675a426c6eb799f89ba4c2756a39ba8;

    function _fixtureOrder() internal pure returns (Order memory) {
        return Order({
            maker: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, // addr of FIXTURE_KEY
            receiver: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            makerAsset: 0xd00ae08403B9bbb9124bB305C09058E32C39A48c, // Fuji WAVAX
            takerAsset: 0x5425890298aed601595a70AB815c96711a31Bc65, // Fuji USDC
            makingAmount: 10e18,
            takingAmount: 400e6,
            salt: 12345,
            epoch: 0,
            expiry: 1893456000, // 2030-01-01
            allowedSender: address(0),
            flags: 0
        });
    }

    function _hash(Order memory order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                OrderLib.ORDER_TYPEHASH,
                order.maker,
                order.receiver,
                order.makerAsset,
                order.takerAsset,
                order.makingAmount,
                order.takingAmount,
                order.salt,
                order.epoch,
                order.expiry,
                order.allowedSender,
                order.flags
            )
        );
    }

    /// @dev Mirrors Permit2's PermitHash.hashWithWitness + _hashTypedData for
    ///      the fixture domain, with no deployed contracts involved.
    function _permitDigest(Order memory order) internal pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                FIXTURE_CHAIN_ID,
                CANONICAL_PERMIT2
            )
        );
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                OrderLib.WITNESS_TYPE_STRING
            )
        );
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(
                keccak256("TokenPermissions(address token,uint256 amount)"), order.makerAsset, order.makingAmount
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash, tokenPermissionsHash, FIXTURE_SETTLEMENT, FIXTURE_NONCE, uint256(order.expiry), _hash(order)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function test_typehashMatchesSpecString() public pure {
        assertEq(
            OrderLib.ORDER_TYPEHASH,
            keccak256(
                "Order(address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags)"
            )
        );
    }

    /// @dev The witness type string must open with the witness declaration,
    ///      close the parent type, and list subtypes alphabetically
    ///      (Order < TokenPermissions), per the Permit2 SignatureTransfer spec.
    function test_witnessTypeStringShape() public pure {
        assertEq(
            OrderLib.WITNESS_TYPE_STRING,
            "Order witness)Order(address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags)TokenPermissions(address token,uint256 amount)"
        );
    }

    function test_fixturesPinned() public pure {
        Order memory order = _fixtureOrder();
        assertEq(_hash(order), EXPECTED_WITNESS_HASH, "witness hash fixture drifted");
        assertEq(_permitDigest(order), EXPECTED_PERMIT_DIGEST, "permit digest fixture drifted");
    }

    function test_signatureRoundtrip() public pure {
        bytes32 digest = _permitDigest(_fixtureOrder());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(FIXTURE_KEY, digest);
        assertEq(ecrecover(digest, v, r, s), 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266);
    }

    function test_witnessHashDependsOnEveryField() public pure {
        Order memory base = _fixtureOrder();
        bytes32 baseHash = _hash(base);

        Order memory o = base;
        o.maker = address(1);
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.receiver = address(1);
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.makerAsset = address(1);
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.takerAsset = address(1);
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.makingAmount = 1;
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.takingAmount = 1;
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.salt = 1;
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.epoch = 1;
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.expiry = 1;
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.allowedSender = address(1);
        assertNotEq(_hash(o), baseHash);
        o = base;
        o.flags = 1;
        assertNotEq(_hash(o), baseHash);
    }
}
