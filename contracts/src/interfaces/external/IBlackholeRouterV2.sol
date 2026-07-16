// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Blackhole RouterV2 interface (ThenaFi/Solidly lineage with
///         Algebra Integral concentrated liquidity). The six-field route struct
///         is Blackhole's extension: `stable` selects stable vs volatile
///         Solidly pools, `concentrated` routes the hop through Algebra CL.
///         Deployed addresses MUST be fetched live from Snowtrace before
///         wiring (spec 5.2); they are constructor params, never hardcoded.
interface IBlackholeRouterV2 {
    struct route {
        address pair;
        address from;
        address to;
        bool stable;
        bool concentrated;
        address receiver;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
