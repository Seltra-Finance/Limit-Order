// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Pharaoh/Ramses V3 QuoterV2 interface used by Seltra.
/// @dev Pharaoh's quoter simulates a pool swap and deliberately catches the
///      callback revert, so this function cannot execute under STATICCALL.
///      Seltra exposes it to off-chain callers through eth_call instead.
interface IPharaohQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        int24 tickSpacing;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}
