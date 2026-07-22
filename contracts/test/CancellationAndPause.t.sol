// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraTestBase} from "./utils/SeltraTestBase.sol";
import {SeltraSettlement} from "../src/SeltraSettlement.sol";
import {Order} from "../src/libraries/OrderLib.sol";

/// @notice Revised spec 1.3/7: single-order cancel is Permit2
///         invalidateUnorderedNonces; cancel-all is incrementEpoch; both stay
///         live while fills are guardian-paused.
contract CancellationAndPauseTest is SeltraTestBase {
    function setUp() public override {
        super.setUp();
        wavax.mint(maker, 100e18);
        _setMockMarket(address(wavax), address(usdc), 41e6, 1_000_000e6);
    }

    // ---------------------------------------------------------- cancellation

    function test_invalidateNonce_thenFillReverts() public {
        Order memory order = _defaultOrder();
        uint256 nonce = 5;
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, nonce);

        // Maker kills the specific nonce directly on Permit2 (SDK helper maps
        // nonce -> word/mask).
        vm.prank(maker);
        permit2.invalidateUnorderedNonces(nonce >> 8, uint256(1) << (nonce & 0xff));

        vm.expectRevert(abi.encodeWithSignature("InvalidNonce()"));
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_incrementEpoch_massCancels() public {
        Order memory o1 = _defaultOrder();
        Order memory o2 = _defaultOrder();
        o2.salt = 2;
        (ISignatureTransfer.PermitTransferFrom memory p1, bytes memory s1) = _signed(makerKey, o1, 1);
        (ISignatureTransfer.PermitTransferFrom memory p2, bytes memory s2) = _signed(makerKey, o2, 2);

        vm.expectEmit(true, false, false, true);
        emit SeltraSettlement.EpochIncremented(maker, 1);
        vm.prank(maker);
        settlement.incrementEpoch();

        vm.startPrank(keeper);
        vm.expectRevert(SeltraSettlement.InvalidEpoch.selector);
        settlement.fillOrderDEX(o1, p1, s1, _route());
        vm.expectRevert(SeltraSettlement.InvalidEpoch.selector);
        settlement.fillOrderDEX(o2, p2, s2, _route());
        vm.stopPrank();
    }

    function test_newEpochOrderFillsNormally() public {
        vm.prank(maker);
        settlement.incrementEpoch();

        Order memory order = _defaultOrder();
        order.epoch = 1;
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
        assertEq(usdc.balanceOf(maker), 407e6);
    }

    function test_epochOnlyAffectsThatMaker() public {
        vm.prank(makerB);
        settlement.incrementEpoch();

        Order memory order = _defaultOrder(); // maker A, epoch 0
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
        assertEq(usdc.balanceOf(maker), 407e6);
    }

    // ----------------------------------------------------------------- pause

    function test_pause_blocksBothFillPaths() public {
        vm.expectEmit(false, false, false, true);
        emit SeltraSettlement.FillsPaused(guardian);
        vm.prank(guardian);
        settlement.pauseFills();

        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.startPrank(keeper);
        vm.expectRevert(SeltraSettlement.FillsPausedError.selector);
        settlement.fillOrderDEX(order, permit, sig, _route());
        vm.expectRevert(SeltraSettlement.FillsPausedError.selector);
        settlement.fillOrderP2P(order, permit, sig, order, permit, sig);
        vm.stopPrank();
    }

    /// @dev Spec 7: pause blocks fills only; users can always kill orders.
    function test_pause_cancellationPathsStayLive() public {
        vm.prank(guardian);
        settlement.pauseFills();

        // Epoch increment works while paused.
        vm.prank(maker);
        settlement.incrementEpoch();
        assertEq(settlement.currentEpoch(maker), 1);

        // Permit2 nonce invalidation works while paused (Permit2 is not
        // pausable by anyone, by construction).
        vm.prank(maker);
        permit2.invalidateUnorderedNonces(0, 1);
    }

    function test_pause_auth() public {
        vm.expectRevert(SeltraSettlement.NotGuardian.selector);
        vm.prank(keeper);
        settlement.pauseFills();

        vm.prank(guardian);
        settlement.pauseFills();

        // Guardian cannot unpause; owner can.
        vm.expectRevert();
        vm.prank(guardian);
        settlement.unpauseFills();

        vm.prank(owner);
        settlement.unpauseFills();

        // Fills work again.
        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
        assertEq(usdc.balanceOf(maker), 407e6);
    }

    // ----------------------------------------------------------------- admin

    function test_setSurplusParams_capsAndAuth() public {
        vm.startPrank(owner);
        vm.expectRevert(SeltraSettlement.BadFeeParams.selector);
        settlement.setSurplusParams(10_001, 0, address(0));

        vm.expectRevert(SeltraSettlement.BadFeeParams.selector);
        settlement.setSurplusParams(7_000, 1_001, treasury);

        vm.expectRevert(SeltraSettlement.ZeroAddress.selector);
        settlement.setSurplusParams(7_000, 100, address(0));
        vm.stopPrank();

        vm.expectRevert();
        vm.prank(keeper);
        settlement.setSurplusParams(5_000, 0, address(0));

        vm.prank(owner);
        settlement.setSurplusParams(5_000, 500, treasury);
        assertEq(settlement.makerSurplusBps(), 5_000);
        assertEq(settlement.keeperSurplusBps(), 5_000);
    }

    function test_setTokenAllowed_onlyOwner() public {
        vm.expectRevert();
        vm.prank(keeper);
        settlement.setTokenAllowed(address(wavax), false);
    }

    function test_setPairAllowed_isUnorderedAndOwnerOnly() public {
        assertTrue(settlement.isPairAllowed(address(wavax), address(usdc)));
        assertTrue(settlement.isPairAllowed(address(usdc), address(wavax)));

        vm.expectRevert();
        vm.prank(keeper);
        settlement.setPairAllowed(address(wavax), address(usdc), false);

        vm.prank(owner);
        settlement.setPairAllowed(address(usdc), address(wavax), false);
        assertFalse(settlement.isPairAllowed(address(wavax), address(usdc)));
    }

    function test_unregisteredPair_revertsBeforeFundsMove() public {
        vm.prank(owner);
        settlement.setPairAllowed(address(wavax), address(usdc), false);

        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.expectRevert(abi.encodeWithSelector(SeltraSettlement.PairNotAllowed.selector, address(wavax), address(usdc)));
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
        assertEq(wavax.balanceOf(maker), 100e18);
    }

    function test_setPairAllowed_rejectsInvalidEndpoints() public {
        vm.startPrank(owner);
        vm.expectRevert(SeltraSettlement.ZeroAddress.selector);
        settlement.setPairAllowed(address(0), address(usdc), true);
        vm.expectRevert(SeltraSettlement.SameToken.selector);
        settlement.setPairAllowed(address(wavax), address(wavax), true);
        vm.stopPrank();
    }
}
