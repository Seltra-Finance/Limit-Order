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
    bytes32 constant BLACKHOLE_ACCEPT_SALT = keccak256("seltra.accept.blackhole.v1");

    function run() external {
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK")));
        address settlement = vm.envAddress("SETTLEMENT");
        address router = vm.envAddress("ROUTER");
        address blackhole = vm.envOr("BLACKHOLE_ADAPTER", address(0));
        address proposer = vm.envAddress("PROPOSER");
        address executor = vm.envOr("EXECUTOR", proposer);
        uint256 minDelay = timelock.getMinDelay();
        _writeManifest(timelock, proposer, executor, settlement, router, blackhole, minDelay);
        console.log("Prepared ownership calldata for existing timelock:", address(timelock));
    }

    function _writeManifest(
        TimelockController timelock,
        address proposer,
        address executor,
        address settlement,
        address router,
        address blackhole,
        uint256 minDelay
    ) internal {
        bytes memory acceptCall = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        string memory json = "seltra-governance";
        vm.serializeAddress(json, "timelock", address(timelock));
        vm.serializeAddress(json, "proposer", proposer);
        vm.serializeAddress(json, "executor", executor);
        vm.serializeAddress(json, "settlement", settlement);
        vm.serializeAddress(json, "router", router);
        vm.serializeAddress(json, "blackholeAdapter", blackhole);
        vm.serializeUint(json, "minDelay", minDelay);
        vm.serializeBytes(json, "acceptOwnershipCalldata", acceptCall);
        vm.serializeBytes(
            json,
            "scheduleSettlementCalldata",
            _scheduleOwnership(settlement, SETTLEMENT_ACCEPT_SALT, acceptCall, minDelay)
        );
        vm.serializeBytes(
            json, "scheduleRouterCalldata", _scheduleOwnership(router, ROUTER_ACCEPT_SALT, acceptCall, minDelay)
        );
        vm.serializeBytes(
            json,
            "scheduleBlackholeCalldata",
            blackhole == address(0)
                ? bytes("")
                : _scheduleOwnership(blackhole, BLACKHOLE_ACCEPT_SALT, acceptCall, minDelay)
        );
        vm.serializeBytes(
            json, "executeSettlementCalldata", _executeOwnership(settlement, SETTLEMENT_ACCEPT_SALT, acceptCall)
        );
        vm.serializeBytes(json, "executeRouterCalldata", _executeOwnership(router, ROUTER_ACCEPT_SALT, acceptCall));
        string memory out = vm.serializeBytes(
            json,
            "executeBlackholeCalldata",
            blackhole == address(0) ? bytes("") : _executeOwnership(blackhole, BLACKHOLE_ACCEPT_SALT, acceptCall)
        );
        vm.writeJson(out, "./governance-ownership.json");
    }

    function _scheduleOwnership(address target, bytes32 salt, bytes memory acceptCall, uint256 minDelay)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(TimelockController.schedule, (target, 0, acceptCall, NO_PREDECESSOR, salt, minDelay));
    }

    function _executeOwnership(address target, bytes32 salt, bytes memory acceptCall)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(TimelockController.execute, (target, 0, acceptCall, NO_PREDECESSOR, salt));
    }
}
