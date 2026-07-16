// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SeltraTestBase} from "./utils/SeltraTestBase.sol";
import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {MockDEXAdapter} from "../src/adapters/MockDEXAdapter.sol";

contract RouterTest is SeltraTestBase {
    function setUp() public override {
        super.setUp();
        _setMockMarket(address(wavax), address(usdc), 40e6, 1_000_000e6);
    }

    function test_swap_onlySettlement() public {
        vm.expectRevert(SeltraAggregationRouter.OnlySettlement.selector);
        vm.prank(keeper);
        router.swap(MOCK_ADAPTER_ID, address(wavax), address(usdc), 1e18, 0, "");
    }

    function test_swap_dispatchAndDelivery() public {
        // Impersonate the settlement to exercise the router in isolation.
        wavax.mint(address(settlement), 1e18);
        vm.startPrank(address(settlement));
        wavax.approve(address(router), 1e18);
        uint256 amountOut = router.swap(MOCK_ADAPTER_ID, address(wavax), address(usdc), 1e18, 0, "");
        vm.stopPrank();

        assertEq(amountOut, 40e6);
        assertEq(usdc.balanceOf(address(settlement)), 40e6, "output delivered to settlement");
        assertEq(usdc.balanceOf(address(router)), 0, "router keeps nothing");
    }

    function test_swap_revert_unknownAdapter() public {
        vm.expectRevert(SeltraAggregationRouter.UnknownAdapter.selector);
        vm.prank(address(settlement));
        router.swap(42, address(wavax), address(usdc), 1e18, 0, "");
    }

    function test_swap_revert_pausedAdapter() public {
        vm.prank(guardian);
        router.pauseAdapter(MOCK_ADAPTER_ID);
        assertFalse(router.isRegistered(MOCK_ADAPTER_ID));

        vm.expectRevert(SeltraAggregationRouter.AdapterPausedError.selector);
        vm.prank(address(settlement));
        router.swap(MOCK_ADAPTER_ID, address(wavax), address(usdc), 1e18, 0, "");

        // Owner unpauses, adapter usable again.
        vm.prank(owner);
        router.unpauseAdapter(MOCK_ADAPTER_ID);
        assertTrue(router.isRegistered(MOCK_ADAPTER_ID));
    }

    function test_pauseAdapter_onlyGuardian() public {
        vm.expectRevert(SeltraAggregationRouter.NotGuardian.selector);
        vm.prank(keeper);
        router.pauseAdapter(MOCK_ADAPTER_ID);

        vm.prank(guardian);
        router.pauseAdapter(MOCK_ADAPTER_ID);

        vm.expectRevert();
        vm.prank(guardian);
        router.unpauseAdapter(MOCK_ADAPTER_ID); // guardian cannot unpause
    }

    function test_addAdapter_writeOnceAndAuth() public {
        vm.startPrank(owner);
        vm.expectRevert(SeltraAggregationRouter.AdapterAlreadySet.selector);
        router.addAdapter(MOCK_ADAPTER_ID, makeAddr("evil"));

        vm.expectRevert(SeltraAggregationRouter.ZeroAddress.selector);
        router.addAdapter(1, address(0));
        vm.stopPrank();

        vm.expectRevert();
        vm.prank(keeper);
        router.addAdapter(7, makeAddr("adapter"));
    }

    function test_setSettlement_writeOnce() public {
        vm.expectRevert(SeltraAggregationRouter.SettlementAlreadySet.selector);
        vm.prank(owner);
        router.setSettlement(makeAddr("other"));
    }

    function test_quote() public {
        assertEq(router.quote(MOCK_ADAPTER_ID, address(wavax), address(usdc), 2e18, ""), 80e6);
    }

    function test_adapterSwap_onlyRouter() public {
        vm.expectRevert(MockDEXAdapter.OnlyRouter.selector);
        vm.prank(keeper);
        mock.swap(address(wavax), address(usdc), 1e18, 0, "");
    }

    function test_guardianCannotBeZero() public {
        vm.startPrank(owner);
        vm.expectRevert(SeltraAggregationRouter.ZeroAddress.selector);
        router.setGuardian(address(0));
        vm.expectRevert();
        settlement.setGuardian(address(0));
        vm.stopPrank();
    }
}
