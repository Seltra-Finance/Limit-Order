// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Keeper-supplied route hints (revised spec 1.4). Carries NO
///         economics: no token addresses, no amounts, no call targets, no
///         receivers. Everything economic is derived by the settlement
///         contract from the signed order, so there is nothing for a
///         malicious keeper to redefine (LI.FI / Socket hardening, spec 6).
struct RouteData {
    uint8 adapterId;
    bytes extra;
}

interface ISeltraAggregationRouter {
    /// @notice Swap `amountIn` of `tokenIn` (pulled from the caller) for at
    ///         least `minOut` of `tokenOut`, delivered back to the caller.
    ///         Callable only by the settlement contract.
    function swap(
        uint8 adapterId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata extra
    ) external returns (uint256 amountOut);

    function quote(uint8 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extra)
        external
        returns (uint256 amountOut);

    /// @notice True iff the adapter id is registered and not guardian-paused.
    function isRegistered(uint8 id) external view returns (bool);

    function adapters(uint8 id) external view returns (address);
}
