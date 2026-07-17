// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {MockDEXAdapter} from "../src/adapters/MockDEXAdapter.sol";
import {ISeltraAggregationRouter, RouteData} from "../src/interfaces/ISeltraAggregationRouter.sol";
import {Order, OrderLib} from "../src/libraries/OrderLib.sol";
import {TestERC20} from "./utils/TestERC20.sol";

/// @notice Revised spec 1.10 invariants:
///         1. The maker never receives less than takingAmount on any path.
///         2. A Permit2 nonce is never consumed twice.
///         3. Token conservation across P2P fills (and no residue anywhere).
///         4. Pause never blocks epoch increments.
contract SeltraHandler is Test {
    SeltraSettlement public settlement;
    ISignatureTransfer public permit2;
    MockDEXAdapter public mock;
    address public admin; // owner of settlement/router/mock
    address public guardianAddr;

    TestERC20 public wavax;
    TestERC20 public usdc;

    uint256 internal constant MAKER_A_KEY = 0xA11CE;
    uint256 internal constant MAKER_B_KEY = 0xB0B;
    address public makerA;
    address public makerB;
    address public keeper = address(0xCAFE);

    // ghost accounting
    uint256 public totalMintedWavax;
    uint256 public totalMintedUsdc;
    uint256 public fillCount;
    uint256 public makerShortfalls; // must stay 0
    uint256 public doubleConsumes; // must stay 0
    uint256 public epochBlockedWhilePaused; // must stay 0
    uint256 internal saltCounter;

    mapping(address => mapping(uint256 => bool)) public consumed;

    bytes32 internal immutable PERMIT_WITNESS_TYPEHASH;
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    constructor(
        SeltraSettlement settlement_,
        ISignatureTransfer permit2_,
        MockDEXAdapter mock_,
        address admin_,
        address guardian_,
        TestERC20 wavax_,
        TestERC20 usdc_
    ) {
        settlement = settlement_;
        permit2 = permit2_;
        mock = mock_;
        admin = admin_;
        guardianAddr = guardian_;
        wavax = wavax_;
        usdc = usdc_;
        makerA = vm.addr(MAKER_A_KEY);
        makerB = vm.addr(MAKER_B_KEY);

        PERMIT_WITNESS_TYPEHASH = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                OrderLib.WITNESS_TYPE_STRING
            )
        );

        vm.prank(makerA);
        wavax.approve(address(permit2), type(uint256).max);
        vm.prank(makerA);
        usdc.approve(address(permit2), type(uint256).max);
        vm.prank(makerB);
        wavax.approve(address(permit2), type(uint256).max);
        vm.prank(makerB);
        usdc.approve(address(permit2), type(uint256).max);
    }

    // ------------------------------------------------------------- signing

    function _orderHash(Order memory order) internal pure returns (bytes32) {
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

    function _sign(uint256 key, Order memory order, ISignatureTransfer.PermitTransferFrom memory permit)
        internal
        view
        returns (bytes memory)
    {
        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount));
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITNESS_TYPEHASH,
                tokenPermissionsHash,
                address(settlement),
                permit.nonce,
                permit.deadline,
                _orderHash(order)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", permit2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _order(address maker, uint256 makingAmount, uint256 takingAmount, bool sellWavax)
        internal
        returns (Order memory)
    {
        return Order({
            maker: maker,
            receiver: maker,
            makerAsset: sellWavax ? address(wavax) : address(usdc),
            takerAsset: sellWavax ? address(usdc) : address(wavax),
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            salt: ++saltCounter,
            epoch: settlement.currentEpoch(maker),
            expiry: uint40(block.timestamp + 1 days),
            allowedSender: address(0),
            flags: 0
        });
    }

    function _permitFor(Order memory order, uint256 nonce)
        internal
        pure
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: order.makerAsset, amount: order.makingAmount}),
            nonce: nonce,
            deadline: order.expiry
        });
    }

    // ------------------------------------------------------------- actions

    function fillDEX(uint256 nonce, uint256 makingAmount, uint256 takingAmount, uint256 rate) external {
        nonce = bound(nonce, 0, 511);
        makingAmount = bound(makingAmount, 1e12, 50e18);
        takingAmount = bound(takingAmount, 1e3, 5_000e6);
        rate = bound(rate, 1e5, 100e6);

        vm.prank(admin);
        mock.setPrice(address(wavax), address(usdc), rate);
        _mintUsdc(address(mock), (makingAmount * rate) / 1e18);
        _mintWavax(makerA, makingAmount);

        Order memory order = _order(makerA, makingAmount, takingAmount, true);
        ISignatureTransfer.PermitTransferFrom memory permit = _permitFor(order, nonce);
        bytes memory sig = _sign(MAKER_A_KEY, order, permit);

        uint256 before = usdc.balanceOf(makerA);
        vm.prank(keeper);
        try settlement.fillOrderDEX(order, permit, sig, RouteData({adapterId: 0, extra: ""})) {
            if (consumed[makerA][nonce]) doubleConsumes++;
            consumed[makerA][nonce] = true;
            if (usdc.balanceOf(makerA) - before < takingAmount) makerShortfalls++;
            fillCount++;
        } catch {}
    }

    function fillP2P(uint256 nonceA, uint256 nonceB, uint256 makingA, uint256 takingA, uint256 makingB) external {
        nonceA = bound(nonceA, 0, 511);
        nonceB = bound(nonceB, 0, 511);
        makingA = bound(makingA, 1, 50e18);
        takingA = bound(takingA, 1, 5_000e6);
        makingB = bound(makingB, 1, 6_000e6);

        _mintWavax(makerA, makingA);
        _mintUsdc(makerB, makingB);

        Order memory a = _order(makerA, makingA, takingA, true);
        Order memory b = _order(makerB, makingB, makingA, false); // b.takingAmount == a.makingAmount

        ISignatureTransfer.PermitTransferFrom memory permitA = _permitFor(a, nonceA);
        ISignatureTransfer.PermitTransferFrom memory permitB = _permitFor(b, nonceB);
        bytes memory sigA = _sign(MAKER_A_KEY, a, permitA);
        bytes memory sigB = _sign(MAKER_B_KEY, b, permitB);

        uint256 aBefore = usdc.balanceOf(makerA);
        uint256 bBefore = wavax.balanceOf(makerB);

        vm.prank(keeper);
        try settlement.fillOrderP2P(a, permitA, sigA, b, permitB, sigB) {
            if (consumed[makerA][nonceA] || consumed[makerB][nonceB]) doubleConsumes++;
            consumed[makerA][nonceA] = true;
            consumed[makerB][nonceB] = true;
            if (usdc.balanceOf(makerA) - aBefore < takingA) makerShortfalls++;
            if (wavax.balanceOf(makerB) - bBefore < makingA) makerShortfalls++;
            fillCount++;
        } catch {}
    }

    function cancelNonce(uint256 nonce) external {
        nonce = bound(nonce, 0, 511);
        vm.prank(makerA);
        permit2.invalidateUnorderedNonces(nonce >> 8, uint256(1) << (nonce & 0xff));
        consumed[makerA][nonce] = true;
    }

    /// @dev Epoch increments must always succeed, paused or not (spec 7).
    function bumpEpoch() external {
        vm.prank(makerA);
        try settlement.incrementEpoch() {}
        catch {
            epochBlockedWhilePaused++;
        }
    }

    function togglePause(bool pause) external {
        if (pause) {
            vm.prank(guardianAddr);
            settlement.pauseFills();
        } else {
            vm.prank(admin);
            settlement.unpauseFills();
        }
    }

    function _mintWavax(address to, uint256 amount) internal {
        wavax.mint(to, amount);
        totalMintedWavax += amount;
    }

    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
        totalMintedUsdc += amount;
    }
}

contract InvariantsTest is Test {
    SeltraSettlement internal settlement;
    SeltraAggregationRouter internal router;
    MockDEXAdapter internal mock;
    ISignatureTransfer internal permit2;
    TestERC20 internal wavax;
    TestERC20 internal usdc;
    SeltraHandler internal handler;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        address owner = makeAddr("owner");
        address guardian = makeAddr("guardian");
        permit2 = ISignatureTransfer(deployCode("Permit2.sol:Permit2"));
        router = new SeltraAggregationRouter(owner, guardian);
        mock = new MockDEXAdapter(address(router), owner);
        settlement = new SeltraSettlement(permit2, ISeltraAggregationRouter(address(router)), owner, guardian);

        wavax = new TestERC20("Wrapped AVAX", "WAVAX", 18);
        usdc = new TestERC20("USD Coin", "USDC", 6);

        vm.startPrank(owner);
        router.setSettlement(address(settlement));
        router.addAdapter(0, address(mock));
        settlement.setTokenAllowed(address(wavax), true);
        settlement.setTokenAllowed(address(usdc), true);
        settlement.setSurplusParams(7_000, 500, treasury);
        vm.stopPrank();

        handler = new SeltraHandler(settlement, permit2, mock, owner, guardian, wavax, usdc);
        targetContract(address(handler));
    }

    function invariant_makerNeverShorted() public view {
        assertEq(handler.makerShortfalls(), 0, "maker received less than signed takingAmount");
    }

    function invariant_nonceNeverDoubleConsumed() public view {
        assertEq(handler.doubleConsumes(), 0, "a consumed Permit2 nonce was reused");
    }

    function invariant_pauseNeverBlocksEpoch() public view {
        assertEq(handler.epochBlockedWhilePaused(), 0, "incrementEpoch failed");
    }

    function invariant_noResidueInProtocolContracts() public view {
        assertEq(wavax.balanceOf(address(settlement)), 0, "WAVAX stuck in settlement");
        assertEq(usdc.balanceOf(address(settlement)), 0, "USDC stuck in settlement");
        assertEq(wavax.balanceOf(address(router)), 0, "WAVAX stuck in router");
        assertEq(usdc.balanceOf(address(router)), 0, "USDC stuck in router");
    }

    function invariant_tokensConserved() public view {
        address[6] memory holders =
            [handler.makerA(), handler.makerB(), handler.keeper(), address(mock), treasury, address(settlement)];
        uint256 wavaxHeld;
        uint256 usdcHeld;
        for (uint256 i = 0; i < holders.length; i++) {
            wavaxHeld += wavax.balanceOf(holders[i]);
            usdcHeld += usdc.balanceOf(holders[i]);
        }
        assertEq(wavaxHeld, handler.totalMintedWavax(), "WAVAX not conserved");
        assertEq(usdcHeld, handler.totalMintedUsdc(), "USDC not conserved");
    }
}
