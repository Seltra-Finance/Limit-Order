// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {SeltraArbExecutor} from "../src/SeltraArbExecutor.sol";
import {MockDEXAdapter} from "../src/adapters/MockDEXAdapter.sol";
import {TestERC20} from "./utils/TestERC20.sol";

contract ArbExecutorTest is Test {
    uint8 internal constant VENUE_A = 1;
    uint8 internal constant VENUE_B = 2;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal outsider = makeAddr("outsider");

    SeltraArbExecutor internal executor;
    MockDEXAdapter internal venueA;
    MockDEXAdapter internal venueB;
    TestERC20 internal tokenA;
    TestERC20 internal tokenB;

    function setUp() public {
        tokenA = new TestERC20("Token A", "A", 18);
        tokenB = new TestERC20("Token B", "B", 18);
        executor = new SeltraArbExecutor(owner, guardian, operator, treasury);
        venueA = new MockDEXAdapter(address(executor), owner);
        venueB = new MockDEXAdapter(address(executor), owner);

        vm.startPrank(owner);
        executor.addAdapter(VENUE_A, address(venueA));
        executor.addAdapter(VENUE_B, address(venueB));
        executor.setTokenAllowed(address(tokenA), true);
        executor.setTokenAllowed(address(tokenB), true);
        venueA.setPrice(address(tokenA), address(tokenB), 2e18);
        venueB.setPrice(address(tokenB), address(tokenA), 0.51e18);
        vm.stopPrank();

        tokenA.mint(address(executor), 10e18);
        tokenB.mint(address(venueA), 100e18);
        tokenA.mint(address(venueB), 100e18);
    }

    function test_executeTwoLegPaysOnlyProfitAndRetainsPrincipal() public {
        SeltraArbExecutor.Leg memory first = _leg(VENUE_A, 2e18);
        SeltraArbExecutor.Leg memory second = _leg(VENUE_B, 1.01e18);

        vm.expectEmit(true, true, true, true);
        emit SeltraArbExecutor.ArbitrageExecuted(
            operator, address(tokenA), address(tokenB), VENUE_A, VENUE_B, 1e18, 2e18, 1.02e18, 0.02e18
        );
        vm.prank(operator);
        uint256 profit = executor.executeTwoLeg(
            address(tokenA), address(tokenB), 1e18, 0.01e18, block.timestamp + 30, first, second
        );

        assertEq(profit, 0.02e18);
        assertEq(tokenA.balanceOf(treasury), 0.02e18, "profit paid to treasury");
        assertEq(tokenA.balanceOf(address(executor)), 10e18, "principal retained");
        assertEq(tokenB.balanceOf(address(executor)), 0, "no intermediate residue");
    }

    function test_executeTwoLegRevertsAtomicallyBelowRequiredProfit() public {
        uint256 executorBefore = tokenA.balanceOf(address(executor));
        uint256 venueABefore = tokenA.balanceOf(address(venueA));
        uint256 venueBBefore = tokenB.balanceOf(address(venueB));

        vm.expectRevert(abi.encodeWithSelector(SeltraArbExecutor.InsufficientProfit.selector, 0.02e18, 0.03e18));
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.03e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1e18)
        );

        assertEq(tokenA.balanceOf(address(executor)), executorBefore);
        assertEq(tokenA.balanceOf(address(venueA)), venueABefore);
        assertEq(tokenB.balanceOf(address(venueB)), venueBBefore);
        assertEq(tokenA.balanceOf(treasury), 0);
    }

    function test_executeTwoLegEnforcesSecondLegMinimum() public {
        vm.expectRevert(MockDEXAdapter.InsufficientOutput.selector);
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1.03e18)
        );
    }

    function test_executeTwoLegOnlyOperator() public {
        vm.expectRevert(SeltraArbExecutor.NotOperator.selector);
        vm.prank(outsider);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1e18)
        );
    }

    function test_executeTwoLegRejectsExpiredPausedAndSameVenue() public {
        vm.expectRevert(abi.encodeWithSelector(SeltraArbExecutor.DeadlineExpired.selector, block.timestamp - 1));
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp - 1,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1e18)
        );

        vm.prank(guardian);
        executor.pauseAdapter(VENUE_A);
        vm.expectRevert(SeltraArbExecutor.AdapterPausedError.selector);
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1e18)
        );

        vm.prank(owner);
        executor.unpauseAdapter(VENUE_A);
        vm.expectRevert(SeltraArbExecutor.SameAdapter.selector);
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_A, 1e18)
        );
    }

    function test_executeTwoLegRejectsDisallowedTokenAndInsufficientCapital() public {
        vm.prank(owner);
        executor.setTokenAllowed(address(tokenB), false);
        vm.expectRevert(abi.encodeWithSelector(SeltraArbExecutor.TokenNotAllowed.selector, address(tokenB)));
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1e18)
        );

        vm.prank(owner);
        executor.setTokenAllowed(address(tokenB), true);
        vm.expectRevert(SeltraArbExecutor.InsufficientCapital.selector);
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            11e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 22e18),
            _leg(VENUE_B, 11e18)
        );
    }

    function test_globalPauseGuardianAndOwnerRecovery() public {
        vm.expectRevert(SeltraArbExecutor.NotGuardian.selector);
        vm.prank(outsider);
        executor.pauseExecutions();

        vm.prank(guardian);
        executor.pauseExecutions();
        vm.expectRevert(SeltraArbExecutor.ExecutionsPausedError.selector);
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1e18)
        );

        vm.prank(owner);
        executor.unpauseExecutions();
        vm.prank(operator);
        executor.executeTwoLeg(
            address(tokenA),
            address(tokenB),
            1e18,
            0.01e18,
            block.timestamp + 30,
            _leg(VENUE_A, 2e18),
            _leg(VENUE_B, 1e18)
        );

        vm.prank(owner);
        executor.sweep(address(tokenA), owner, 1e18);
        assertEq(tokenA.balanceOf(owner), 1e18);
    }

    function test_adapterRegistrationIsWriteOnceAndOwnerOnly() public {
        vm.expectRevert();
        vm.prank(outsider);
        executor.addAdapter(3, outsider);

        vm.startPrank(owner);
        vm.expectRevert(SeltraArbExecutor.AdapterAlreadySet.selector);
        executor.addAdapter(VENUE_A, outsider);
        vm.expectRevert(SeltraArbExecutor.ZeroAddress.selector);
        executor.addAdapter(3, address(0));
        vm.expectRevert(SeltraArbExecutor.AdapterNotContract.selector);
        executor.addAdapter(3, outsider);
        vm.stopPrank();
    }

    function test_constructorRejectsZeroCriticalAddresses() public {
        vm.expectRevert();
        new SeltraArbExecutor(address(0), guardian, operator, treasury);
        vm.expectRevert(SeltraArbExecutor.ZeroAddress.selector);
        new SeltraArbExecutor(owner, address(0), operator, treasury);
        vm.expectRevert(SeltraArbExecutor.ZeroAddress.selector);
        new SeltraArbExecutor(owner, guardian, address(0), treasury);
        vm.expectRevert(SeltraArbExecutor.ZeroAddress.selector);
        new SeltraArbExecutor(owner, guardian, operator, address(0));
    }

    function _leg(uint8 adapterId, uint256 minAmountOut) internal pure returns (SeltraArbExecutor.Leg memory) {
        return SeltraArbExecutor.Leg({adapterId: adapterId, minAmountOut: minAmountOut, extra: ""});
    }
}
