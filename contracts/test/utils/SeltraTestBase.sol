// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../../src/SeltraAggregationRouter.sol";
import {MockDEXAdapter} from "../../src/adapters/MockDEXAdapter.sol";
import {ISeltraAggregationRouter, RouteData} from "../../src/interfaces/ISeltraAggregationRouter.sol";
import {Order, OrderLib} from "../../src/libraries/OrderLib.sol";
import {TestERC20} from "./TestERC20.sol";

contract SeltraTestBase is Test {
    uint8 internal constant MOCK_ADAPTER_ID = 0;

    ISignatureTransfer internal permit2;
    SeltraAggregationRouter internal router;
    SeltraSettlement internal settlement;
    MockDEXAdapter internal mock;

    TestERC20 internal wavax; // 18 decimals
    TestERC20 internal usdc; // 6 decimals

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");

    uint256 internal makerKey = 0xA11CE;
    address internal maker;
    uint256 internal makerBKey = 0xB0B;
    address internal makerB;

    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    // Not `constant`: concatenation is not a compile-time constant expression.
    bytes32 internal PERMIT_WITNESS_TYPEHASH = keccak256(
        abi.encodePacked(
            "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
            OrderLib.WITNESS_TYPE_STRING
        )
    );

    function setUp() public virtual {
        maker = vm.addr(makerKey);
        makerB = vm.addr(makerBKey);

        // Real Permit2, compiled from the vendored 0.8.17 sources.
        permit2 = ISignatureTransfer(deployCode("Permit2.sol:Permit2"));

        router = new SeltraAggregationRouter(owner, guardian);
        mock = new MockDEXAdapter(address(router), owner);
        settlement = new SeltraSettlement(permit2, ISeltraAggregationRouter(address(router)), owner, guardian);

        vm.startPrank(owner);
        router.setSettlement(address(settlement));
        router.addAdapter(MOCK_ADAPTER_ID, address(mock));
        vm.stopPrank();

        wavax = new TestERC20("Wrapped AVAX", "WAVAX", 18);
        usdc = new TestERC20("USD Coin", "USDC", 6);
        _allowToken(address(wavax));
        _allowToken(address(usdc));

        // The maker's only approval, ever: ERC-20 -> canonical Permit2.
        _approvePermit2(maker);
        _approvePermit2(makerB);
    }

    function _allowToken(address token) internal {
        vm.prank(owner);
        settlement.setTokenAllowed(token, true);
    }

    function _approvePermit2(address who) internal {
        vm.startPrank(who);
        wavax.approve(address(permit2), type(uint256).max);
        usdc.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev A sells 10 WAVAX for >= 400 USDC (limit 40 USDC per WAVAX).
    function _defaultOrder() internal view returns (Order memory) {
        return Order({
            maker: maker,
            receiver: maker,
            makerAsset: address(wavax),
            takerAsset: address(usdc),
            makingAmount: 10e18,
            takingAmount: 400e6,
            salt: 1,
            epoch: 0,
            expiry: uint40(block.timestamp + 1 hours),
            allowedSender: address(0),
            flags: 0
        });
    }

    /// @dev Permit2 PermitTransferFrom consistent with the order (spec 1.2):
    ///      permitted = {makerAsset, makingAmount}, deadline = expiry.
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

    /// @dev Reconstructs Permit2's PermitWitnessTransferFrom digest with the
    ///      Order struct hash as witness, and signs it. Mirrors
    ///      Permit2/PermitHash.hashWithWitness.
    function _signWitness(uint256 key, Order memory order, ISignatureTransfer.PermitTransferFrom memory permit)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = _witnessDigest(order, permit, address(settlement));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _witnessDigest(Order memory order, ISignatureTransfer.PermitTransferFrom memory permit, address spender)
        internal
        view
        returns (bytes32)
    {
        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount));
        bytes32 witness = _orderHash(order);
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_WITNESS_TYPEHASH, tokenPermissionsHash, spender, permit.nonce, permit.deadline, witness)
        );
        return keccak256(abi.encodePacked("\x19\x01", permit2.DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev Order witness hash, mirrored for memory structs (OrderLib.hash is
    ///      calldata-only).
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

    /// @dev Convenience bundle: permit + signature for an order under a nonce.
    function _signed(uint256 key, Order memory order, uint256 nonce)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig)
    {
        permit = _permitFor(order, nonce);
        sig = _signWitness(key, order, permit);
    }

    function _route() internal pure returns (RouteData memory) {
        return RouteData({adapterId: MOCK_ADAPTER_ID, extra: ""});
    }

    /// @dev Sets the mock pool price and stocks the adapter with output-side
    ///      inventory. rateWad is out-per-in scaled by 1e18 (decimals baked in).
    function _setMockMarket(address tokenIn, address tokenOut, uint256 rateWad, uint256 inventoryOut) internal {
        vm.prank(owner);
        mock.setPrice(tokenIn, tokenOut, rateWad);
        TestERC20(tokenOut).mint(address(mock), inventoryOut);
    }
}
