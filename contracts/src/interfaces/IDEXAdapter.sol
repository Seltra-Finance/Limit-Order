// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal adapter interface per spec 5.3. The aggregation router
///         transfers `amountIn` of `tokenIn` to the adapter before calling
///         `swap`; the adapter must deliver the output to `msg.sender` (the
///         router) and return the realized amount.
interface IDEXAdapter {
    /// @param extra Opaque, adapter-specific route encoding: bin steps and
    ///        versions for LFJ, route structs for Blackhole, an int24 tick
    ///        spacing for Pharaoh, nothing for mock.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata extra)
        external
        returns (uint256 amountOut);

    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extra)
        external
        returns (uint256 amountOut);
}
