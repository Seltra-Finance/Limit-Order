// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IProductionSafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// @notice Phase 2 governance wiring (revised spec 2.1/3.5): all privileged
///         actions (adapter registration, fee params, allowlists, treasury,
///         unpause) go through a TimelockController owned by the multisig.
///         Settlement logic itself stays immutable; only the Ownable owner
///         moves behind the timelock.
///
/// Flow (Ownable2Step means ownership must be *accepted* by the timelock,
/// which itself takes a schedule -> wait -> execute round trip):
///
///   1. deploy      deploys the timelock, calls transferOwnership(timelock)
///                  on settlement + router + optional Blackhole adapter, and schedules
///                  acceptOwnership() calls in the timelock.
///   2. (wait MIN_DELAY)
///   3. acceptOwnership   executes the scheduled acceptOwnership() calls.
///
/// Generic parameter changes afterwards:
///   4. schedule    schedules TARGET.call(CALLDATA) after MIN_DELAY.
///   5. execute     executes it once the delay has passed.
///
/// Env:
///   PRIVATE_KEY   proposer/executor key (the multisig in production)
///   TIMELOCK_MIN_DELAY  seconds (default 172800 = 48h; use e.g. 120 on Fuji)
///   PROPOSER      timelock proposer+canceller (default: deployer; the
///                 multisig Safe in production)
///   EXECUTOR      timelock executor (default: PROPOSER)
///   SETTLEMENT, ROUTER      the deployed contracts
///   BLACKHOLE_ADAPTER       optional Ownable2Step adapter (required when id 2 is registered)
///   TIMELOCK      (steps 2-5) the deployed timelock
///   TARGET, CALLDATA, TIMELOCK_SALT   (schedule/execute) the operation
contract Governance is Script {
    bytes32 constant NO_PREDECESSOR = bytes32(0);
    bytes32 constant SETTLEMENT_ACCEPT_SALT = keccak256("seltra.accept.settlement.v1");
    bytes32 constant ROUTER_ACCEPT_SALT = keccak256("seltra.accept.router.v1");
    bytes32 constant BLACKHOLE_ACCEPT_SALT = keccak256("seltra.accept.blackhole.v1");

    /// @notice Production-first flow: deploy the timelock before the protocol
    ///         so Deploy.s.sol can set it as the pending owner immediately.
    ///         PROPOSER/EXECUTOR should both be the already-deployed Safe.
    function deployTimelockOnly() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", uint256(48 hours));
        address proposer = vm.envOr("PROPOSER", deployer);
        address executor = vm.envOr("EXECUTOR", proposer);
        if (block.chainid == 43_114) {
            require(minDelay >= 48 hours, "mainnet timelock delay below 48h");
            require(proposer != deployer && proposer.code.length > 0, "mainnet proposer must be a Safe");
            require(executor == proposer, "mainnet executor must be the Safe");
            address[] memory owners = IProductionSafe(proposer).getOwners();
            uint256 threshold = IProductionSafe(proposer).getThreshold();
            require(threshold >= 2 && owners.length >= threshold, "mainnet Safe threshold too low");
        }
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;

        vm.startBroadcast(pk);
        TimelockController timelock = new TimelockController(minDelay, proposers, executors, address(0));
        vm.stopBroadcast();

        string memory json = "seltra-timelock";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "timelock", address(timelock));
        vm.serializeAddress(json, "proposer", proposer);
        vm.serializeAddress(json, "executor", executor);
        string memory out = vm.serializeUint(json, "minDelay", minDelay);
        vm.writeJson(out, "./timelock.json");
        console.log("timelock:", address(timelock));
    }

    function deploy() external {
        require(block.chainid != 43_114, "mainnet must use deployTimelockOnly before protocol deployment");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", uint256(48 hours));
        address proposer = vm.envOr("PROPOSER", deployer);
        address executor = vm.envOr("EXECUTOR", proposer);
        address settlement = vm.envAddress("SETTLEMENT");
        address router = vm.envAddress("ROUTER");
        address blackhole = vm.envOr("BLACKHOLE_ADAPTER", address(0));

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;

        vm.startBroadcast(pk);

        // admin = address(0): the timelock is self-administered; role changes
        // themselves must go through the delay.
        TimelockController timelock = new TimelockController(minDelay, proposers, executors, address(0));

        // Begin the two-step ownership handover.
        Ownable2Step(settlement).transferOwnership(address(timelock));
        Ownable2Step(router).transferOwnership(address(timelock));
        if (blackhole != address(0)) Ownable2Step(blackhole).transferOwnership(address(timelock));

        // An EOA proposer can schedule inline. A Safe proposer uses the
        // generated governance-ownership.json payloads instead.
        bytes memory acceptCall = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        if (proposer == deployer) {
            timelock.schedule(settlement, 0, acceptCall, NO_PREDECESSOR, SETTLEMENT_ACCEPT_SALT, minDelay);
            timelock.schedule(router, 0, acceptCall, NO_PREDECESSOR, ROUTER_ACCEPT_SALT, minDelay);
            if (blackhole != address(0)) {
                timelock.schedule(blackhole, 0, acceptCall, NO_PREDECESSOR, BLACKHOLE_ACCEPT_SALT, minDelay);
            }
        }

        vm.stopBroadcast();
        _writeOwnershipManifest(
            timelock, proposer, executor, settlement, router, blackhole, minDelay, "./governance-ownership.json"
        );

        console.log("timelock:", address(timelock));
        console.log("minDelay:", minDelay);
        if (proposer == deployer) {
            console.log("acceptOwnership scheduled for protocol Ownable contracts");
        } else {
            console.log("Safe must submit the schedule payloads from governance-ownership.json");
        }
    }

    function _writeOwnershipManifest(
        TimelockController timelock,
        address proposer,
        address executor,
        address settlement,
        address router,
        address blackhole,
        uint256 minDelay,
        string memory path
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
        vm.writeJson(out, path);
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

    function acceptOwnership() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK")));
        address settlement = vm.envAddress("SETTLEMENT");
        address router = vm.envAddress("ROUTER");
        address blackhole = vm.envOr("BLACKHOLE_ADAPTER", address(0));
        bytes memory acceptCall = abi.encodeCall(Ownable2Step.acceptOwnership, ());

        vm.startBroadcast(pk);
        timelock.execute(settlement, 0, acceptCall, NO_PREDECESSOR, SETTLEMENT_ACCEPT_SALT);
        timelock.execute(router, 0, acceptCall, NO_PREDECESSOR, ROUTER_ACCEPT_SALT);
        if (blackhole != address(0)) {
            timelock.execute(blackhole, 0, acceptCall, NO_PREDECESSOR, BLACKHOLE_ACCEPT_SALT);
        }
        vm.stopBroadcast();

        console.log("settlement owner:", Ownable2Step(settlement).owner());
        console.log("router owner:", Ownable2Step(router).owner());
        if (blackhole != address(0)) console.log("Blackhole adapter owner:", Ownable2Step(blackhole).owner());
    }

    /// @dev Schedule an arbitrary owner action, e.g.
    ///      TARGET=$SETTLEMENT CALLDATA=$(cast calldata "setSurplusParams(uint16,uint16,address)" 7000 500 $TREASURY)
    function schedule() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK")));
        address target = vm.envAddress("TARGET");
        bytes memory data = vm.envBytes("CALLDATA");
        bytes32 salt = vm.envBytes32("TIMELOCK_SALT");
        uint256 delay = vm.envOr("DELAY", timelock.getMinDelay());

        vm.startBroadcast(pk);
        timelock.schedule(target, 0, data, NO_PREDECESSOR, salt, delay);
        vm.stopBroadcast();

        bytes32 id = timelock.hashOperation(target, 0, data, NO_PREDECESSOR, salt);
        console.log("scheduled operation:");
        console.logBytes32(id);
        console.log("executable at:", block.timestamp + delay);
    }

    function execute() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK")));
        address target = vm.envAddress("TARGET");
        bytes memory data = vm.envBytes("CALLDATA");
        bytes32 salt = vm.envBytes32("TIMELOCK_SALT");

        vm.startBroadcast(pk);
        timelock.execute(target, 0, data, NO_PREDECESSOR, salt);
        vm.stopBroadcast();
        console.log("executed");
    }
}
