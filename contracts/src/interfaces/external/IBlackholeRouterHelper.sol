// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IBlackholeRouterV2} from "./IBlackholeRouterV2.sol";

/// @notice Quote helper used by Blackhole's current RouterV2 deployment.
/// @dev The call is deliberately non-view: concentrated quotes invoke a
///      revert-simulation quoter and therefore must be executed with CALL
///      (or eth_call off-chain), not STATICCALL.
interface IBlackholeRouterHelper {
    function getAmountsOut(uint256 amountIn, IBlackholeRouterV2.route[] memory routes)
        external
        returns (uint256[] memory amounts, uint256[] memory priceBeforeSwap, uint256[] memory priceAfterSwap);
}
