// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../../src/SeltraAggregationRouter.sol";
import {BlackholeAdapter} from "../../src/adapters/BlackholeAdapter.sol";
import {ISeltraAggregationRouter, RouteData} from "../../src/interfaces/ISeltraAggregationRouter.sol";
import {IBlackholeRouterV2} from "../../src/interfaces/external/IBlackholeRouterV2.sol";
import {IBlackholeRouterHelper} from "../../src/interfaces/external/IBlackholeRouterHelper.sol";
import {Order, OrderLib} from "../../src/libraries/OrderLib.sol";

/// @notice Mainnet release gate for Blackhole's four launch pools. RouterV2
///         addresses are sourced from Blackhole's current official app bundle
///         and verified on-chain. The suite is skipped unless
///         RUN_MAINNET_FORKS=true and then requires AVAX_RPC_URL.
contract BlackholeAdapterForkTest is Test {
    address constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address constant USDC = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
    address constant USDT = 0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7;
    address constant WETH_E = 0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB;
    address constant BTC_B = 0x152b9d0FdC40C096757F570A51E494bd4b943E50;
    IBlackholeRouterV2 constant BH_ROUTER = IBlackholeRouterV2(0xe946A9f39312E2346BA79DAb865B0e9A74f2F981);
    IBlackholeRouterHelper constant BH_HELPER = IBlackholeRouterHelper(0x53D569BC4B37ADbBDB6ab447D92ADf42514AE480);
    ISignatureTransfer constant PERMIT2 = ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address constant WAVAX_USDC_POOL = 0x41100C6D2c6920B10d12Cd8D59c8A9AA2eF56fC7;
    address constant USDC_USDT_POOL = 0x859592A4A469610E573f96Ef87A0e5565F9a94c8;
    address constant WETH_WAVAX_POOL = 0x5E128EbC09C918DDAE3Ca1668d4EE9527dc00D78;
    address constant BTCB_WAVAX_POOL = 0x8FEF4fE4970a5D6bFa7C65871a2EbFD0F42aa822;
    uint8 constant BLACKHOLE_ADAPTER_ID = 2;

    SeltraAggregationRouter internal router;
    BlackholeAdapter internal adapter;
    SeltraSettlement internal settlement;
    address internal owner;
    address internal settlementStub;
    address internal pool = WAVAX_USDC_POOL;
    uint256 internal makerKey = 0xB1AC;
    address internal maker;
    address internal keeper = address(0xCAFE);

    function setUp() public {
        if (!vm.envOr("RUN_MAINNET_FORKS", false)) {
            vm.skip(true);
            return;
        }
        string memory url = vm.envOr("AVAX_RPC_URL", string(""));
        require(bytes(url).length != 0, "AVAX_RPC_URL required when RUN_MAINNET_FORKS=true");
        vm.createSelectFork(url, vm.envOr("AVAX_FORK_BLOCK", uint256(90_884_800)));

        owner = makeAddr("owner");
        maker = vm.addr(makerKey);
        router = new SeltraAggregationRouter(owner, makeAddr("guardian"));
        adapter = new BlackholeAdapter(address(router), BH_ROUTER, BH_HELPER, owner);
        settlement = new SeltraSettlement(
            PERMIT2, ISeltraAggregationRouter(address(router)), owner, makeAddr("settlementGuardian")
        );
        settlementStub = address(settlement);
        vm.startPrank(owner);
        router.setSettlement(settlementStub);
        router.addAdapter(BLACKHOLE_ADAPTER_ID, address(adapter));
        settlement.setTokenAllowed(WAVAX, true);
        settlement.setTokenAllowed(USDC, true);
        settlement.setTokenAllowed(USDT, true);
        settlement.setTokenAllowed(WETH_E, true);
        settlement.setTokenAllowed(BTC_B, true);
        settlement.setPairAllowed(WAVAX, USDC, true);
        settlement.setPairAllowed(USDC, USDT, true);
        settlement.setPairAllowed(WETH_E, WAVAX, true);
        settlement.setPairAllowed(BTC_B, WAVAX, true);
        vm.stopPrank();

        deal(WAVAX, maker, 100e18);
        vm.prank(maker);
        IERC20(WAVAX).approve(address(PERMIT2), type(uint256).max);
        deal(USDC, maker, 20_000e6);
        vm.prank(maker);
        IERC20(USDC).approve(address(PERMIT2), type(uint256).max);
    }

    function _route(address tokenIn, address tokenOut) internal view returns (bytes memory extra) {
        return _routeAt(pool, tokenIn, tokenOut);
    }

    function _routeAt(address routePool, address tokenIn, address tokenOut) internal view returns (bytes memory extra) {
        IBlackholeRouterV2.route[] memory routes = new IBlackholeRouterV2.route[](1);
        routes[0] = IBlackholeRouterV2.route({
            pair: routePool, from: tokenIn, to: tokenOut, stable: false, concentrated: true, receiver: address(router)
        });
        extra = abi.encode(block.timestamp + 60, routes);
    }

    function _signWitness(Order memory order, ISignatureTransfer.PermitTransferFrom memory permit)
        internal
        view
        returns (bytes memory)
    {
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
        bytes32 structHash = keccak256(
            abi.encode(typeHash, tokenPermissionsHash, address(settlement), permit.nonce, permit.deadline, witness)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", PERMIT2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_fork_blackholeSwapThroughAllowlistedPool() public {
        vm.startPrank(owner);
        adapter.setRouteAllowed(pool, WAVAX, USDC, false, true, true);
        adapter.setRouteAllowed(pool, USDC, WAVAX, false, true, true);
        vm.stopPrank();

        bytes memory extra = _route(WAVAX, USDC);

        uint256 amountIn = 1e18;
        uint256 quoted = router.quote(BLACKHOLE_ADAPTER_ID, WAVAX, USDC, amountIn, extra);
        assertGt(quoted, 0, "no quote from Blackhole pool");

        deal(WAVAX, settlementStub, amountIn);
        vm.startPrank(settlementStub);
        IERC20(WAVAX).approve(address(router), amountIn);
        uint256 amountOut = router.swap(BLACKHOLE_ADAPTER_ID, WAVAX, USDC, amountIn, (quoted * 97) / 100, extra);
        vm.stopPrank();

        assertGe(amountOut, (quoted * 97) / 100, "realized within 3% of quote");
        assertEq(IERC20(USDC).balanceOf(settlementStub), amountOut);

        bytes memory reverseExtra = _route(USDC, WAVAX);
        uint256 reverseQuote = router.quote(BLACKHOLE_ADAPTER_ID, USDC, WAVAX, amountOut, reverseExtra);
        vm.startPrank(settlementStub);
        IERC20(USDC).approve(address(router), amountOut);
        uint256 roundTrip =
            router.swap(BLACKHOLE_ADAPTER_ID, USDC, WAVAX, amountOut, (reverseQuote * 97) / 100, reverseExtra);
        vm.stopPrank();
        assertGe(roundTrip, 0.95e18, "round trip lost more than 5%");
        assertEq(IERC20(WAVAX).balanceOf(settlementStub), roundTrip);
    }

    function test_fork_quoteSizesAndPriceImpact() public {
        vm.prank(owner);
        adapter.setRouteAllowed(pool, WAVAX, USDC, false, true, true);
        bytes memory extra = _route(WAVAX, USDC);
        uint256 q1 = router.quote(BLACKHOLE_ADAPTER_ID, WAVAX, USDC, 1e18, extra);
        uint256 q10 = router.quote(BLACKHOLE_ADAPTER_ID, WAVAX, USDC, 10e18, extra);
        uint256 q100 = router.quote(BLACKHOLE_ADAPTER_ID, WAVAX, USDC, 100e18, extra);

        assertGt(q1, 0, "1 WAVAX quote");
        assertGt(q10, 0, "10 WAVAX quote");
        assertGt(q100, 0, "100 WAVAX quote");
        assertLe(q10, q1 * 10, "larger trade cannot improve unit price");
        assertLe(q100, q10 * 10, "larger trade cannot improve unit price");
        uint256 impactBps = 10_000 - ((q100 * 100) / q1);
        emit log_named_uint("Blackhole 1 WAVAX quote", q1);
        emit log_named_uint("Blackhole 10 WAVAX quote", q10);
        emit log_named_uint("Blackhole 100 WAVAX quote", q100);
        emit log_named_uint("Blackhole 100 WAVAX impact bps vs 1 WAVAX", impactBps);
        assertLe(impactBps, 50, "100 WAVAX price impact exceeds 50 bps gate");
    }

    function test_fork_fullDEXFillAgainstRealLiquidity() public {
        vm.prank(owner);
        adapter.setRouteAllowed(pool, WAVAX, USDC, false, true, true);
        uint256 amountIn = 10e18;
        bytes memory extra = _route(WAVAX, USDC);
        uint256 quotedOut = router.quote(BLACKHOLE_ADAPTER_ID, WAVAX, USDC, amountIn, extra);
        uint256 takingAmount = (quotedOut * 98) / 100;
        Order memory order = Order({
            maker: maker,
            receiver: maker,
            makerAsset: WAVAX,
            takerAsset: USDC,
            makingAmount: amountIn,
            takingAmount: takingAmount,
            salt: 2,
            epoch: 0,
            expiry: uint40(block.timestamp + 1 hours),
            allowedSender: address(0),
            flags: 0
        });
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: WAVAX, amount: amountIn}),
            nonce: 8,
            deadline: order.expiry
        });
        bytes memory signature = _signWitness(order, permit);
        uint256 makerUsdcBefore = IERC20(USDC).balanceOf(maker);

        vm.prank(keeper);
        uint256 amountOut = settlement.fillOrderDEX(
            order, permit, signature, RouteData({adapterId: BLACKHOLE_ADAPTER_ID, extra: extra})
        );

        assertGe(amountOut, takingAmount, "maker invariant");
        assertGe(amountOut, (quotedOut * 99) / 100, "realized within 1% of quote");
        uint256 surplus = amountOut - takingAmount;
        uint256 improvement = (surplus * 7_000) / 10_000;
        assertEq(IERC20(USDC).balanceOf(maker) - makerUsdcBefore, takingAmount + improvement, "maker payment");
        assertEq(IERC20(USDC).balanceOf(keeper), surplus - improvement, "keeper reward");
        assertEq(IERC20(USDC).balanceOf(address(settlement)), 0, "no settlement USDC residue");
        assertEq(IERC20(WAVAX).balanceOf(address(settlement)), 0, "no settlement WAVAX residue");
    }

    function test_fork_usdcUsdtQuotesBothDirectionsThroughPinnedPool() public {
        vm.startPrank(owner);
        adapter.setRouteAllowed(USDC_USDT_POOL, USDC, USDT, false, true, true);
        adapter.setRouteAllowed(USDC_USDT_POOL, USDT, USDC, false, true, true);
        vm.stopPrank();

        uint256 usdc100 = router.quote(BLACKHOLE_ADAPTER_ID, USDC, USDT, 100e6, _routeAt(USDC_USDT_POOL, USDC, USDT));
        uint256 usdc5000 = router.quote(BLACKHOLE_ADAPTER_ID, USDC, USDT, 5_000e6, _routeAt(USDC_USDT_POOL, USDC, USDT));
        uint256 usdt100 = router.quote(BLACKHOLE_ADAPTER_ID, USDT, USDC, 100e6, _routeAt(USDC_USDT_POOL, USDT, USDC));
        uint256 usdt5000 = router.quote(BLACKHOLE_ADAPTER_ID, USDT, USDC, 5_000e6, _routeAt(USDC_USDT_POOL, USDT, USDC));

        assertGt(usdc100, 99e6, "USDC -> USDt 100 below launch gate");
        assertLt(usdc100, 101e6, "USDC -> USDt 100 above launch gate");
        assertGt(usdc5000, 4_950e6, "USDC -> USDt 5000 below launch gate");
        assertLt(usdc5000, 5_050e6, "USDC -> USDt 5000 above launch gate");
        assertGt(usdt100, 99e6, "USDt -> USDC 100 below launch gate");
        assertLt(usdt100, 101e6, "USDt -> USDC 100 above launch gate");
        assertGt(usdt5000, 4_950e6, "USDt -> USDC 5000 below launch gate");
        assertLt(usdt5000, 5_050e6, "USDt -> USDC 5000 above launch gate");
        assertApproxEqRel(usdc5000 / 50, usdc100, 0.005e18, "USDC -> USDt size impact over 50 bps");
        assertApproxEqRel(usdt5000 / 50, usdt100, 0.005e18, "USDt -> USDC size impact over 50 bps");
    }

    function test_fork_wethWavaxAndBtcbWavaxPinnedPoolsRoundTrip() public {
        _assertPoolRoundTrip(WETH_WAVAX_POOL, WETH_E, WAVAX, 1e18);
        _assertPoolRoundTrip(BTCB_WAVAX_POOL, BTC_B, WAVAX, 1e6); // 0.01 BTC.b
    }

    function _assertPoolRoundTrip(address routePool, address tokenIn, address tokenOut, uint256 amountIn) internal {
        vm.startPrank(owner);
        adapter.setRouteAllowed(routePool, tokenIn, tokenOut, false, true, true);
        adapter.setRouteAllowed(routePool, tokenOut, tokenIn, false, true, true);
        vm.stopPrank();

        bytes memory forward = _routeAt(routePool, tokenIn, tokenOut);
        uint256 quotedOut = router.quote(BLACKHOLE_ADAPTER_ID, tokenIn, tokenOut, amountIn, forward);
        assertGt(quotedOut, 0, "priority-pair forward quote");

        deal(tokenIn, settlementStub, amountIn);
        vm.startPrank(settlementStub);
        IERC20(tokenIn).approve(address(router), amountIn);
        uint256 amountOut =
            router.swap(BLACKHOLE_ADAPTER_ID, tokenIn, tokenOut, amountIn, (quotedOut * 97) / 100, forward);
        bytes memory reverse = _routeAt(routePool, tokenOut, tokenIn);
        uint256 reverseQuote = router.quote(BLACKHOLE_ADAPTER_ID, tokenOut, tokenIn, amountOut, reverse);
        IERC20(tokenOut).approve(address(router), amountOut);
        uint256 amountBack =
            router.swap(BLACKHOLE_ADAPTER_ID, tokenOut, tokenIn, amountOut, (reverseQuote * 97) / 100, reverse);
        vm.stopPrank();

        assertGt(amountBack, 0, "priority-pair reverse swap");
        assertEq(IERC20(tokenOut).balanceOf(address(router)), 0, "router output residue");
    }

    function test_fork_fullDEXFillUsdcToUsdt() public {
        vm.prank(owner);
        adapter.setRouteAllowed(USDC_USDT_POOL, USDC, USDT, false, true, true);

        uint256 amountIn = 5_000e6;
        bytes memory extra = _routeAt(USDC_USDT_POOL, USDC, USDT);
        uint256 quotedOut = router.quote(BLACKHOLE_ADAPTER_ID, USDC, USDT, amountIn, extra);
        uint256 takingAmount = (quotedOut * 9_950) / 10_000;
        Order memory order = Order({
            maker: maker,
            receiver: maker,
            makerAsset: USDC,
            takerAsset: USDT,
            makingAmount: amountIn,
            takingAmount: takingAmount,
            salt: 3,
            epoch: 0,
            expiry: uint40(block.timestamp + 1 hours),
            allowedSender: address(0),
            flags: 0
        });
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: USDC, amount: amountIn}),
            nonce: 9,
            deadline: order.expiry
        });

        vm.prank(keeper);
        uint256 amountOut = settlement.fillOrderDEX(
            order, permit, _signWitness(order, permit), RouteData({adapterId: BLACKHOLE_ADAPTER_ID, extra: extra})
        );

        assertGe(amountOut, takingAmount, "maker invariant");
        assertGe(amountOut, (quotedOut * 9_990) / 10_000, "realized outside 10 bps quote tolerance");
        assertEq(IERC20(USDT).balanceOf(address(settlement)), 0, "no settlement USDt residue");
        assertEq(IERC20(USDC).balanceOf(address(settlement)), 0, "no settlement USDC residue");
    }

    function test_fork_poolNotAllowlistedReverts() public {
        IBlackholeRouterV2.route[] memory routes = new IBlackholeRouterV2.route[](1);
        routes[0] = IBlackholeRouterV2.route({
            pair: pool, from: WAVAX, to: USDC, stable: false, concentrated: false, receiver: address(router)
        });
        bytes memory extra = abi.encode(block.timestamp + 60, routes);

        deal(WAVAX, settlementStub, 1e18);
        vm.startPrank(settlementStub);
        IERC20(WAVAX).approve(address(router), 1e18);
        bytes32 key = adapter.routeKey(pool, WAVAX, USDC, false, false);
        vm.expectRevert(abi.encodeWithSelector(BlackholeAdapter.RouteNotAllowed.selector, key));
        router.swap(2, WAVAX, USDC, 1e18, 0, extra);
        vm.stopPrank();
    }
}
