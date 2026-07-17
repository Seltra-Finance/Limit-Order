// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDEXAdapter} from "../interfaces/IDEXAdapter.sol";
import {IBlackholeRouterV2} from "../interfaces/external/IBlackholeRouterV2.sol";
import {IBlackholeRouterHelper} from "../interfaces/external/IBlackholeRouterHelper.sol";

/// @title BlackholeAdapter
/// @notice V1.5 adapter, written and fork-testable now but NOT registered in
///         V1 (revised spec 6.2). Blackhole is a ThenaFi fork with Algebra
///         Integral CL; its RouterV2 route struct is
///         {pair, from, to, stable, concentrated, receiver}.
///
///         V1.5 gating implemented here: full-route allowlist (owner =
///         timelock), every hop's receiver pinned to the Seltra router (a bad
///         receiver can burn or divert funds), keeper-supplied explicit
///         deadline, and RouterV2/RouterHelper addresses are constructor params
///         verified live at deploy time, never hardcoded. The registry-
///         level guardian pause lives in SeltraAggregationRouter.
///
///         `extra` encodes (uint256 deadline, IBlackholeRouterV2.route[]).
contract BlackholeAdapter is IDEXAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    error OnlyRouter();
    error BadRoute();
    error InvalidReceiver(address receiver);
    error RouteNotAllowed(bytes32 routeKey);
    error ZeroAddress();

    event RouteAllowed(bytes32 indexed routeKey, bool allowed);

    address public immutable ROUTER; // Seltra aggregation router
    IBlackholeRouterV2 public immutable BH_ROUTER;
    IBlackholeRouterHelper public immutable BH_HELPER;

    /// @notice Every executable route field is bound into the allowlist key.
    ///         This prevents an allowlisted `pair` from being reused with a
    ///         different stable/concentrated pool selection.
    mapping(bytes32 => bool) public allowedRoutes;

    constructor(address router_, IBlackholeRouterV2 bhRouter_, IBlackholeRouterHelper bhHelper_, address owner_)
        Ownable(owner_)
    {
        if (router_ == address(0) || address(bhRouter_) == address(0) || address(bhHelper_) == address(0)) {
            revert ZeroAddress();
        }
        ROUTER = router_;
        BH_ROUTER = bhRouter_;
        BH_HELPER = bhHelper_;
    }

    function setRouteAllowed(address pair, address from, address to, bool stable, bool concentrated, bool allowed)
        external
        onlyOwner
    {
        bytes32 key = routeKey(pair, from, to, stable, concentrated);
        allowedRoutes[key] = allowed;
        emit RouteAllowed(key, allowed);
    }

    function routeKey(address pair, address from, address to, bool stable, bool concentrated)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(pair, from, to, stable, concentrated));
    }

    /// @inheritdoc IDEXAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata extra)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != ROUTER) revert OnlyRouter();
        (uint256 deadline, IBlackholeRouterV2.route[] memory routes) = _decode(tokenIn, tokenOut, extra);

        IERC20(tokenIn).forceApprove(address(BH_ROUTER), amountIn);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(msg.sender);
        BH_ROUTER.swapExactTokensForTokens(amountIn, minOut, routes, msg.sender, deadline);
        IERC20(tokenIn).forceApprove(address(BH_ROUTER), 0);
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - balanceBefore;
    }

    /// @inheritdoc IDEXAdapter
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extra)
        external
        returns (uint256)
    {
        (, IBlackholeRouterV2.route[] memory routes) = _decode(tokenIn, tokenOut, extra);
        (uint256[] memory amounts,,) = BH_HELPER.getAmountsOut(amountIn, routes);
        return amounts[amounts.length - 1];
    }

    function _decode(address tokenIn, address tokenOut, bytes calldata extra)
        internal
        view
        returns (uint256 deadline, IBlackholeRouterV2.route[] memory routes)
    {
        (deadline, routes) = abi.decode(extra, (uint256, IBlackholeRouterV2.route[]));
        // V1 intentionally supports one direct hop. Multi-hop Blackhole routes
        // require venue-specific intermediate receivers and are not admitted.
        if (routes.length != 1 || routes[0].from != tokenIn || routes[0].to != tokenOut) {
            revert BadRoute();
        }
        for (uint256 i = 0; i < routes.length; i++) {
            if (i > 0 && routes[i].from != routes[i - 1].to) revert BadRoute();
            if (routes[i].receiver != ROUTER) revert InvalidReceiver(routes[i].receiver);
            bytes32 key =
                routeKey(routes[i].pair, routes[i].from, routes[i].to, routes[i].stable, routes[i].concentrated);
            if (!allowedRoutes[key]) revert RouteNotAllowed(key);
        }
    }
}
