// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IDEXAdapter} from "./interfaces/IDEXAdapter.sol";

/// @title SeltraArbExecutor
/// @notice Treasury-funded, atomic two-venue arbitrage executor. It is
///         deliberately separate from SeltraSettlement: arbitrage activity
///         neither consumes signed Seltra orders nor counts as Seltra volume.
///
///         Venue adapters are write-once and receive only the exact input for
///         one leg. The executor never accepts a raw target or arbitrary call,
///         and the round trip reverts unless the starting token balance grows
///         by at least `minProfit`.
contract SeltraArbExecutor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Leg {
        uint8 adapterId;
        uint256 minAmountOut;
        bytes extra;
    }

    error AdapterAlreadySet();
    error AdapterNotContract();
    error AdapterPausedError();
    error DeadlineExpired(uint256 deadline);
    error ExecutionsPausedError();
    error InsufficientCapital();
    error InsufficientLegOutput();
    error InsufficientProfit(uint256 realized, uint256 required);
    error NotGuardian();
    error NotOperator();
    error SameAdapter();
    error SameToken();
    error TokenNotAllowed(address token);
    error UnknownAdapter();
    error UnsupportedToken(address token);
    error ZeroAddress();
    error ZeroAmount();

    event AdapterAdded(uint8 indexed id, address adapter);
    event AdapterPaused(uint8 indexed id, address guardian);
    event AdapterUnpaused(uint8 indexed id);
    event ArbitrageExecuted(
        address indexed operator,
        address indexed tokenIn,
        address indexed tokenMid,
        uint8 firstAdapterId,
        uint8 secondAdapterId,
        uint256 amountIn,
        uint256 amountMid,
        uint256 amountOut,
        uint256 profit
    );
    event ExecutionsPaused(address guardian);
    event ExecutionsUnpaused();
    event GuardianSet(address guardian);
    event OperatorSet(address operator);
    event TokenAllowed(address indexed token, bool allowed);
    event TreasurySet(address treasury);

    mapping(uint8 => address) public adapters;
    mapping(uint8 => bool) public adapterPaused;
    mapping(address => bool) public allowedTokens;

    address public operator;
    address public guardian;
    address public treasury;
    bool public executionsPaused;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address owner_, address guardian_, address operator_, address treasury_) Ownable(owner_) {
        if (guardian_ == address(0) || operator_ == address(0) || treasury_ == address(0) || treasury_ == address(this))
        {
            revert ZeroAddress();
        }
        guardian = guardian_;
        operator = operator_;
        treasury = treasury_;
    }

    function addAdapter(uint8 id, address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (adapters[id] != address(0)) revert AdapterAlreadySet();
        if (adapter.code.length == 0) revert AdapterNotContract();
        adapters[id] = adapter;
        emit AdapterAdded(id, adapter);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0) || treasury_ == address(this)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function pauseExecutions() external onlyGuardian {
        executionsPaused = true;
        emit ExecutionsPaused(msg.sender);
    }

    function unpauseExecutions() external onlyOwner {
        executionsPaused = false;
        emit ExecutionsUnpaused();
    }

    function pauseAdapter(uint8 id) external onlyGuardian {
        if (adapters[id] == address(0)) revert UnknownAdapter();
        adapterPaused[id] = true;
        emit AdapterPaused(id, msg.sender);
    }

    function unpauseAdapter(uint8 id) external onlyOwner {
        if (adapters[id] == address(0)) revert UnknownAdapter();
        adapterPaused[id] = false;
        emit AdapterUnpaused(id);
    }

    /// @notice Executes tokenIn -> tokenMid -> tokenIn atomically and pays
    ///         only the realized profit to the treasury. Principal remains in
    ///         this contract for subsequent opportunities.
    function executeTwoLeg(
        address tokenIn,
        address tokenMid,
        uint256 amountIn,
        uint256 minProfit,
        uint256 deadline,
        Leg calldata first,
        Leg calldata second
    ) external onlyOperator nonReentrant returns (uint256 profit) {
        if (executionsPaused) revert ExecutionsPausedError();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);
        if (tokenIn == address(0) || tokenMid == address(0)) revert ZeroAddress();
        if (tokenIn == tokenMid) revert SameToken();
        if (amountIn == 0 || minProfit == 0) revert ZeroAmount();
        if (!allowedTokens[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (!allowedTokens[tokenMid]) revert TokenNotAllowed(tokenMid);
        if (first.adapterId == second.adapterId) revert SameAdapter();

        address firstAdapter = _activeAdapter(first.adapterId);
        address secondAdapter = _activeAdapter(second.adapterId);
        IERC20 startToken = IERC20(tokenIn);
        IERC20 midToken = IERC20(tokenMid);

        uint256 startBalance = startToken.balanceOf(address(this));
        if (startBalance < amountIn) revert InsufficientCapital();
        uint256 midBalanceBefore = midToken.balanceOf(address(this));

        startToken.safeTransfer(firstAdapter, amountIn);
        IDEXAdapter(firstAdapter).swap(tokenIn, tokenMid, amountIn, first.minAmountOut, first.extra);

        uint256 midBalanceAfter = midToken.balanceOf(address(this));
        if (midBalanceAfter < midBalanceBefore) revert InsufficientLegOutput();
        uint256 amountMid = midBalanceAfter - midBalanceBefore;
        if (amountMid < first.minAmountOut) revert InsufficientLegOutput();

        midToken.safeTransfer(secondAdapter, amountMid);
        IDEXAdapter(secondAdapter).swap(tokenMid, tokenIn, amountMid, second.minAmountOut, second.extra);

        uint256 finalBalance = startToken.balanceOf(address(this));
        uint256 requiredBalance = startBalance + minProfit;
        if (finalBalance < requiredBalance) {
            uint256 realized = finalBalance > startBalance ? finalBalance - startBalance : 0;
            revert InsufficientProfit(realized, minProfit);
        }

        profit = finalBalance - startBalance;
        uint256 amountOut = amountIn + profit;
        _safeTransferExact(startToken, treasury, profit);

        emit ArbitrageExecuted(
            msg.sender, tokenIn, tokenMid, first.adapterId, second.adapterId, amountIn, amountMid, amountOut, profit
        );
    }

    /// @notice Treasury recovery is owner-only (timelock/Safe in production).
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _safeTransferExact(IERC20(token), to, amount);
    }

    function _activeAdapter(uint8 id) internal view returns (address adapter) {
        adapter = adapters[id];
        if (adapter == address(0)) revert UnknownAdapter();
        if (adapterPaused[id]) revert AdapterPausedError();
    }

    function _safeTransferExact(IERC20 token, address to, uint256 amount) internal {
        uint256 balanceBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        uint256 balanceAfter = token.balanceOf(to);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert UnsupportedToken(address(token));
        }
    }
}
