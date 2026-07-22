// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {SeltraTestBase} from "./utils/SeltraTestBase.sol";
import {SeltraSettlement} from "../src/SeltraSettlement.sol";

/// @notice Phase 2 governance (revised spec 3.5): every privileged action goes
///         through timelock + multisig; direct owner calls stop working after
///         the handover; the guardian can still pause instantly.
contract GovernanceTest is SeltraTestBase {
    TimelockController internal timelock;
    address internal multisig = makeAddr("multisig");
    uint256 internal constant MIN_DELAY = 48 hours;
    bytes32 internal constant SALT = keccak256("seltra.governance.v1");

    function setUp() public override {
        super.setUp();

        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        timelock = new TimelockController(MIN_DELAY, proposers, proposers, address(0));

        // Two-step handover: current owner initiates, timelock accepts via a
        // scheduled operation.
        vm.startPrank(owner);
        settlement.transferOwnership(address(timelock));
        router.transferOwnership(address(timelock));
        vm.stopPrank();

        bytes memory acceptCall = abi.encodeWithSignature("acceptOwnership()");
        vm.startPrank(multisig);
        timelock.schedule(address(settlement), 0, acceptCall, bytes32(0), SALT, MIN_DELAY);
        timelock.schedule(address(router), 0, acceptCall, bytes32(0), SALT, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY);
        timelock.execute(address(settlement), 0, acceptCall, bytes32(0), SALT);
        timelock.execute(address(router), 0, acceptCall, bytes32(0), SALT);
        vm.stopPrank();
    }

    function test_ownershipHeldByTimelock() public view {
        assertEq(settlement.owner(), address(timelock));
        assertEq(router.owner(), address(timelock));
    }

    function test_timelockIsSelfAdministeredAndSignerHasOperationalRoles() public view {
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        assertTrue(timelock.hasRole(adminRole, address(timelock)));
        assertFalse(timelock.hasRole(adminRole, multisig));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), multisig));
    }

    function test_directOwnerCallsRevertAfterHandover() public {
        vm.expectRevert();
        vm.prank(owner);
        settlement.setSurplusParams(6_000, 500, treasury);

        vm.expectRevert();
        vm.prank(owner);
        router.addAdapter(9, makeAddr("adapter"));

        // The multisig cannot act directly either; only through the timelock.
        vm.expectRevert();
        vm.prank(multisig);
        settlement.setSurplusParams(6_000, 500, treasury);
    }

    function test_paramChangeThroughTimelock() public {
        bytes memory data = abi.encodeCall(SeltraSettlement.setSurplusParams, (6_000, 500, treasury));

        vm.prank(multisig);
        timelock.schedule(address(settlement), 0, data, bytes32(0), SALT, MIN_DELAY);

        // Not executable before the delay.
        vm.expectRevert();
        vm.prank(multisig);
        timelock.execute(address(settlement), 0, data, bytes32(0), SALT);

        vm.warp(block.timestamp + MIN_DELAY);
        vm.prank(multisig);
        timelock.execute(address(settlement), 0, data, bytes32(0), SALT);

        assertEq(settlement.makerSurplusBps(), 6_000);
        assertEq(settlement.protocolFeeBps(), 500);
        assertEq(settlement.treasury(), treasury);
    }

    function test_nonProposerCannotSchedule() public {
        bytes memory data = abi.encodeCall(SeltraSettlement.setSurplusParams, (6_000, 500, treasury));
        vm.expectRevert();
        vm.prank(keeper);
        timelock.schedule(address(settlement), 0, data, bytes32(0), SALT, MIN_DELAY);
    }

    /// @dev Emergency responsiveness survives the handover: the guardian
    ///      pauses instantly with no delay; only unpause needs the timelock.
    function test_guardianPausesInstantly_unpauseNeedsTimelock() public {
        vm.prank(guardian);
        settlement.pauseFills();
        assertTrue(settlement.fillsPaused());

        vm.expectRevert();
        vm.prank(guardian);
        settlement.unpauseFills();

        bytes memory data = abi.encodeCall(SeltraSettlement.unpauseFills, ());
        vm.startPrank(multisig);
        timelock.schedule(address(settlement), 0, data, bytes32(0), SALT, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY);
        timelock.execute(address(settlement), 0, data, bytes32(0), SALT);
        vm.stopPrank();
        assertFalse(settlement.fillsPaused());
    }
}
