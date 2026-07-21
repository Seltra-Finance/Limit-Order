// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2 as console} from "forge-std/Script.sol";

import {SeltraArbExecutor} from "../src/SeltraArbExecutor.sol";
import {LFJLBAdapter} from "../src/adapters/LFJLBAdapter.sol";
import {PharaohAdapter} from "../src/adapters/PharaohAdapter.sol";
import {ILBRouter} from "../src/interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../src/interfaces/external/ILBQuoter.sol";
import {IPharaohSwapRouter} from "../src/interfaces/external/IPharaohSwapRouter.sol";
import {IPharaohQuoterV2} from "../src/interfaces/external/IPharaohQuoterV2.sol";

interface IArbTimelock {
    function getMinDelay() external view returns (uint256);
}

/// @notice Deploys the isolated treasury arbitrage executor and dedicated LFJ
///         and Pharaoh adapter instances. This script never funds the executor
///         and never submits an arbitrage transaction. On Avalanche mainnet,
///         OWNER must be a deployed timelock with at least a 48-hour delay;
///         GUARDIAN must be a deployed contract approved as the production Safe;
///         its pending Ownable2Step handoff must be accepted before funding.
contract DeployArbExecutor is Script {
    uint8 internal constant LFJ_ADAPTER_ID = 1;
    uint8 internal constant PHARAOH_ADAPTER_ID = 3;

    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address owner = vm.envAddress("OWNER");
        address guardian = vm.envAddress("GUARDIAN");
        address operator = vm.envAddress("OPERATOR");
        address treasury = vm.envAddress("TREASURY");

        address lbRouter = vm.envOr("LFJ_LB_ROUTER", 0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30);
        address lbQuoter = vm.envOr("LFJ_LB_QUOTER", 0xd76019A16606FDa4651f636D9751f500Ed776250);
        address pharaohRouter = vm.envOr("PHARAOH_SWAP_ROUTER", 0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c);
        address pharaohQuoter = vm.envOr("PHARAOH_QUOTER_V2", 0xB7297301b7CC659BB96D51754643A0Df6eEA2138);

        require(owner != address(0), "OWNER required");
        require(guardian != address(0), "GUARDIAN required");
        require(operator != address(0), "OPERATOR required");
        require(treasury != address(0), "TREASURY required");
        require(lbRouter.code.length > 0 && lbQuoter.code.length > 0, "LFJ contracts unavailable");
        require(pharaohRouter.code.length > 0 && pharaohQuoter.code.length > 0, "Pharaoh contracts unavailable");
        if (block.chainid == 43_114) {
            require(owner != deployer && owner.code.length > 0, "mainnet OWNER must be a deployed timelock");
            require(IArbTimelock(owner).getMinDelay() >= 48 hours, "mainnet timelock delay below 48h");
            require(guardian != deployer && guardian.code.length > 0, "mainnet GUARDIAN must be a contract");
        }

        vm.startBroadcast(privateKey);
        SeltraArbExecutor executor = new SeltraArbExecutor(deployer, guardian, operator, treasury);
        LFJLBAdapter lfj = new LFJLBAdapter(address(executor), ILBRouter(lbRouter), ILBQuoter(lbQuoter));
        PharaohAdapter pharaoh =
            new PharaohAdapter(address(executor), IPharaohSwapRouter(pharaohRouter), IPharaohQuoterV2(pharaohQuoter));

        executor.addAdapter(LFJ_ADAPTER_ID, address(lfj));
        executor.addAdapter(PHARAOH_ADAPTER_ID, address(pharaoh));
        for (uint256 i = 0; i < 10; i++) {
            address token = vm.envOr(string.concat("ALLOWED_TOKEN_", vm.toString(i)), address(0));
            if (token != address(0)) executor.setTokenAllowed(token, true);
        }
        if (owner != deployer) executor.transferOwnership(owner);
        vm.stopBroadcast();

        console.log("SeltraArbExecutor", address(executor));
        console.log("LFJ arb adapter", address(lfj));
        console.log("Pharaoh arb adapter", address(pharaoh));
        console.log("temporary owner", deployer);
        console.log("pending owner", owner == deployer ? address(0) : owner);
        console.log("guardian", guardian);
        console.log("operator", operator);
        console.log("treasury", treasury);

        string memory key = "arb";
        vm.serializeAddress(key, "executor", address(executor));
        vm.serializeAddress(key, "guardian", guardian);
        vm.serializeAddress(key, "lfjAdapter", address(lfj));
        vm.serializeAddress(key, "operator", operator);
        vm.serializeAddress(key, "owner", owner);
        vm.serializeAddress(key, "pharaohAdapter", address(pharaoh));
        string memory json = vm.serializeAddress(key, "treasury", treasury);
        vm.writeJson(json, string.concat("arb-addresses.", vm.toString(block.chainid), ".json"));
    }
}
