// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../../src/SeltraAggregationRouter.sol";
import {LFJLBAdapter} from "../../src/adapters/LFJLBAdapter.sol";
import {ISeltraAggregationRouter, RouteData} from "../../src/interfaces/ISeltraAggregationRouter.sol";
import {ILBRouter} from "../../src/interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../../src/interfaces/external/ILBQuoter.sol";
import {Order, OrderLib} from "../../src/libraries/OrderLib.sol";

/// @notice Revised spec 1.10 fork tests: LFJLBAdapter against real Liquidity
///         Book liquidity and the canonical Permit2 on Avalanche mainnet.
///         Skipped unless RUN_MAINNET_FORKS=true. Run:
///         RUN_MAINNET_FORKS=true AVAX_RPC_URL=https://api.avax.network/ext/bc/C/rpc forge test --mc LFJAdapterForkTest
contract LFJAdapterForkTest is Test {
    address constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address constant USDC = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
    ILBRouter constant LB_ROUTER = ILBRouter(0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30);
    ILBQuoter constant LB_QUOTER = ILBQuoter(0x64b57F4249aA99a812212cee7DAEFEDC40B203cD);
    ISignatureTransfer constant PERMIT2 = ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint8 constant LFJ_ADAPTER_ID = 1;

    SeltraAggregationRouter internal router;
    LFJLBAdapter internal adapter;
    SeltraSettlement internal settlement;

    uint256 internal makerKey = 0xA11CE;
    address internal maker;
    address internal keeper = address(0xCAFE);

    function setUp() public {
        if (!vm.envOr("RUN_MAINNET_FORKS", false)) {
            vm.skip(true);
            return;
        }
        string memory url = vm.envOr("AVAX_RPC_URL", string(""));
        require(bytes(url).length != 0, "AVAX_RPC_URL required when RUN_MAINNET_FORKS=true");
        vm.createSelectFork(url);

        address owner = makeAddr("owner");
        address guardian = makeAddr("guardian");
        maker = vm.addr(makerKey);

        router = new SeltraAggregationRouter(owner, guardian);
        adapter = new LFJLBAdapter(address(router), LB_ROUTER, LB_QUOTER);
        settlement = new SeltraSettlement(PERMIT2, ISeltraAggregationRouter(address(router)), owner, guardian);

        vm.startPrank(owner);
        router.setSettlement(address(settlement));
        router.addAdapter(LFJ_ADAPTER_ID, address(adapter));
        settlement.setTokenAllowed(WAVAX, true);
        settlement.setTokenAllowed(USDC, true);
        vm.stopPrank();

        deal(WAVAX, maker, 100e18);
        vm.prank(maker);
        IERC20(WAVAX).approve(address(PERMIT2), type(uint256).max);
    }

    /// @dev Best-path discovery via the live LBQuoter; extra = (deadline,
    ///      binSteps, versions, tokenPath).
    function _bestPathExtra(uint128 amountIn) internal view returns (bytes memory extra, uint256 quotedOut) {
        address[] memory route = new address[](2);
        route[0] = WAVAX;
        route[1] = USDC;
        ILBQuoter.Quote memory q = LB_QUOTER.findBestPathFromAmountIn(route, amountIn);
        quotedOut = q.amounts[q.amounts.length - 1];
        extra = abi.encode(block.timestamp + 60, q.binSteps, q.versions, q.route);
    }

    function _signWitness(Order memory order, ISignatureTransfer.PermitTransferFrom memory permit)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                OrderLib.WITNESS_TYPE_STRING
            )
        );
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(
                keccak256("TokenPermissions(address token,uint256 amount)"),
                permit.permitted.token,
                permit.permitted.amount
            )
        );
        bytes32 witness;
        {
            Order memory o = order;
            witness = keccak256(
                abi.encode(
                    OrderLib.ORDER_TYPEHASH,
                    o.maker,
                    o.receiver,
                    o.makerAsset,
                    o.takerAsset,
                    o.makingAmount,
                    o.takingAmount,
                    o.salt,
                    o.epoch,
                    o.expiry,
                    o.allowedSender,
                    o.flags
                )
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(typeHash, tokenPermissionsHash, address(settlement), permit.nonce, permit.deadline, witness)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", PERMIT2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_fork_quoteMatchesLBQuoter() public {
        (bytes memory extra, uint256 quotedOut) = _bestPathExtra(10e18);
        assertGt(quotedOut, 0, "no LFJ liquidity for WAVAX/USDC?");
        assertEq(router.quote(LFJ_ADAPTER_ID, WAVAX, USDC, 10e18, extra), quotedOut, "adapter quote == LBQuoter");
    }

    function test_fork_quoteSizesAndPriceImpact() public {
        (, uint256 q1) = _bestPathExtra(1e18);
        (, uint256 q10) = _bestPathExtra(10e18);
        (, uint256 q100) = _bestPathExtra(100e18);

        assertGt(q1, 0, "1 WAVAX quote");
        assertGt(q10, 0, "10 WAVAX quote");
        assertGt(q100, 0, "100 WAVAX quote");
        assertLe(q10, q1 * 10, "larger trade cannot improve unit price");
        assertLe(q100, q10 * 10, "larger trade cannot improve unit price");

        uint256 impactBps = 10_000 - ((q100 * 100) / q1);
        emit log_named_uint("LFJ 1 WAVAX quote", q1);
        emit log_named_uint("LFJ 10 WAVAX quote", q10);
        emit log_named_uint("LFJ 100 WAVAX quote", q100);
        emit log_named_uint("LFJ 100 WAVAX impact bps vs 1 WAVAX", impactBps);
        assertLe(impactBps, 50, "100 WAVAX price impact exceeds 50 bps gate");
    }

    /// @dev Full fillOrderDEX against real liquidity: witness pull through the
    ///      canonical Permit2, swap through the real LBRouter, maker invariant
    ///      and surplus split checked on realized output.
    function test_fork_fullDEXFillAgainstRealLiquidity() public {
        uint128 amountIn = 10e18;
        (bytes memory extra, uint256 quotedOut) = _bestPathExtra(amountIn);

        // Limit 2% below quote so the fill clears with surplus.
        uint256 takingAmount = (quotedOut * 98) / 100;
        Order memory order = Order({
            maker: maker,
            receiver: maker,
            makerAsset: WAVAX,
            takerAsset: USDC,
            makingAmount: amountIn,
            takingAmount: takingAmount,
            salt: 1,
            epoch: 0,
            expiry: uint40(block.timestamp + 1 hours),
            allowedSender: address(0),
            flags: 0
        });
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: WAVAX, amount: amountIn}),
            nonce: 7,
            deadline: order.expiry
        });
        bytes memory sig = _signWitness(order, permit);

        vm.prank(keeper);
        uint256 amountOut =
            settlement.fillOrderDEX(order, permit, sig, RouteData({adapterId: LFJ_ADAPTER_ID, extra: extra}));

        assertGe(amountOut, takingAmount, "maker invariant against real liquidity");
        assertGe(amountOut, (quotedOut * 99) / 100, "realized within 1% of quote");

        uint256 surplus = amountOut - takingAmount;
        uint256 improvement = (surplus * 7_000) / 10_000;
        assertEq(IERC20(USDC).balanceOf(maker), takingAmount + improvement, "maker paid with improvement");
        assertEq(IERC20(USDC).balanceOf(keeper), surplus - improvement, "keeper paid the rest");
        assertEq(IERC20(USDC).balanceOf(address(settlement)), 0, "no residue");
        assertEq(IERC20(WAVAX).balanceOf(address(settlement)), 0, "no residue");
    }
}
