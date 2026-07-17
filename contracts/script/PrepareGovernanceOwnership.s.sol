// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Generates Safe-ready schedule and execute calldata for handing a
///         newly deployed settlement/router pair to an existing timelock.
/// @dev Read-only: this script never broadcasts a transaction.
contract PrepareGovernanceOwnership is Script {
    bytes32 constant NO_PREDECESSOR = bytes32(0);
    bytes32 constant SETTLEMENT_ACCEPT_SALT = keccak256("seltra.accept.settlement.v1");
    bytes32 constant ROUTER_ACCEPT_SALT = keccak256("seltra.accept.router.v1");

    function run() external {
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK")));
        address settlement = vm.envAddress("SETTLEMENT");
        address router = vm.envAddress("ROUTER");
        address proposer = vm.envAddress("PROPOSER");
        address executor = vm.envOr("EXECUTOR", proposer);
        uint256 minDelay = timelock.getMinDelay();
        bytes memory acceptCall = abi.encodeCall(Ownable2Step.acceptOwnership, ());

        bytes memory scheduleSettlement = abi.encodeCall(
            TimelockController.schedule, (settlement, 0, acceptCall, NO_PREDECESSOR, SETTLEMENT_ACCEPT_SALT, minDelay)
        );
        bytes memory scheduleRouter = abi.encodeCall(
            TimelockController.schedule, (router, 0, acceptCall, NO_PREDECESSOR, ROUTER_ACCEPT_SALT, minDelay)
        );
        bytes memory executeSettlement = abi.encodeCall(
            TimelockController.execute, (settlement, 0, acceptCall, NO_PREDECESSOR, SETTLEMENT_ACCEPT_SALT)
        );
        bytes memory executeRouter =
            abi.encodeCall(TimelockController.execute, (router, 0, acceptCall, NO_PREDECESSOR, ROUTER_ACCEPT_SALT));

        string memory json = "seltra-governance";
        vm.serializeAddress(json, "timelock", address(timelock));
        vm.serializeAddress(json, "proposer", proposer);
        vm.serializeAddress(json, "executor", executor);
        vm.serializeAddress(json, "settlement", settlement);
        vm.serializeAddress(json, "router", router);
        vm.serializeUint(json, "minDelay", minDelay);
        vm.serializeBytes(json, "acceptOwnershipCalldata", acceptCall);
        vm.serializeBytes(json, "scheduleSettlementCalldata", scheduleSettlement);
        vm.serializeBytes(json, "scheduleRouterCalldata", scheduleRouter);
        vm.serializeBytes(json, "executeSettlementCalldata", executeSettlement);
        string memory out = vm.serializeBytes(json, "executeRouterCalldata", executeRouter);
        vm.writeJson(out, "./governance-ownership.json");

        console.log("Prepared ownership calldata for existing timelock:", address(timelock));
    }
}
