// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2 as console} from "forge-std/Script.sol";

import {SeltraArbExecutor} from "../src/SeltraArbExecutor.sol";
import {MockDEXAdapter} from "../src/adapters/MockDEXAdapter.sol";
import {TestERC20} from "../test/utils/TestERC20.sol";

/// @notice Fuji-only deployment for exercising atomic arbitrage with the
///         existing open-mint demo tokens. These mock venues must never be
///         used or deployed as production arbitrage adapters.
contract DeployArbExecutorFuji is Script {
    uint8 internal constant VENUE_A = 1;
    uint8 internal constant VENUE_B = 3;
    address internal constant DEFAULT_BASE = 0x760D9a5B4ae94f5e6c3ce014e3C116544515C830;
    address internal constant DEFAULT_QUOTE = 0x00B766567013BbCe12bF802f6E7C65F6da581Efe;

    function run() external {
        require(block.chainid == 43_113, "Fuji only");
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address base = vm.envOr("ARB_BASE_TOKEN", DEFAULT_BASE);
        address quote = vm.envOr("ARB_QUOTE_TOKEN", DEFAULT_QUOTE);
        require(base.code.length > 0 && quote.code.length > 0, "demo token unavailable");

        vm.startBroadcast(privateKey);
        SeltraArbExecutor executor = new SeltraArbExecutor(deployer, deployer, deployer, deployer);
        MockDEXAdapter venueA = new MockDEXAdapter(address(executor), deployer);
        MockDEXAdapter venueB = new MockDEXAdapter(address(executor), deployer);

        executor.addAdapter(VENUE_A, address(venueA));
        executor.addAdapter(VENUE_B, address(venueB));
        executor.setTokenAllowed(base, true);
        executor.setTokenAllowed(quote, true);

        // Venue A: 1 sWAVAX -> 10 sUSDC.
        venueA.setPrice(base, quote, 10e6);
        // Venue B: 10 sUSDC -> 1.02 sWAVAX.
        venueB.setPrice(quote, base, 1.02e29);

        TestERC20(base).mint(address(executor), 10e18);
        TestERC20(quote).mint(address(venueA), 1_000e6);
        TestERC20(base).mint(address(venueB), 100e18);
        vm.stopBroadcast();

        console.log("Fuji arb executor", address(executor));
        console.log("Fuji mock venue A", address(venueA));
        console.log("Fuji mock venue B", address(venueB));
        console.log("operator/guardian/owner/treasury", deployer);

        string memory key = "arbFuji";
        vm.serializeAddress(key, "baseToken", base);
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "executor", address(executor));
        vm.serializeAddress(key, "quoteToken", quote);
        vm.serializeAddress(key, "venueA", address(venueA));
        string memory json = vm.serializeAddress(key, "venueB", address(venueB));
        vm.writeJson(json, "arb-addresses.fuji.json");
    }
}
