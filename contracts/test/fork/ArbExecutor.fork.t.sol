// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SeltraArbExecutor} from "../../src/SeltraArbExecutor.sol";
import {LFJLBAdapter} from "../../src/adapters/LFJLBAdapter.sol";
import {PharaohAdapter} from "../../src/adapters/PharaohAdapter.sol";
import {ILBRouter} from "../../src/interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../../src/interfaces/external/ILBQuoter.sol";
import {IPharaohSwapRouter} from "../../src/interfaces/external/IPharaohSwapRouter.sol";
import {IPharaohQuoterV2} from "../../src/interfaces/external/IPharaohQuoterV2.sol";

/// @notice Opt-in atomic cross-venue validation against current Avalanche
///         mainnet LFJ and Pharaoh liquidity. A live market is not guaranteed
///         to contain an opportunity: profitable cycles execute and pay only
///         profit, while unprofitable cycles prove that both real swaps revert
///         atomically without losing treasury principal.
contract ArbExecutorForkTest is Test {
    address constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address constant USDC = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;

    ILBRouter constant LB_ROUTER = ILBRouter(0x18556DA13313f3532c54711497A8FedAC273220E);
    ILBQuoter constant LB_QUOTER = ILBQuoter(0x9A550a522BBaDFB69019b0432800Ed17855A51C3);
    IPharaohSwapRouter constant PHARAOH_ROUTER = IPharaohSwapRouter(0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c);
    IPharaohQuoterV2 constant PHARAOH_QUOTER = IPharaohQuoterV2(0xB7297301b7CC659BB96D51754643A0Df6eEA2138);

    uint8 constant LFJ = 1;
    uint8 constant PHARAOH = 3;
    int24 constant PHARAOH_TICK_SPACING = 10;

    address internal owner;
    address internal guardian;
    address internal operator;
    address internal treasury;
    SeltraArbExecutor internal executor;
    LFJLBAdapter internal lfj;
    PharaohAdapter internal pharaoh;

    function setUp() public {
        if (!vm.envOr("RUN_MAINNET_FORKS", false)) {
            vm.skip(true);
            return;
        }
        string memory url = vm.envOr("AVAX_RPC_URL", string(""));
        require(bytes(url).length != 0, "AVAX_RPC_URL required when RUN_MAINNET_FORKS=true");
        vm.createSelectFork(url);

        require(address(LB_ROUTER).code.length > 0, "LFJ router has no code");
        require(address(LB_QUOTER).code.length > 0, "LFJ quoter has no code");
        require(address(PHARAOH_ROUTER).code.length > 0, "Pharaoh router has no code");
        require(address(PHARAOH_QUOTER).code.length > 0, "Pharaoh quoter has no code");

        owner = makeAddr("owner");
        guardian = makeAddr("guardian");
        operator = makeAddr("operator");
        treasury = makeAddr("treasury");
        executor = new SeltraArbExecutor(owner, guardian, operator, treasury);
        lfj = new LFJLBAdapter(address(executor), LB_ROUTER, LB_QUOTER);
        pharaoh = new PharaohAdapter(address(executor), PHARAOH_ROUTER, PHARAOH_QUOTER);

        vm.startPrank(owner);
        executor.addAdapter(LFJ, address(lfj));
        executor.addAdapter(PHARAOH, address(pharaoh));
        executor.setTokenAllowed(WAVAX, true);
        executor.setTokenAllowed(USDC, true);
        vm.stopPrank();
    }

    function test_fork_crossVenueQuotesBothDirections() public {
        uint256 amountIn = 1e18;
        (, uint256 lfjUsdc) = _lfjExtra(WAVAX, USDC, amountIn);
        uint256 pharaohReturn = pharaoh.quote(USDC, WAVAX, lfjUsdc, _pharaohExtra());
        uint256 pharaohUsdc = pharaoh.quote(WAVAX, USDC, amountIn, _pharaohExtra());
        (, uint256 lfjReturn) = _lfjExtra(USDC, WAVAX, pharaohUsdc);

        assertGt(lfjUsdc, 0, "LFJ WAVAX/USDC quote");
        assertGt(pharaohReturn, 0, "Pharaoh USDC/WAVAX quote");
        assertGt(pharaohUsdc, 0, "Pharaoh WAVAX/USDC quote");
        assertGt(lfjReturn, 0, "LFJ USDC/WAVAX quote");
        emit log_named_uint("LFJ -> Pharaoh return for 1 WAVAX", pharaohReturn);
        emit log_named_uint("Pharaoh -> LFJ return for 1 WAVAX", lfjReturn);
    }

    function test_fork_atomicRoundTripNeverLosesPrincipal() public {
        uint256 amountIn = 1e18;
        (SeltraArbExecutor.Leg memory first, SeltraArbExecutor.Leg memory second, uint256 quotedReturn) =
            _bestCycle(amountIn);
        deal(WAVAX, address(executor), amountIn);
        uint256 principalBefore = IERC20(WAVAX).balanceOf(address(executor));

        if (quotedReturn > amountIn) {
            uint256 quotedProfit = quotedReturn - amountIn;
            uint256 minProfit = (quotedProfit * 9_000) / 10_000;
            if (minProfit == 0) minProfit = 1;
            vm.prank(operator);
            uint256 realized =
                executor.executeTwoLeg(WAVAX, USDC, amountIn, minProfit, block.timestamp + 60, first, second);
            assertGe(realized, minProfit, "realized live-fork profit");
            assertEq(IERC20(WAVAX).balanceOf(address(executor)), principalBefore, "principal retained");
            assertEq(IERC20(WAVAX).balanceOf(treasury), realized, "only profit paid");
        } else {
            vm.expectRevert(abi.encodeWithSelector(SeltraArbExecutor.InsufficientProfit.selector, 0, 1));
            vm.prank(operator);
            executor.executeTwoLeg(WAVAX, USDC, amountIn, 1, block.timestamp + 60, first, second);
            assertEq(IERC20(WAVAX).balanceOf(address(executor)), principalBefore, "revert retained principal");
            assertEq(IERC20(WAVAX).balanceOf(treasury), 0, "no false profit");
            assertEq(IERC20(USDC).balanceOf(address(executor)), 0, "no intermediate residue");
        }
    }

    function _bestCycle(uint256 amountIn)
        internal
        returns (SeltraArbExecutor.Leg memory first, SeltraArbExecutor.Leg memory second, uint256 quotedReturn)
    {
        (bytes memory lfjFirstExtra, uint256 lfjUsdc) = _lfjExtra(WAVAX, USDC, amountIn);
        bytes memory pharaohExtra = _pharaohExtra();
        uint256 lfjThenPharaoh = pharaoh.quote(USDC, WAVAX, lfjUsdc, pharaohExtra);

        uint256 pharaohUsdc = pharaoh.quote(WAVAX, USDC, amountIn, pharaohExtra);
        (bytes memory lfjSecondExtra, uint256 pharaohThenLfj) = _lfjExtra(USDC, WAVAX, pharaohUsdc);

        if (lfjThenPharaoh >= pharaohThenLfj) {
            first = SeltraArbExecutor.Leg({adapterId: LFJ, minAmountOut: (lfjUsdc * 99) / 100, extra: lfjFirstExtra});
            second = SeltraArbExecutor.Leg({
                adapterId: PHARAOH, minAmountOut: (lfjThenPharaoh * 99) / 100, extra: pharaohExtra
            });
            quotedReturn = lfjThenPharaoh;
        } else {
            first = SeltraArbExecutor.Leg({
                adapterId: PHARAOH, minAmountOut: (pharaohUsdc * 99) / 100, extra: pharaohExtra
            });
            second = SeltraArbExecutor.Leg({
                adapterId: LFJ, minAmountOut: (pharaohThenLfj * 99) / 100, extra: lfjSecondExtra
            });
            quotedReturn = pharaohThenLfj;
        }
    }

    function _lfjExtra(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (bytes memory extra, uint256 amountOut)
    {
        require(amountIn <= type(uint128).max, "LFJ amount too large");
        address[] memory route = new address[](2);
        route[0] = tokenIn;
        route[1] = tokenOut;
        // forge-lint: disable-next-line(unsafe-typecast)
        ILBQuoter.Quote memory quote = LB_QUOTER.findBestPathFromAmountIn(route, uint128(amountIn));
        require(quote.route.length == 2 && quote.binSteps.length == 1 && quote.versions.length == 1, "bad LFJ route");
        amountOut = quote.amounts[quote.amounts.length - 1];
        extra = abi.encode(block.timestamp + 60, quote.binSteps, quote.versions, quote.route);
    }

    function _pharaohExtra() internal view returns (bytes memory) {
        return abi.encode(block.timestamp + 60, PHARAOH_TICK_SPACING);
    }
}
