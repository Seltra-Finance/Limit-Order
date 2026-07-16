// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDEXAdapter} from "./interfaces/IDEXAdapter.sol";
import {ISeltraAggregationRouter} from "./interfaces/ISeltraAggregationRouter.sol";

/// @title SeltraAggregationRouter
/// @notice In-house aggregation router: immutable code, mutable adapter
///         registry behind the owner (timelock + multisig in production),
///         per-adapter guardian pause (revised spec 1.6).
///
///         Structural hardening against the LI.FI (Jul 2024) and
///         Socket/Bungee (Jan 2024) exploit class: the router never accepts a
///         raw call target, never forwards caller calldata into a low-level
///         call, never delegatecalls, and is callable only by the settlement
///         contract. Adapter ids are write-once, so an id can never be
///         silently re-pointed.
contract SeltraAggregationRouter is ISeltraAggregationRouter, Ownable2Step {
    using SafeERC20 for IERC20;

    error UnknownAdapter();
    error AdapterAlreadySet();
    error AdapterPausedError();
    error OnlySettlement();
    error SettlementAlreadySet();
    error NotGuardian();
    error ZeroAddress();
    error InsufficientOutput();

    event AdapterAdded(uint8 indexed id, address adapter);
    event AdapterPaused(uint8 indexed id, address guardian);
    event AdapterUnpaused(uint8 indexed id);
    event SettlementSet(address settlement);
    event GuardianSet(address guardian);

    /// @notice Registry: adapter id => adapter address. Write-once per id;
    ///         replacing an adapter means registering a new id.
    mapping(uint8 => address) public adapters;
    mapping(uint8 => bool) public adapterPaused;

    /// @notice The only allowed caller of swap(). Set once after deployment
    ///         (the settlement contract takes this router as an immutable, so
    ///         the router deploys first).
    address public settlement;
    address public guardian;

    modifier onlySettlement() {
        if (msg.sender != settlement) revert OnlySettlement();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address owner_, address guardian_) Ownable(owner_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
    }

    /// @notice One-time wiring of the settlement contract.
    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert ZeroAddress();
        if (settlement != address(0)) revert SettlementAlreadySet();
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Register a new adapter. Owner-only (timelock in production);
    ///         ids are write-once.
    function addAdapter(uint8 id, address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (adapters[id] != address(0)) revert AdapterAlreadySet();
        adapters[id] = adapter;
        emit AdapterAdded(id, adapter);
    }

    /// @notice Guardian circuit breaker for a single venue (spec 6.2: the
    ///         Blackhole adapter ships behind this in V1.5).
    function pauseAdapter(uint8 id) external onlyGuardian {
        adapterPaused[id] = true;
        emit AdapterPaused(id, msg.sender);
    }

    function unpauseAdapter(uint8 id) external onlyOwner {
        adapterPaused[id] = false;
        emit AdapterUnpaused(id);
    }

    /// @inheritdoc ISeltraAggregationRouter
    function isRegistered(uint8 id) public view returns (bool) {
        return adapters[id] != address(0) && !adapterPaused[id];
    }

    /// @inheritdoc ISeltraAggregationRouter
    function swap(
        uint8 adapterId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata extra
    ) external onlySettlement returns (uint256 amountOut) {
        address adapter = adapters[adapterId];
        if (adapter == address(0)) revert UnknownAdapter();
        if (adapterPaused[adapterId]) revert AdapterPausedError();

        // Fund the adapter for exactly this swap, execute, and forward the
        // realized output to the settlement contract (which re-verifies by
        // balance delta).
        IERC20(tokenIn).safeTransferFrom(msg.sender, adapter, amountIn);
        amountOut = IDEXAdapter(adapter).swap(tokenIn, tokenOut, amountIn, minOut, extra);

        if (amountOut < minOut) revert InsufficientOutput();
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    /// @inheritdoc ISeltraAggregationRouter
    function quote(uint8 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extra)
        external
        returns (uint256 amountOut)
    {
        address adapter = adapters[adapterId];
        if (adapter == address(0)) revert UnknownAdapter();
        return IDEXAdapter(adapter).quote(tokenIn, tokenOut, amountIn, extra);
    }
}
