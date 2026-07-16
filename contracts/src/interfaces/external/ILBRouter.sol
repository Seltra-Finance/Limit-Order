// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal LFJ (Trader Joe) Liquidity Book router interface, v2.1/v2.2.
///         LBRouter v2.1 canonical deployment: 0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30
///         (same address on Avalanche mainnet and Fuji).
interface ILBRouter {
    enum Version {
        V1,
        V2,
        V2_1,
        V2_2
    }

    struct Path {
        uint256[] pairBinSteps;
        Version[] versions;
        IERC20[] tokenPath;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Path memory path,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut);
}
