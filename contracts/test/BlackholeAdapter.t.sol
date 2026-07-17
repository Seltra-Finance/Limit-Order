// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {BlackholeAdapter} from "../src/adapters/BlackholeAdapter.sol";
import {IBlackholeRouterV2} from "../src/interfaces/external/IBlackholeRouterV2.sol";
import {IBlackholeRouterHelper} from "../src/interfaces/external/IBlackholeRouterHelper.sol";
import {TestERC20} from "./utils/TestERC20.sol";

contract MockBlackholeRouter is IBlackholeRouterV2 {
    uint256 public amountOut;

    function setAmountOut(uint256 value) external {
        amountOut = value;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        route[] calldata routes,
        address,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "expired");
        require(amountOut >= amountOutMin, "IOA");
        IERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        TestERC20(routes[0].to).mint(routes[0].receiver, amountOut);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}

contract MockBlackholeHelper is IBlackholeRouterHelper {
    uint256 public amountOut;

    function setAmountOut(uint256 value) external {
        amountOut = value;
    }

    function getAmountsOut(uint256 amountIn, IBlackholeRouterV2.route[] memory)
        external
        view
        returns (uint256[] memory amounts, uint256[] memory beforePrices, uint256[] memory afterPrices)
    {
        amounts = new uint256[](2);
        beforePrices = new uint256[](2);
        afterPrices = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}

contract BlackholeAdapterTest is Test {
    uint8 constant ADAPTER_ID = 2;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal settlement = makeAddr("settlement");
    address internal pool = makeAddr("pool");
    TestERC20 internal wavax;
    TestERC20 internal usdc;
    SeltraAggregationRouter internal router;
    MockBlackholeRouter internal bhRouter;
    MockBlackholeHelper internal helper;
    BlackholeAdapter internal adapter;

    function setUp() public {
        wavax = new TestERC20("Wrapped AVAX", "WAVAX", 18);
        usdc = new TestERC20("USD Coin", "USDC", 6);
        router = new SeltraAggregationRouter(owner, guardian);
        bhRouter = new MockBlackholeRouter();
        helper = new MockBlackholeHelper();
        adapter = new BlackholeAdapter(address(router), bhRouter, helper, owner);
        vm.startPrank(owner);
        router.setSettlement(settlement);
        router.addAdapter(ADAPTER_ID, address(adapter));
        adapter.setRouteAllowed(pool, address(wavax), address(usdc), false, true, true);
        vm.stopPrank();
    }

    function _extra(address receiver) internal view returns (bytes memory) {
        IBlackholeRouterV2.route[] memory routes = new IBlackholeRouterV2.route[](1);
        routes[0] = IBlackholeRouterV2.route({
            pair: pool, from: address(wavax), to: address(usdc), stable: false, concentrated: true, receiver: receiver
        });
        return abi.encode(block.timestamp + 60, routes);
    }

    function test_quoteUsesRouterHelper() public {
        helper.setAmountOut(41e6);
        assertEq(router.quote(ADAPTER_ID, address(wavax), address(usdc), 1e18, _extra(address(router))), 41e6);
    }

    function test_swapRoutesOutputAndClearsApproval() public {
        bhRouter.setAmountOut(41e6);
        wavax.mint(settlement, 1e18);
        vm.startPrank(settlement);
        wavax.approve(address(router), 1e18);
        uint256 amountOut = router.swap(ADAPTER_ID, address(wavax), address(usdc), 1e18, 40e6, _extra(address(router)));
        vm.stopPrank();

        assertEq(amountOut, 41e6);
        assertEq(usdc.balanceOf(settlement), 41e6);
        assertEq(wavax.allowance(address(adapter), address(bhRouter)), 0);
    }

    function test_rejectsReceiverRouteAndMultiHop() public {
        vm.expectRevert(abi.encodeWithSelector(BlackholeAdapter.InvalidReceiver.selector, settlement));
        adapter.quote(address(wavax), address(usdc), 1e18, _extra(settlement));

        vm.prank(owner);
        adapter.setRouteAllowed(pool, address(wavax), address(usdc), false, true, false);
        bytes32 key = adapter.routeKey(pool, address(wavax), address(usdc), false, true);
        vm.expectRevert(abi.encodeWithSelector(BlackholeAdapter.RouteNotAllowed.selector, key));
        adapter.quote(address(wavax), address(usdc), 1e18, _extra(address(router)));

        IBlackholeRouterV2.route[] memory routes = new IBlackholeRouterV2.route[](2);
        bytes memory extra = abi.encode(block.timestamp + 60, routes);
        vm.expectRevert(BlackholeAdapter.BadRoute.selector);
        adapter.quote(address(wavax), address(usdc), 1e18, extra);
    }

    function test_routeAllowlistBindsPoolSelectionFlags() public {
        IBlackholeRouterV2.route[] memory routes = new IBlackholeRouterV2.route[](1);
        routes[0] = IBlackholeRouterV2.route({
            pair: pool,
            from: address(wavax),
            to: address(usdc),
            stable: true,
            concentrated: false,
            receiver: address(router)
        });
        bytes32 key = adapter.routeKey(pool, address(wavax), address(usdc), true, false);
        vm.expectRevert(abi.encodeWithSelector(BlackholeAdapter.RouteNotAllowed.selector, key));
        adapter.quote(address(wavax), address(usdc), 1e18, abi.encode(block.timestamp + 60, routes));
    }

    function test_onlyRouterAndConstructorChecks() public {
        vm.expectRevert(BlackholeAdapter.OnlyRouter.selector);
        adapter.swap(address(wavax), address(usdc), 1e18, 0, _extra(address(router)));

        vm.expectRevert(BlackholeAdapter.ZeroAddress.selector);
        new BlackholeAdapter(address(0), bhRouter, helper, owner);
    }
}
