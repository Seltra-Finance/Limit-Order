// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {LFJLBAdapter} from "../src/adapters/LFJLBAdapter.sol";
import {ILBRouter} from "../src/interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../src/interfaces/external/ILBQuoter.sol";
import {TestERC20} from "./utils/TestERC20.sol";

contract MockLBRouter is ILBRouter {
    uint256 public amountOut;

    function setAmountOut(uint256 value) external {
        amountOut = value;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Path memory path,
        address to,
        uint256 deadline
    ) external returns (uint256) {
        require(block.timestamp <= deadline, "expired");
        require(amountOut >= amountOutMin, "too little");
        require(IERC20(path.tokenPath[0]).transferFrom(msg.sender, address(this), amountIn), "transfer failed");
        TestERC20(address(path.tokenPath[path.tokenPath.length - 1])).mint(to, amountOut);
        return amountOut;
    }
}

contract MockLBQuoter is ILBQuoter {
    uint128 public amountOut;

    function setAmountOut(uint128 value) external {
        amountOut = value;
    }

    function findBestPathFromAmountIn(address[] calldata route, uint128 amountIn)
        external
        view
        returns (Quote memory quote)
    {
        quote.route = route;
        quote.binSteps = new uint256[](route.length - 1);
        quote.versions = new ILBRouter.Version[](route.length - 1);
        quote.amounts = new uint128[](route.length);
        quote.amounts[0] = amountIn;
        quote.amounts[route.length - 1] = amountOut;
    }
}

contract LFJLBAdapterTest is Test {
    uint8 constant ADAPTER_ID = 1;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal settlement = makeAddr("settlement");
    TestERC20 internal wavax;
    TestERC20 internal usdc;
    SeltraAggregationRouter internal router;
    MockLBRouter internal lbRouter;
    MockLBQuoter internal quoter;
    LFJLBAdapter internal adapter;

    function setUp() public {
        wavax = new TestERC20("Wrapped AVAX", "WAVAX", 18);
        usdc = new TestERC20("USD Coin", "USDC", 6);
        router = new SeltraAggregationRouter(owner, guardian);
        lbRouter = new MockLBRouter();
        quoter = new MockLBQuoter();
        adapter = new LFJLBAdapter(address(router), lbRouter, quoter);
        vm.startPrank(owner);
        router.setSettlement(settlement);
        router.addAdapter(ADAPTER_ID, address(adapter));
        vm.stopPrank();
    }

    function _extra(address tokenOut) internal view returns (bytes memory) {
        return _extraWithDeadline(tokenOut, block.timestamp + 60);
    }

    function _extraWithDeadline(address tokenOut, uint256 deadline) internal view returns (bytes memory) {
        uint256[] memory binSteps = new uint256[](1);
        binSteps[0] = 20;
        ILBRouter.Version[] memory versions = new ILBRouter.Version[](1);
        versions[0] = ILBRouter.Version.V2_1;
        IERC20[] memory tokens = new IERC20[](2);
        tokens[0] = IERC20(address(wavax));
        tokens[1] = IERC20(tokenOut);
        return abi.encode(deadline, binSteps, versions, tokens);
    }

    function test_quoteAndAmountBound() public {
        quoter.setAmountOut(41e6);
        assertEq(router.quote(ADAPTER_ID, address(wavax), address(usdc), 1e18, ""), 41e6);

        vm.expectRevert(LFJLBAdapter.AmountTooLarge.selector);
        adapter.quote(address(wavax), address(usdc), uint256(type(uint128).max) + 1, "");
    }

    function test_swapRoutesOutputAndClearsApproval() public {
        lbRouter.setAmountOut(41e6);
        wavax.mint(settlement, 1e18);
        vm.startPrank(settlement);
        wavax.approve(address(router), 1e18);
        uint256 amountOut = router.swap(ADAPTER_ID, address(wavax), address(usdc), 1e18, 40e6, _extra(address(usdc)));
        vm.stopPrank();

        assertEq(amountOut, 41e6);
        assertEq(usdc.balanceOf(settlement), 41e6);
        assertEq(wavax.allowance(address(adapter), address(lbRouter)), 0);
    }

    function test_rejectsBadPathAndUnauthorizedSwap() public {
        vm.expectRevert(LFJLBAdapter.BadPath.selector);
        adapter.quote(address(wavax), address(usdc), 1e18, _extra(address(wavax)));

        vm.expectRevert(LFJLBAdapter.OnlyRouter.selector);
        adapter.swap(address(wavax), address(usdc), 1e18, 0, _extra(address(usdc)));
    }

    function test_rejectsMultiHopPath() public {
        TestERC20 intermediate = new TestERC20("Intermediate", "MID", 18);
        uint256[] memory binSteps = new uint256[](2);
        binSteps[0] = 20;
        binSteps[1] = 20;
        ILBRouter.Version[] memory versions = new ILBRouter.Version[](2);
        versions[0] = ILBRouter.Version.V2_1;
        versions[1] = ILBRouter.Version.V2_1;
        IERC20[] memory tokens = new IERC20[](3);
        tokens[0] = IERC20(address(wavax));
        tokens[1] = IERC20(address(intermediate));
        tokens[2] = IERC20(address(usdc));

        vm.expectRevert(LFJLBAdapter.BadPath.selector);
        adapter.quote(address(wavax), address(usdc), 1e18, abi.encode(block.timestamp + 60, binSteps, versions, tokens));
    }

    function test_constructorRejectsZeroAddress() public {
        vm.expectRevert(LFJLBAdapter.ZeroAddress.selector);
        new LFJLBAdapter(address(0), lbRouter, quoter);
    }

    function test_rejectsExpiredDeadlineLocally() public {
        vm.warp(100);
        uint256 deadline = block.timestamp - 1;
        vm.expectRevert(abi.encodeWithSelector(LFJLBAdapter.DeadlineExpired.selector, deadline));
        adapter.quote(address(wavax), address(usdc), 1e18, _extraWithDeadline(address(usdc), deadline));
    }
}
