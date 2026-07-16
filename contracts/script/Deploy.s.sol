// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {MockDEXAdapter} from "../src/adapters/MockDEXAdapter.sol";
import {LFJLBAdapter} from "../src/adapters/LFJLBAdapter.sol";
import {BlackholeAdapter} from "../src/adapters/BlackholeAdapter.sol";
import {PharaohAdapter} from "../src/adapters/PharaohAdapter.sol";
import {ISeltraAggregationRouter} from "../src/interfaces/ISeltraAggregationRouter.sol";
import {ILBRouter} from "../src/interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../src/interfaces/external/ILBQuoter.sol";
import {IBlackholeRouterV2} from "../src/interfaces/external/IBlackholeRouterV2.sol";
import {IBlackholeRouterHelper} from "../src/interfaces/external/IBlackholeRouterHelper.sol";
import {IPharaohSwapRouter} from "../src/interfaces/external/IPharaohSwapRouter.sol";
import {IPharaohQuoterV2} from "../src/interfaces/external/IPharaohQuoterV2.sol";

/// @notice Revised spec 1.11: one command deploys the full stack and writes
///         addresses.json. Fuji:
///
///   forge script script/Deploy.s.sol --rpc-url $FUJI_RPC_URL --broadcast --verify
///
/// Env:
///   PRIVATE_KEY            deployer key (required)
///   OWNER                  final owner, multisig/timelock (default: deployer)
///   GUARDIAN               pause guardian (default: deployer)
///   LFJ_LB_ROUTER          LBRouter address (default: canonical v2.1, present
///                          on both Avalanche mainnet and Fuji)
///   LFJ_LB_QUOTER          LBQuoter address (default: verified mainnet v2.1
///                          quoter; override on Fuji)
///   DEPLOY_MOCK_ADAPTER    default true; NEVER set on mainnet (spec 2.1)
///   BLACKHOLE_ROUTER_V2    verified RouterV2; zero skips adapter 2
///   BLACKHOLE_ROUTER_HELPER verified RouterHelper; zero skips adapter 2
///   BLACKHOLE_ALLOWED_POOL_0..9 pools to permit before ownership handoff
///   PHARAOH_SWAP_ROUTER    immutable CL SwapRouter; zero skips adapter 3
///   PHARAOH_QUOTER_V2      CL QuoterV2; zero skips adapter 3
///   ALLOWED_TOKENS         comma-free: pass via ALLOWED_TOKEN_0..N below
///   ALLOWED_TOKEN_0..9     tokens to allowlist at deploy time
contract Deploy is Script {
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint8 constant MOCK_ADAPTER_ID = 0;
    uint8 constant LFJ_ADAPTER_ID = 1;
    uint8 constant BLACKHOLE_ADAPTER_ID = 2;
    uint8 constant PHARAOH_ADAPTER_ID = 3;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);
        address guardian = vm.envOr("GUARDIAN", deployer);
        bool deployMock = vm.envOr("DEPLOY_MOCK_ADAPTER", true);
        if (block.chainid == 43_114) require(!deployMock, "mock adapter forbidden on Avalanche mainnet");
        address lbRouter = vm.envOr("LFJ_LB_ROUTER", 0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30);
        address lbQuoter = vm.envOr("LFJ_LB_QUOTER", 0x64b57F4249aA99a812212cee7DAEFEDC40B203cD);
        address blackholeRouter = vm.envOr(
            "BLACKHOLE_ROUTER_V2", block.chainid == 43_114 ? 0xe946A9f39312E2346BA79DAb865B0e9A74f2F981 : address(0)
        );
        address blackholeHelper = vm.envOr(
            "BLACKHOLE_ROUTER_HELPER", block.chainid == 43_114 ? 0x53D569BC4B37ADbBDB6ab447D92ADf42514AE480 : address(0)
        );
        address pharaohRouter = vm.envOr("PHARAOH_SWAP_ROUTER", 0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c);
        address pharaohQuoter = vm.envOr("PHARAOH_QUOTER_V2", 0xB7297301b7CC659BB96D51754643A0Df6eEA2138);

        vm.startBroadcast(pk);

        // 1. Resolve the canonical Permit2; deploy from the vendored bytecode
        //    only if this chain lacks it (spec 1.1).
        address permit2 = CANONICAL_PERMIT2;
        if (permit2.code.length == 0) {
            bytes memory creationCode = vm.getCode("Permit2.sol:Permit2");
            assembly {
                permit2 := create(0, add(creationCode, 0x20), mload(creationCode))
            }
            require(permit2 != address(0), "Permit2 deploy failed");
            console.log("Canonical Permit2 absent; deployed local Permit2 at", permit2);
        }

        // 2. Router first (the settlement takes it as an immutable), deployer
        //    as interim owner for wiring.
        SeltraAggregationRouter router = new SeltraAggregationRouter(deployer, guardian);

        // 3. Settlement.
        SeltraSettlement settlement = new SeltraSettlement(
            ISignatureTransfer(permit2), ISeltraAggregationRouter(address(router)), deployer, guardian
        );
        router.setSettlement(address(settlement));

        // 4. Adapters. The mock is a Fuji-only convenience and must never be
        //    registered on mainnet (spec 2.1).
        address mock;
        if (deployMock) {
            mock = address(new MockDEXAdapter(address(router), owner));
            router.addAdapter(MOCK_ADAPTER_ID, mock);
        }
        address lfj;
        if (lbRouter != address(0) && lbQuoter != address(0) && lbRouter.code.length > 0 && lbQuoter.code.length > 0) {
            lfj = address(new LFJLBAdapter(address(router), ILBRouter(lbRouter), ILBQuoter(lbQuoter)));
            router.addAdapter(LFJ_ADAPTER_ID, lfj);
        } else {
            console.log("LFJ router/quoter unavailable; skipping adapter 1");
        }
        address blackhole;
        if (
            blackholeRouter != address(0) && blackholeHelper != address(0) && blackholeRouter.code.length > 0
                && blackholeHelper.code.length > 0
        ) {
            blackhole = address(
                new BlackholeAdapter(
                    address(router),
                    IBlackholeRouterV2(blackholeRouter),
                    IBlackholeRouterHelper(blackholeHelper),
                    deployer
                )
            );
            for (uint256 i = 0; i < 10; i++) {
                address pool = vm.envOr(string.concat("BLACKHOLE_ALLOWED_POOL_", vm.toString(i)), address(0));
                if (pool != address(0)) BlackholeAdapter(blackhole).setPoolAllowed(pool, true);
            }
            if (owner != deployer) BlackholeAdapter(blackhole).transferOwnership(owner);
            router.addAdapter(BLACKHOLE_ADAPTER_ID, blackhole);
        } else {
            console.log("Blackhole RouterV2/RouterHelper unavailable; skipping adapter 2");
        }
        address pharaoh;
        if (
            pharaohRouter != address(0) && pharaohQuoter != address(0) && pharaohRouter.code.length > 0
                && pharaohQuoter.code.length > 0
        ) {
            pharaoh = address(
                new PharaohAdapter(address(router), IPharaohSwapRouter(pharaohRouter), IPharaohQuoterV2(pharaohQuoter))
            );
            router.addAdapter(PHARAOH_ADAPTER_ID, pharaoh);
        } else {
            console.log("Pharaoh router/quoter unavailable; skipping adapter 3");
        }

        // 5. Token allowlist (spec 1.5).
        for (uint256 i = 0; i < 10; i++) {
            address token = vm.envOr(string.concat("ALLOWED_TOKEN_", vm.toString(i)), address(0));
            if (token != address(0)) settlement.setTokenAllowed(token, true);
        }

        // 6. Hand ownership to the final owner (Ownable2Step: OWNER must call
        //    acceptOwnership from the multisig).
        if (owner != deployer) {
            settlement.transferOwnership(owner);
            router.transferOwnership(owner);
        }

        vm.stopBroadcast();

        // 7. addresses.json
        string memory json = "seltra";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "permit2", permit2);
        vm.serializeAddress(json, "settlement", address(settlement));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeAddress(json, "mockAdapter", mock);
        vm.serializeAddress(json, "lfjAdapter", lfj);
        vm.serializeAddress(json, "blackholeAdapter", blackhole);
        vm.serializeAddress(json, "pharaohAdapter", pharaoh);
        vm.serializeAddress(json, "owner", owner);
        string memory out = vm.serializeAddress(json, "guardian", guardian);
        vm.writeJson(out, "./addresses.json");
        console.log("Wrote addresses.json");
        console.log("Settlement:", address(settlement));
        console.log("Router:", address(router));
    }
}
