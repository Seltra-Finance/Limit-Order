// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2 as console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SeltraArbExecutor} from "../src/SeltraArbExecutor.sol";

/// @notice Runs two real Fuji arbitrage transactions around a pause/unpause
///         drill and asserts profit delivery plus principal preservation.
contract RunArbExecutorFuji is Script {
    uint8 internal constant VENUE_A = 1;
    uint8 internal constant VENUE_B = 3;

    function run() external {
        require(block.chainid == 43_113, "Fuji only");
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address operator = vm.addr(privateKey);
        SeltraArbExecutor executor = SeltraArbExecutor(vm.envAddress("ARB_EXECUTOR"));
        address base = vm.envAddress("ARB_BASE_TOKEN");
        address quote = vm.envAddress("ARB_QUOTE_TOKEN");

        require(executor.operator() == operator, "wrong operator");
        require(executor.guardian() == operator, "wrong guardian");
        require(executor.owner() == operator, "wrong owner");
        require(executor.treasury() == operator, "wrong treasury");

        uint256 principalBefore = IERC20(base).balanceOf(address(executor));
        uint256 treasuryBefore = IERC20(base).balanceOf(operator);
        SeltraArbExecutor.Leg memory first = SeltraArbExecutor.Leg({adapterId: VENUE_A, minAmountOut: 10e6, extra: ""});
        SeltraArbExecutor.Leg memory second =
            SeltraArbExecutor.Leg({adapterId: VENUE_B, minAmountOut: 1.01e18, extra: ""});

        vm.startBroadcast(privateKey);
        uint256 firstProfit = executor.executeTwoLeg(base, quote, 1e18, 0.01e18, block.timestamp + 120, first, second);
        executor.pauseExecutions();
        executor.unpauseExecutions();
        uint256 secondProfit = executor.executeTwoLeg(base, quote, 1e18, 0.01e18, block.timestamp + 120, first, second);
        vm.stopBroadcast();

        require(firstProfit == 0.02e18 && secondProfit == 0.02e18, "unexpected profit");
        require(IERC20(base).balanceOf(address(executor)) == principalBefore, "principal changed");
        require(IERC20(base).balanceOf(operator) == treasuryBefore + firstProfit + secondProfit, "treasury mismatch");
        require(IERC20(quote).balanceOf(address(executor)) == 0, "intermediate residue");
        require(!executor.executionsPaused(), "executor left paused");

        console.log("first Fuji arbitrage profit", firstProfit);
        console.log("second Fuji arbitrage profit", secondProfit);
        console.log("executor principal", principalBefore);
        console.log("treasury profit received", firstProfit + secondProfit);
    }
}
