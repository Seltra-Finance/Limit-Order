// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDEXAdapter} from "../interfaces/IDEXAdapter.sol";

/// @title MockDEXAdapter
/// @notice Fuji/testing adapter with a settable price so the full fill flow
///         can be exercised end to end without third-party testnet liquidity
///         (spec 1.5 testnet strategy). Holds its own token inventory; the
///         operator funds it by plain ERC-20 transfer and sets prices.
contract MockDEXAdapter is IDEXAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    error OnlyRouter();
    error PriceNotSet();
    error InsufficientOutput();
    error ZeroAddress();

    event PriceSet(address indexed tokenIn, address indexed tokenOut, uint256 rateWad);

    address public immutable ROUTER;

    /// @notice rateWad[tokenIn][tokenOut]: amountOut = amountIn * rate / 1e18.
    ///         The rate must bake in any decimals difference between the pair.
    mapping(address => mapping(address => uint256)) public rateWad;

    constructor(address router_, address owner_) Ownable(owner_) {
        if (router_ == address(0)) revert ZeroAddress();
        ROUTER = router_;
    }

    function setPrice(address tokenIn, address tokenOut, uint256 rateWad_) external onlyOwner {
        rateWad[tokenIn][tokenOut] = rateWad_;
        emit PriceSet(tokenIn, tokenOut, rateWad_);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @inheritdoc IDEXAdapter
    /// @dev The router has already transferred `amountIn` of tokenIn here; the
    ///      input simply joins the mock's inventory.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != ROUTER) revert OnlyRouter();
        // Report the delivered amount by balance delta, like the production
        // adapters, so fee-on-transfer behavior surfaces honestly in tests.
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(msg.sender);
        IERC20(tokenOut).safeTransfer(msg.sender, _quote(tokenIn, tokenOut, amountIn));
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balanceBefore;
        if (amountOut < minOut) revert InsufficientOutput();
    }

    /// @inheritdoc IDEXAdapter
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata)
        external
        view
        returns (uint256)
    {
        return _quote(tokenIn, tokenOut, amountIn);
    }

    function _quote(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        uint256 rate = rateWad[tokenIn][tokenOut];
        if (rate == 0) revert PriceNotSet();
        return (amountIn * rate) / 1e18;
    }
}
