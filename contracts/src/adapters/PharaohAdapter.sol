// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDEXAdapter} from "../interfaces/IDEXAdapter.sol";
import {IPharaohSwapRouter} from "../interfaces/external/IPharaohSwapRouter.sol";
import {IPharaohQuoterV2} from "../interfaces/external/IPharaohQuoterV2.sol";

/// @title PharaohAdapter
/// @notice Single-hop concentrated-liquidity adapter for Pharaoh Exchange.
///         The external contracts are immutable and the only keeper-supplied
///         route fields are a short execution deadline and the pool tick
///         spacing. Token endpoints, amounts, recipient and slippage bound all
///         come from Seltra.
///
///         `extra` is `abi.encode(uint256 deadline, int24 tickSpacing)`.
contract PharaohAdapter is IDEXAdapter {
    using SafeERC20 for IERC20;

    error OnlyRouter();
    error BadTickSpacing();
    error DeadlineExpired(uint256 deadline);
    error ZeroAddress();

    address public immutable ROUTER;
    IPharaohSwapRouter public immutable PHARAOH_ROUTER;
    IPharaohQuoterV2 public immutable PHARAOH_QUOTER;

    constructor(address router_, IPharaohSwapRouter pharaohRouter_, IPharaohQuoterV2 pharaohQuoter_) {
        if (router_ == address(0) || address(pharaohRouter_) == address(0) || address(pharaohQuoter_) == address(0)) {
            revert ZeroAddress();
        }
        ROUTER = router_;
        PHARAOH_ROUTER = pharaohRouter_;
        PHARAOH_QUOTER = pharaohQuoter_;
    }

    /// @inheritdoc IDEXAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata extra)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != ROUTER) revert OnlyRouter();
        (uint256 deadline, int24 tickSpacing) = _decode(extra);

        IERC20(tokenIn).forceApprove(address(PHARAOH_ROUTER), amountIn);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(msg.sender);
        PHARAOH_ROUTER.exactInputSingle(
            IPharaohSwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                tickSpacing: tickSpacing,
                recipient: msg.sender,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(PHARAOH_ROUTER), 0);
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balanceBefore;
    }

    /// @inheritdoc IDEXAdapter
    /// @dev Must be called with eth_call rather than STATICCALL because the
    ///      official QuoterV2 performs and reverts an internal pool swap.
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extra)
        external
        returns (uint256 amountOut)
    {
        (, int24 tickSpacing) = _decode(extra);
        (amountOut,,,) = PHARAOH_QUOTER.quoteExactInputSingle(
            IPharaohQuoterV2.QuoteExactInputSingleParams({
                tokenIn: tokenIn, tokenOut: tokenOut, amountIn: amountIn, tickSpacing: tickSpacing, sqrtPriceLimitX96: 0
            })
        );
    }

    function _decode(bytes calldata extra) internal view returns (uint256 deadline, int24 tickSpacing) {
        if (extra.length != 64) revert BadTickSpacing();
        (deadline, tickSpacing) = abi.decode(extra, (uint256, int24));
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);
        if (tickSpacing <= 0) revert BadTickSpacing();
    }
}
