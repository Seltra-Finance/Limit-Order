// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Pharaoh/Ramses V3 exact-input interface used by Seltra.
interface IPharaohSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
