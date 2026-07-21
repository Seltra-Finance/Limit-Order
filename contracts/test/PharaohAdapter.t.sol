// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {PharaohAdapter} from "../src/adapters/PharaohAdapter.sol";
import {IPharaohSwapRouter} from "../src/interfaces/external/IPharaohSwapRouter.sol";
import {IPharaohQuoterV2} from "../src/interfaces/external/IPharaohQuoterV2.sol";
import {TestERC20} from "./utils/TestERC20.sol";

contract MockPharaohQuoter is IPharaohQuoterV2 {
    uint256 public amountOut;
    int24 public lastTickSpacing;

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256, uint160, uint32, uint256)
    {
        lastTickSpacing = params.tickSpacing;
        return (amountOut, 0, 0, 100_000);
    }
}

contract MockPharaohSwapRouter is IPharaohSwapRouter {
    uint256 public amountOut;
    uint256 public lastDeadline;

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256) {
        lastDeadline = params.deadline;
        require(block.timestamp <= params.deadline, "expired");
        require(amountOut >= params.amountOutMinimum, "Too little received");
        require(IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "transfer failed");
        TestERC20(params.tokenOut).mint(params.recipient, amountOut);
        return amountOut;
    }
}

contract PharaohAdapterTest is Test {
    uint8 internal constant PHARAOH_ADAPTER_ID = 3;
    int24 internal constant TICK_SPACING = 50;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal settlement = makeAddr("settlement");
    address internal keeper = makeAddr("keeper");

    TestERC20 internal wavax;
    TestERC20 internal usdc;
    SeltraAggregationRouter internal router;
    MockPharaohQuoter internal quoter;
    MockPharaohSwapRouter internal pharaohRouter;
    PharaohAdapter internal adapter;

    function _extra() internal view returns (bytes memory) {
        return abi.encode(block.timestamp + 60, TICK_SPACING);
    }

    function setUp() public {
        wavax = new TestERC20("Wrapped AVAX", "WAVAX", 18);
        usdc = new TestERC20("USD Coin", "USDC", 6);
        router = new SeltraAggregationRouter(owner, guardian);
        quoter = new MockPharaohQuoter();
        pharaohRouter = new MockPharaohSwapRouter();
        adapter = new PharaohAdapter(address(router), pharaohRouter, quoter);

        vm.startPrank(owner);
        router.setSettlement(settlement);
        router.addAdapter(PHARAOH_ADAPTER_ID, address(adapter));
        vm.stopPrank();
    }

    function test_quoteUsesConfiguredTickSpacing() public {
        quoter.setAmountOut(41e6);
        uint256 amountOut = router.quote(PHARAOH_ADAPTER_ID, address(wavax), address(usdc), 1e18, _extra());
        assertEq(amountOut, 41e6);
        assertEq(quoter.lastTickSpacing(), TICK_SPACING, "quote used route tick spacing");
    }

    function test_swapRoutesOutputBackToSettlementAndClearsApproval() public {
        pharaohRouter.setAmountOut(41e6);
        wavax.mint(settlement, 1e18);

        vm.startPrank(settlement);
        wavax.approve(address(router), 1e18);
        uint256 deadline = block.timestamp + 60;
        uint256 amountOut = router.swap(
            PHARAOH_ADAPTER_ID, address(wavax), address(usdc), 1e18, 40e6, abi.encode(deadline, TICK_SPACING)
        );
        vm.stopPrank();

        assertEq(amountOut, 41e6);
        assertEq(usdc.balanceOf(settlement), 41e6);
        assertEq(wavax.balanceOf(address(adapter)), 0);
        assertEq(wavax.allowance(address(adapter), address(pharaohRouter)), 0, "approval cleared");
        assertEq(pharaohRouter.lastDeadline(), deadline, "keeper deadline forwarded unchanged");
    }

    function test_swapHonorsSlippageBound() public {
        pharaohRouter.setAmountOut(39e6);
        wavax.mint(settlement, 1e18);

        vm.startPrank(settlement);
        wavax.approve(address(router), 1e18);
        vm.expectRevert(bytes("Too little received"));
        router.swap(PHARAOH_ADAPTER_ID, address(wavax), address(usdc), 1e18, 40e6, _extra());
        vm.stopPrank();
    }

    function test_swapOnlyAggregationRouter() public {
        vm.expectRevert(PharaohAdapter.OnlyRouter.selector);
        vm.prank(keeper);
        adapter.swap(address(wavax), address(usdc), 1e18, 0, _extra());
    }

    function test_revertsMalformedOrNonPositiveTickSpacing() public {
        vm.expectRevert(PharaohAdapter.BadTickSpacing.selector);
        adapter.quote(address(wavax), address(usdc), 1e18, "");

        vm.expectRevert(PharaohAdapter.BadTickSpacing.selector);
        adapter.quote(address(wavax), address(usdc), 1e18, abi.encode(block.timestamp + 60, int24(0)));
    }

    function test_revertsExpiredKeeperDeadline() public {
        vm.warp(100);
        uint256 deadline = block.timestamp - 1;
        vm.expectRevert(abi.encodeWithSelector(PharaohAdapter.DeadlineExpired.selector, deadline));
        adapter.quote(address(wavax), address(usdc), 1e18, abi.encode(deadline, TICK_SPACING));
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(PharaohAdapter.ZeroAddress.selector);
        new PharaohAdapter(address(0), pharaohRouter, quoter);
    }
}
