// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraTestBase} from "./utils/SeltraTestBase.sol";
import {SeltraSettlement} from "../src/SeltraSettlement.sol";
import {Order} from "../src/libraries/OrderLib.sol";

/// @dev Convention under test (revised spec 5.2): A sells base X (WAVAX) for
///      quote Y (USDC); B sells quote Y for base X. X leg exact-size, surplus
///      denominated in Y.
contract SettlementP2PTest is SeltraTestBase {
    function setUp() public override {
        super.setUp();
        wavax.mint(maker, 100e18);
        usdc.mint(makerB, 10_000e6);
    }

    /// @dev A: sell 10 WAVAX, demand >= 400 USDC. B: sell 405 USDC, demand
    ///      exactly A's 10 WAVAX. Crossed spread: 5 USDC.
    function _crossingPair() internal view returns (Order memory a, Order memory b) {
        a = _defaultOrder();
        b = Order({
            maker: makerB,
            receiver: makerB,
            makerAsset: address(usdc),
            takerAsset: address(wavax),
            makingAmount: 405e6,
            takingAmount: 10e18, // == a.makingAmount (exact X leg)
            salt: 2,
            epoch: 0,
            expiry: uint40(block.timestamp + 1 hours),
            allowedSender: address(0),
            flags: 0
        });
    }

    function _fill(Order memory a, Order memory b) internal {
        (ISignatureTransfer.PermitTransferFrom memory permitA, bytes memory sigA) = _signed(makerKey, a, 10);
        (ISignatureTransfer.PermitTransferFrom memory permitB, bytes memory sigB) = _signed(makerBKey, b, 20);
        vm.prank(keeper);
        settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
    }

    // Surplus 5 USDC: makerShare = 3.5 (70%), split 1.75/1.75; keeper 1.5.
    function test_p2p_happyPath_surplusSplit() public {
        (Order memory a, Order memory b) = _crossingPair();
        _fill(a, b);

        assertEq(wavax.balanceOf(makerB), 10e18, "B receives the exact X leg");
        assertEq(usdc.balanceOf(maker), 400e6 + 1.75e6, "A: takingAmount + half maker share");
        assertEq(usdc.balanceOf(makerB), 10_000e6 - 405e6 + 1.75e6, "B: half maker share back in Y");
        assertEq(usdc.balanceOf(keeper), 1.5e6, "keeper: 30% of spread");
        assertEq(usdc.balanceOf(address(settlement)), 0, "no funds stuck");
        assertEq(wavax.balanceOf(address(settlement)), 0, "no funds stuck");
    }

    function test_p2p_tokenConservation() public {
        (Order memory a, Order memory b) = _crossingPair();
        uint256 totalWavax = wavax.totalSupply();
        uint256 totalUsdc = usdc.totalSupply();

        _fill(a, b);

        assertEq(
            wavax.balanceOf(maker) + wavax.balanceOf(makerB) + wavax.balanceOf(keeper) + wavax.balanceOf(treasury),
            totalWavax,
            "X in == X out"
        );
        assertEq(
            usdc.balanceOf(maker) + usdc.balanceOf(makerB) + usdc.balanceOf(keeper) + usdc.balanceOf(treasury),
            totalUsdc,
            "Y in == Y out"
        );
    }

    function test_p2p_zeroSurplusExactCross() public {
        (Order memory a, Order memory b) = _crossingPair();
        b.makingAmount = 400e6; // B offers exactly A's demand: zero spread

        _fill(a, b);
        assertEq(usdc.balanceOf(maker), 400e6);
        assertEq(wavax.balanceOf(makerB), 10e18);
        assertEq(usdc.balanceOf(keeper), 0, "nothing above the limits");
    }

    function test_p2p_revert_sizeMismatch() public {
        (Order memory a, Order memory b) = _crossingPair();
        b.takingAmount = 9e18; // X leg no longer exact

        (ISignatureTransfer.PermitTransferFrom memory permitA, bytes memory sigA) = _signed(makerKey, a, 10);
        (ISignatureTransfer.PermitTransferFrom memory permitB, bytes memory sigB) = _signed(makerBKey, b, 20);
        vm.expectRevert(SeltraSettlement.SizeMismatch.selector);
        vm.prank(keeper);
        settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
    }

    function test_p2p_revert_priceNotCrossed() public {
        (Order memory a, Order memory b) = _crossingPair();
        b.makingAmount = 399e6; // B's max price below A's min price

        (ISignatureTransfer.PermitTransferFrom memory permitA, bytes memory sigA) = _signed(makerKey, a, 10);
        (ISignatureTransfer.PermitTransferFrom memory permitB, bytes memory sigB) = _signed(makerBKey, b, 20);
        vm.expectRevert(SeltraSettlement.PriceNotCrossed.selector);
        vm.prank(keeper);
        settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
    }

    function test_p2p_revert_assetMismatch() public {
        (Order memory a, Order memory b) = _crossingPair();
        b.makerAsset = address(wavax);

        (ISignatureTransfer.PermitTransferFrom memory permitA, bytes memory sigA) = _signed(makerKey, a, 10);
        (ISignatureTransfer.PermitTransferFrom memory permitB, bytes memory sigB) = _signed(makerBKey, b, 20);
        vm.expectRevert(SeltraSettlement.AssetMismatch.selector);
        vm.prank(keeper);
        settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
    }

    /// @dev Spec 1.4 acceptance: the same order cannot be spent on both paths.
    function test_p2p_revert_doubleSpendAcrossPaths() public {
        _setMockMarket(address(wavax), address(usdc), 41e6, 1_000_000e6);

        Order memory a = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permitA, bytes memory sigA) = _signed(makerKey, a, 10);

        // Fill A on the DEX path first.
        vm.prank(keeper);
        settlement.fillOrderDEX(a, permitA, sigA, _route());

        // The identical signed order can no longer settle P2P: its Permit2
        // nonce is consumed.
        (, Order memory b) = _crossingPair();
        (ISignatureTransfer.PermitTransferFrom memory permitB, bytes memory sigB) = _signed(makerBKey, b, 20);
        wavax.mint(maker, 10e18);
        vm.expectRevert(abi.encodeWithSignature("InvalidNonce()"));
        vm.prank(keeper);
        settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
    }

    function test_p2p_makerShareOddWeiDustToKeeper() public {
        (Order memory a, Order memory b) = _crossingPair();
        // Surplus of 3 wei: makerShare = floor(3*0.7) = 2, split 1/1;
        // keeper side = 1 wei.
        a.takingAmount = 405e6 - 3;

        _fill(a, b);
        assertEq(usdc.balanceOf(maker), 405e6 - 3 + 1);
        assertEq(usdc.balanceOf(makerB), 10_000e6 - 405e6 + 1);
        assertEq(usdc.balanceOf(keeper), 1);
    }

    function test_p2p_protocolFee() public {
        vm.prank(owner);
        settlement.setSurplusParams(7_000, 1_000, treasury);

        (Order memory a, Order memory b) = _crossingPair();
        _fill(a, b);
        // keeper side 1.5 USDC, 10% protocol fee = 0.15.
        assertEq(usdc.balanceOf(treasury), 0.15e6);
        assertEq(usdc.balanceOf(keeper), 1.35e6);
    }

    function test_p2p_emitsEvent() public {
        (Order memory a, Order memory b) = _crossingPair();
        (ISignatureTransfer.PermitTransferFrom memory permitA, bytes memory sigA) = _signed(makerKey, a, 10);
        (ISignatureTransfer.PermitTransferFrom memory permitB, bytes memory sigB) = _signed(makerBKey, b, 20);

        vm.expectEmit(true, true, false, true);
        emit SeltraSettlement.OrderFilledP2P(
            settlement.hashOrder(a), settlement.hashOrder(b), 5e6, 1.75e6, 1.75e6, 1.5e6
        );
        vm.prank(keeper);
        settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
    }

    /// @dev Property test mirror (spec 1.8): the on-chain integer
    ///      cross-multiplication decides fill vs PriceNotCrossed exactly; the
    ///      off-chain engine's bigint math must agree (mirrored in
    ///      services/test/matching.test.ts over the same corpus).
    function testFuzz_crossConditionMirrorsOnChain(uint128 makingA, uint128 takingA, uint128 makingB) public {
        makingA = uint128(bound(makingA, 1, 1_000_000e18));
        takingA = uint128(bound(takingA, 1, 100_000_000e6));
        makingB = uint128(bound(makingB, 1, 100_000_000e6));

        (Order memory a, Order memory b) = _crossingPair();
        a.makingAmount = makingA;
        a.takingAmount = takingA;
        b.makingAmount = makingB;
        b.takingAmount = makingA; // keep X leg exact

        wavax.mint(maker, makingA);
        usdc.mint(makerB, makingB);

        bool crossed = uint256(makingB) * uint256(makingA) >= uint256(takingA) * uint256(makingA);

        (ISignatureTransfer.PermitTransferFrom memory permitA, bytes memory sigA) = _signed(makerKey, a, 10);
        (ISignatureTransfer.PermitTransferFrom memory permitB, bytes memory sigB) = _signed(makerBKey, b, 20);
        vm.prank(keeper);
        if (!crossed) {
            vm.expectRevert(SeltraSettlement.PriceNotCrossed.selector);
            settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
        } else {
            settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB);
            assertGe(usdc.balanceOf(maker), takingA, "maker invariant");
            assertEq(wavax.balanceOf(makerB), makingA);
        }
    }
}
