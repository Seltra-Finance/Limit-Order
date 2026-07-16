// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../../src/SeltraAggregationRouter.sol";
import {PharaohAdapter} from "../../src/adapters/PharaohAdapter.sol";
import {ISeltraAggregationRouter, RouteData} from "../../src/interfaces/ISeltraAggregationRouter.sol";
import {IPharaohSwapRouter} from "../../src/interfaces/external/IPharaohSwapRouter.sol";
import {IPharaohQuoterV2} from "../../src/interfaces/external/IPharaohQuoterV2.sol";
import {Order, OrderLib} from "../../src/libraries/OrderLib.sol";

/// @notice Live Avalanche fork coverage for Pharaoh's current Ramses V3
///         deployment. Enable explicitly with RUN_MAINNET_FORKS=true.
contract PharaohAdapterForkTest is Test {
    address constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address constant USDC = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
    IPharaohSwapRouter constant PHARAOH_ROUTER = IPharaohSwapRouter(0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c);
    IPharaohQuoterV2 constant PHARAOH_QUOTER = IPharaohQuoterV2(0xB7297301b7CC659BB96D51754643A0Df6eEA2138);
    ISignatureTransfer constant PERMIT2 = ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address constant WAVAX_USDC_POOL = 0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534;
    uint8 constant PHARAOH_ADAPTER_ID = 3;
    int24 constant TICK_SPACING = 10;

    SeltraAggregationRouter internal router;
    PharaohAdapter internal adapter;
    SeltraSettlement internal settlement;
    uint256 internal makerKey = 0xA11CE;
    address internal maker;
    address internal keeper = address(0xCAFE);

    function setUp() public {
        if (!vm.envOr("RUN_MAINNET_FORKS", false)) {
            vm.skip(true);
            return;
        }
        string memory url = vm.envOr("AVAX_RPC_URL", string(""));
        require(bytes(url).length != 0, "AVAX_RPC_URL required when RUN_MAINNET_FORKS=true");
        vm.createSelectFork(url);
        require(address(PHARAOH_ROUTER).code.length > 0, "Pharaoh SwapRouter has no code");
        require(address(PHARAOH_QUOTER).code.length > 0, "Pharaoh QuoterV2 has no code");
        require(WAVAX_USDC_POOL.code.length > 0, "Pharaoh WAVAX/USDC pool has no code");

        address owner = makeAddr("owner");
        address guardian = makeAddr("guardian");
        maker = vm.addr(makerKey);
        router = new SeltraAggregationRouter(owner, guardian);
        adapter = new PharaohAdapter(address(router), PHARAOH_ROUTER, PHARAOH_QUOTER);
        settlement = new SeltraSettlement(PERMIT2, ISeltraAggregationRouter(address(router)), owner, guardian);

        vm.startPrank(owner);
        router.setSettlement(address(settlement));
        router.addAdapter(PHARAOH_ADAPTER_ID, address(adapter));
        settlement.setTokenAllowed(WAVAX, true);
        settlement.setTokenAllowed(USDC, true);
        vm.stopPrank();

        vm.startPrank(maker);
        IERC20(WAVAX).approve(address(PERMIT2), type(uint256).max);
        IERC20(USDC).approve(address(PERMIT2), type(uint256).max);
        vm.stopPrank();
    }

    function _extra(int24 tickSpacing) internal pure returns (bytes memory) {
        return abi.encode(tickSpacing);
    }

    function _quote(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        return router.quote(PHARAOH_ADAPTER_ID, tokenIn, tokenOut, amountIn, _extra(TICK_SPACING));
    }

    function _sign(Order memory order, uint256 nonce)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory signature)
    {
        permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: order.makerAsset, amount: order.makingAmount}),
            nonce: nonce,
            deadline: order.expiry
        });
        bytes32 witness = keccak256(
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
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                OrderLib.WITNESS_TYPE_STRING
            )
        );
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(
                keccak256("TokenPermissions(address token,uint256 amount)"),
                permit.permitted.token,
                permit.permitted.amount
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(typeHash, tokenPermissionsHash, address(settlement), nonce, permit.deadline, witness));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", PERMIT2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _fill(address tokenIn, address tokenOut, uint256 amountIn, uint256 nonce)
        internal
        returns (uint256 amountOut)
    {
        uint256 quoted = _quote(tokenIn, tokenOut, amountIn);
        Order memory order = Order({
            maker: maker,
            receiver: maker,
            makerAsset: tokenIn,
            takerAsset: tokenOut,
            makingAmount: amountIn,
            takingAmount: (quoted * 99) / 100,
            salt: nonce + 1,
            epoch: 0,
            expiry: uint40(block.timestamp + 1 hours),
            allowedSender: address(0),
            flags: 0
        });
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory sig) = _sign(order, nonce);
        vm.prank(keeper);
        amountOut = settlement.fillOrderDEX(
            order, permit, sig, RouteData({adapterId: PHARAOH_ADAPTER_ID, extra: _extra(TICK_SPACING)})
        );
        assertGe(amountOut, order.takingAmount, "maker slippage bound");
        assertEq(IERC20(tokenIn).balanceOf(address(settlement)), 0, "no input residue");
        assertEq(IERC20(tokenOut).balanceOf(address(settlement)), 0, "no output residue");
    }

    function test_fork_quotesAndImpactAtRequiredSizes() public {
        uint256 q1 = _quote(WAVAX, USDC, 1e18);
        uint256 q10 = _quote(WAVAX, USDC, 10e18);
        uint256 q100 = _quote(WAVAX, USDC, 100e18);
        assertGt(q1, 0);
        assertGt(q10, 0);
        assertGt(q100, 0);

        uint256 expected10 = q1 * 10;
        uint256 expected100 = q1 * 100;
        uint256 impact10Bps = ((expected10 - q10) * 10_000) / expected10;
        uint256 impact100Bps = ((expected100 - q100) * 10_000) / expected100;
        emit log_named_uint("Pharaoh 1 WAVAX quote (USDC units)", q1);
        emit log_named_uint("Pharaoh 10 WAVAX quote (USDC units)", q10);
        emit log_named_uint("Pharaoh 100 WAVAX quote (USDC units)", q100);
        emit log_named_uint("Pharaoh 10 WAVAX impact bps", impact10Bps);
        emit log_named_uint("Pharaoh 100 WAVAX impact bps", impact100Bps);
        assertLe(impact100Bps, 50, "100 WAVAX exceeds 50 bps impact");
    }

    function test_fork_fullFillAndRoundTrip() public {
        deal(WAVAX, maker, 1e18);
        uint256 usdcOut = _fill(WAVAX, USDC, 1e18, 31);
        deal(USDC, maker, usdcOut);
        uint256 wavaxOut = _fill(USDC, WAVAX, usdcOut, 32);
        assertGt(wavaxOut, 0, "round trip returned WAVAX");
    }

    function test_fork_revertsOnNoLiquidity() public {
        vm.expectRevert();
        router.quote(PHARAOH_ADAPTER_ID, WAVAX, USDC, 1e18, _extra(60));
    }
}
