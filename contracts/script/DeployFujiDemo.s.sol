// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {MockDEXAdapter} from "../src/adapters/MockDEXAdapter.sol";
import {LFJLBAdapter} from "../src/adapters/LFJLBAdapter.sol";
import {ISeltraAggregationRouter} from "../src/interfaces/ISeltraAggregationRouter.sol";
import {ILBRouter} from "../src/interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../src/interfaces/external/ILBQuoter.sol";
import {TestERC20} from "../test/utils/TestERC20.sol";

/// @notice Fuji live-demo deployment (Phase 1 acceptance): the full Seltra
///         stack plus two demo tokens with open mint, a priced mock adapter
///         with inventory, and the token allowlist, so the whole fill loop can
///         be exercised end to end without third-party testnet liquidity
///         (revised spec 1.6 mock strategy).
///
///   PRIVATE_KEY=... forge script script/DeployFujiDemo.s.sol \
///     --rpc-url $FUJI_RPC_URL --broadcast
contract DeployFujiDemo is Script {
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant FUJI_LB_ROUTER = 0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30;
    uint8 constant MOCK_ADAPTER_ID = 0;
    uint8 constant LFJ_ADAPTER_ID = 1;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address guardian = vm.envOr("GUARDIAN", deployer);
        require(CANONICAL_PERMIT2.code.length > 0, "canonical Permit2 missing on this chain");

        vm.startBroadcast(pk);

        // Core stack; deployer is owner and guardian for the demo.
        SeltraAggregationRouter router = new SeltraAggregationRouter(deployer, guardian);
        SeltraSettlement settlement = new SeltraSettlement(
            ISignatureTransfer(CANONICAL_PERMIT2), ISeltraAggregationRouter(address(router)), deployer, guardian
        );
        router.setSettlement(address(settlement));

        MockDEXAdapter mock = new MockDEXAdapter(address(router), deployer);
        router.addAdapter(MOCK_ADAPTER_ID, address(mock));

        // Real LFJ adapter registered too (LBRouter v2.1 exists on Fuji).
        // Note: the demo quoter address is mainnet-verified; Fuji quoting is
        // best-effort and the demo fills route through the mock.
        if (FUJI_LB_ROUTER.code.length > 0) {
            address lbQuoter = vm.envOr("LFJ_LB_QUOTER", address(0));
            if (lbQuoter != address(0)) {
                LFJLBAdapter lfj = new LFJLBAdapter(address(router), ILBRouter(FUJI_LB_ROUTER), ILBQuoter(lbQuoter));
                router.addAdapter(LFJ_ADAPTER_ID, address(lfj));
            }
        }

        // Demo tokens: open mint, so the E2E script can stock makers freely.
        TestERC20 base = new TestERC20("Seltra Demo WAVAX", "sWAVAX", 18);
        TestERC20 quote = new TestERC20("Seltra Demo USDC", "sUSDC", 6);
        settlement.setTokenAllowed(address(base), true);
        settlement.setTokenAllowed(address(quote), true);

        // Mock market: 1 sWAVAX -> 41 sUSDC, with quote-side inventory.
        mock.setPrice(address(base), address(quote), 41e6);
        quote.mint(address(mock), 1_000_000e6);

        vm.stopBroadcast();

        string memory json = "seltra-fuji-demo";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "permit2", CANONICAL_PERMIT2);
        vm.serializeAddress(json, "settlement", address(settlement));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeAddress(json, "mockAdapter", address(mock));
        vm.serializeAddress(json, "baseToken", address(base));
        vm.serializeAddress(json, "quoteToken", address(quote));
        vm.serializeAddress(json, "deployer", deployer);
        string memory out = vm.serializeAddress(json, "guardian", guardian);
        vm.writeJson(out, "./addresses.fuji.json");

        console.log("settlement:", address(settlement));
        console.log("router:", address(router));
        console.log("mock adapter:", address(mock));
        console.log("sWAVAX:", address(base));
        console.log("sUSDC:", address(quote));
    }
}
