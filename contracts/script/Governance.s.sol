// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

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
///                  on settlement + router, and schedules both
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
///   TIMELOCK      (steps 2-5) the deployed timelock
///   TARGET, CALLDATA, TIMELOCK_SALT   (schedule/execute) the operation
contract Governance is Script {
    bytes32 constant NO_PREDECESSOR = bytes32(0);
    bytes32 constant SETTLEMENT_ACCEPT_SALT = keccak256("seltra.accept.settlement.v1");
    bytes32 constant ROUTER_ACCEPT_SALT = keccak256("seltra.accept.router.v1");

    function deploy() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", uint256(48 hours));
        address proposer = vm.envOr("PROPOSER", deployer);
        address executor = vm.envOr("EXECUTOR", proposer);
        address settlement = vm.envAddress("SETTLEMENT");
        address router = vm.envAddress("ROUTER");

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

        // An EOA proposer can schedule inline. A Safe proposer uses the
        // generated governance-ownership.json payloads instead.
        bytes memory acceptCall = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        if (proposer == deployer) {
            timelock.schedule(settlement, 0, acceptCall, NO_PREDECESSOR, SETTLEMENT_ACCEPT_SALT, minDelay);
            timelock.schedule(router, 0, acceptCall, NO_PREDECESSOR, ROUTER_ACCEPT_SALT, minDelay);
        }

        vm.stopBroadcast();

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

        console.log("timelock:", address(timelock));
        console.log("minDelay:", minDelay);
        if (proposer == deployer) {
            console.log("acceptOwnership scheduled for settlement + router");
        } else {
            console.log("Safe must submit both schedule payloads from governance-ownership.json");
        }
    }

    function acceptOwnership() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK")));
        address settlement = vm.envAddress("SETTLEMENT");
        address router = vm.envAddress("ROUTER");
        bytes memory acceptCall = abi.encodeCall(Ownable2Step.acceptOwnership, ());

        vm.startBroadcast(pk);
        timelock.execute(settlement, 0, acceptCall, NO_PREDECESSOR, SETTLEMENT_ACCEPT_SALT);
        timelock.execute(router, 0, acceptCall, NO_PREDECESSOR, ROUTER_ACCEPT_SALT);
        vm.stopBroadcast();

        console.log("settlement owner:", Ownable2Step(settlement).owner());
        console.log("router owner:", Ownable2Step(router).owner());
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
