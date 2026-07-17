// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDEXAdapter} from "../interfaces/IDEXAdapter.sol";
import {ILBRouter} from "../interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../interfaces/external/ILBQuoter.sol";

/// @title LFJLBAdapter
/// @notice V1 production adapter for LFJ (Trader Joe) Liquidity Book. Always
///         integrates via the LBRouter, never the LBPair directly (spec 6.1).
///
///         `extra` encodes (uint256 deadline, uint256[] pairBinSteps,
///         uint8[] versions, address[] tokenPath): the routing hints plus an
///         explicit short deadline chosen by the keeper at submission time and
///         passed down through the settlement call, rather than the adapter
///         minting one from block.timestamp (spec 3.2). Order expiry is
///         enforced independently by the settlement contract and Permit2.
contract LFJLBAdapter is IDEXAdapter {
    using SafeERC20 for IERC20;

    error OnlyRouter();
    error BadPath();
    error AmountTooLarge();
    error ZeroAddress();

    address public immutable ROUTER; // Seltra aggregation router
    ILBRouter public immutable LB_ROUTER; // v2.1: 0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30
    ILBQuoter public immutable LB_QUOTER;

    constructor(address router_, ILBRouter lbRouter_, ILBQuoter lbQuoter_) {
        if (router_ == address(0) || address(lbRouter_) == address(0) || address(lbQuoter_) == address(0)) {
            revert ZeroAddress();
        }
        ROUTER = router_;
        LB_ROUTER = lbRouter_;
        LB_QUOTER = lbQuoter_;
    }

    /// @inheritdoc IDEXAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata extra)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != ROUTER) revert OnlyRouter();
        (uint256 deadline, ILBRouter.Path memory path) = _decode(tokenIn, tokenOut, extra);

        // Exact-amount approval; LBRouter consumes it fully in the swap.
        IERC20(tokenIn).forceApprove(address(LB_ROUTER), amountIn);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(msg.sender);
        LB_ROUTER.swapExactTokensForTokens(amountIn, minOut, path, msg.sender, deadline);
        IERC20(tokenIn).forceApprove(address(LB_ROUTER), 0);
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balanceBefore;
    }

    /// @inheritdoc IDEXAdapter
    /// @dev Quotes via LBQuoter best-path discovery over the hop list in
    ///      `extra` (or the direct pair when `extra` is empty).
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extra)
        external
        view
        returns (uint256)
    {
        address[] memory route;
        if (extra.length == 0) {
            route = new address[](2);
            route[0] = tokenIn;
            route[1] = tokenOut;
        } else {
            (, ILBRouter.Path memory path) = _decode(tokenIn, tokenOut, extra);
            route = new address[](path.tokenPath.length);
            for (uint256 i = 0; i < route.length; i++) {
                route[i] = address(path.tokenPath[i]);
            }
        }
        if (amountIn > type(uint128).max) revert AmountTooLarge();
        // forge-lint: disable-next-line(unsafe-typecast)
        ILBQuoter.Quote memory q = LB_QUOTER.findBestPathFromAmountIn(route, uint128(amountIn));
        return q.amounts[q.amounts.length - 1];
    }

    function _decode(address tokenIn, address tokenOut, bytes calldata extra)
        internal
        pure
        returns (uint256 deadline, ILBRouter.Path memory path)
    {
        uint256[] memory pairBinSteps;
        ILBRouter.Version[] memory versions;
        IERC20[] memory tokenPath;
        (deadline, pairBinSteps, versions, tokenPath) =
            abi.decode(extra, (uint256, uint256[], ILBRouter.Version[], IERC20[]));
        // Pin the decoded path to the order-derived endpoints.
        if (
            tokenPath.length != 2 || address(tokenPath[0]) != tokenIn || address(tokenPath[1]) != tokenOut
                || pairBinSteps.length != 1 || versions.length != 1
        ) revert BadPath();
        path = ILBRouter.Path({pairBinSteps: pairBinSteps, versions: versions, tokenPath: tokenPath});
    }
}
