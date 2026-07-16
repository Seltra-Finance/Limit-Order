// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraTestBase} from "./utils/SeltraTestBase.sol";
import {FeeOnTransferERC20} from "./utils/FeeOnTransferERC20.sol";
import {SeltraSettlement} from "../src/SeltraSettlement.sol";
import {RouteData} from "../src/interfaces/ISeltraAggregationRouter.sol";
import {Order} from "../src/libraries/OrderLib.sol";

contract SettlementDEXTest is SeltraTestBase {
    function setUp() public override {
        super.setUp();
        wavax.mint(maker, 100e18);
        // Mock market: 1 WAVAX -> 41 USDC (order limit is 40). Rate is wad
        // scaled with decimals baked in (18 -> 6): 41e6 out per 1e18 in.
        _setMockMarket(address(wavax), address(usdc), 41e6, 1_000_000e6);
    }

    // 410 USDC out vs 400 limit: surplus 10, maker improvement 7 (70%),
    // keeper side 3, no protocol fee by default.
    function test_fill_happyPath_surplusSplit() public {
        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.prank(keeper);
        uint256 amountOut = settlement.fillOrderDEX(order, permit, sig, _route());

        assertEq(amountOut, 410e6, "realized output");
        assertEq(usdc.balanceOf(maker), 407e6, "taking + 70% of surplus");
        assertEq(usdc.balanceOf(keeper), 3e6, "keeper gets 30%");
        assertEq(wavax.balanceOf(maker), 90e18, "maker sold makingAmount");
        assertEq(usdc.balanceOf(address(settlement)), 0, "no funds stuck");
        assertEq(wavax.balanceOf(address(settlement)), 0, "no funds stuck");
    }

    function test_fill_paysReceiverNotMaker() public {
        address coldWallet = makeAddr("coldWallet");
        Order memory order = _defaultOrder();
        order.receiver = coldWallet;
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
        assertEq(usdc.balanceOf(coldWallet), 407e6, "proceeds go to order.receiver");
        assertEq(usdc.balanceOf(maker), 0);
    }

    function test_fill_protocolFeeFromKeeperSide() public {
        vm.prank(owner);
        settlement.setSurplusParams(7_000, 1_000, treasury); // 10% of keeper side

        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());

        assertEq(usdc.balanceOf(maker), 407e6, "maker untouched by protocol fee");
        assertEq(usdc.balanceOf(treasury), 0.3e6, "10% of 3 USDC keeper side");
        assertEq(usdc.balanceOf(keeper), 2.7e6);
    }

    /// @dev Surplus of 3 wei: makerImprovement = floor(3*0.7) = 2, keeper gets
    ///      the rounding dust (spec 1.4: dust deterministically to keeper side).
    function test_fill_roundingDustToKeeper() public {
        vm.prank(owner);
        mock.setPrice(address(wavax), address(usdc), 40e6 + 1); // out = 400e6 + 10 wei... use exact
        // rate * 10e18 / 1e18 = 400e6 + 10; pick rate for surplus = 3 wei:
        // need out = takingAmount + 3 => rate = (400e6 + 3) * 1e18 / 10e18 not integer.
        // Use makingAmount = 1e18 and rate = 400e6 + 3 with takingAmount = 400e6.
        Order memory order = _defaultOrder();
        order.makingAmount = 1e18;
        order.takingAmount = 400e6;
        vm.prank(owner);
        mock.setPrice(address(wavax), address(usdc), 400e6 + 3);

        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());

        assertEq(usdc.balanceOf(maker), 400e6 + 2, "floor(3 * 7000 / 10000) = 2");
        assertEq(usdc.balanceOf(keeper), 1, "dust wei to keeper");
    }

    function test_fill_revert_replay_permit2NonceConsumed() public {
        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());

        // Replay reverts inside Permit2 on the consumed unordered nonce.
        vm.expectRevert(abi.encodeWithSignature("InvalidNonce()"));
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_tamperedWitnessField() public {
        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        // Keeper lowers the maker's limit after signing: witness hash changes,
        // Permit2 signature verification fails.
        order.takingAmount = 1;
        vm.expectRevert(abi.encodeWithSignature("InvalidSigner()"));
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_wrongKeySignature() public {
        Order memory order = _defaultOrder();
        ISignatureTransfer.PermitTransferFrom memory permit = _permitFor(order, 0);
        bytes memory sig = _signWitness(makerBKey, order, permit); // not the maker

        vm.expectRevert(abi.encodeWithSignature("InvalidSigner()"));
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_expired() public {
        Order memory order = _defaultOrder();
        order.expiry = uint40(block.timestamp - 1);
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.expectRevert(SeltraSettlement.OrderExpired.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_badMakerReceiverFlags() public {
        Order memory order = _defaultOrder();
        order.maker = address(0);
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.expectRevert(SeltraSettlement.BadMaker.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());

        order = _defaultOrder();
        order.receiver = address(0);
        (permit, sig) = _signed(makerKey, order, 0);
        vm.expectRevert(SeltraSettlement.BadReceiver.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());

        order = _defaultOrder();
        order.flags = 1;
        (permit, sig) = _signed(makerKey, order, 0);
        vm.expectRevert(SeltraSettlement.BadFlags.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_permitOrderConsistency() public {
        Order memory order = _defaultOrder();

        ISignatureTransfer.PermitTransferFrom memory permit = _permitFor(order, 0);
        permit.permitted.token = address(usdc);
        bytes memory sig = _signWitness(makerKey, order, permit);
        vm.expectRevert(SeltraSettlement.BadPermitToken.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());

        permit = _permitFor(order, 0);
        permit.permitted.amount = order.makingAmount - 1;
        sig = _signWitness(makerKey, order, permit);
        vm.expectRevert(SeltraSettlement.BadPermitAmount.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());

        permit = _permitFor(order, 0);
        permit.deadline = order.expiry + 1;
        sig = _signWitness(makerKey, order, permit);
        vm.expectRevert(SeltraSettlement.BadPermitDeadline.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_privateOrder() public {
        Order memory order = _defaultOrder();
        order.allowedSender = keeper;
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.expectRevert(SeltraSettlement.PrivateOrder.selector);
        vm.prank(makeAddr("otherKeeper"));
        settlement.fillOrderDEX(order, permit, sig, _route());

        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
        assertEq(usdc.balanceOf(maker), 407e6);
    }

    function test_fill_revert_insufficientOutput() public {
        vm.prank(owner);
        mock.setPrice(address(wavax), address(usdc), 39e6); // below the 40 limit

        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        // The router's own minOut check trips first (also derived from the
        // signed order); both layers enforce the same maker invariant.
        vm.expectRevert();
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_unknownAdapter() public {
        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.expectRevert(SeltraSettlement.UnknownAdapter.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, RouteData({adapterId: 9, extra: ""}));
    }

    function test_fill_revert_pausedAdapter() public {
        vm.prank(guardian);
        router.pauseAdapter(MOCK_ADAPTER_ID);

        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.expectRevert(SeltraSettlement.UnknownAdapter.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_revert_tokenNotAllowed() public {
        vm.prank(owner);
        settlement.setTokenAllowed(address(usdc), false);

        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);
        vm.expectRevert(abi.encodeWithSelector(SeltraSettlement.TokenNotAllowed.selector, address(usdc)));
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    /// @dev Fee-on-transfer takerAsset: balance-delta measurement sees only
    ///      the post-fee amount, so the fill reverts via InsufficientOutput
    ///      when the shaved output can no longer cover the limit (spec 1.4).
    function test_fill_feeOnTransferTakerAsset_revertsViaBalanceDelta() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20(500); // 5% fee
        _allowToken(address(fee));
        fee.mint(address(mock), 1_000_000e18);
        vm.prank(owner);
        mock.setPrice(address(wavax), address(fee), 40e18); // exactly at limit pre-fee

        Order memory order = _defaultOrder();
        order.takerAsset = address(fee);
        order.takingAmount = 400e18;
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.expectRevert(SeltraSettlement.InsufficientOutput.selector);
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    function test_fill_emitsEvent() public {
        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        vm.expectEmit(true, true, true, true);
        emit SeltraSettlement.OrderFilledDEX(
            settlement.hashOrder(order), maker, keeper, MOCK_ADAPTER_ID, 10e18, 410e6, 7e6, 3e6
        );
        vm.prank(keeper);
        settlement.fillOrderDEX(order, permit, sig, _route());
    }

    /// @dev Fuzz: whatever the price does, the maker either receives at least
    ///      their signed takingAmount (plus improvement) or the fill reverts.
    function testFuzz_makerInvariant(uint256 rate) public {
        rate = bound(rate, 1, 100e6);
        vm.prank(owner);
        mock.setPrice(address(wavax), address(usdc), rate);

        Order memory order = _defaultOrder();
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _signed(makerKey, order, 0);

        uint256 expectedOut = (order.makingAmount * rate) / 1e18;
        vm.prank(keeper);
        if (expectedOut < order.takingAmount) {
            vm.expectRevert();
            settlement.fillOrderDEX(order, permit, sig, _route());
        } else {
            settlement.fillOrderDEX(order, permit, sig, _route());
            uint256 surplus = expectedOut - order.takingAmount;
            uint256 improvement = (surplus * 7_000) / 10_000;
            assertEq(usdc.balanceOf(maker), order.takingAmount + improvement);
            assertGe(usdc.balanceOf(maker), order.takingAmount, "maker invariant");
            assertEq(usdc.balanceOf(keeper), surplus - improvement);
        }
    }
}
