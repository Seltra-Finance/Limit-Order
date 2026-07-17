// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {Order, OrderLib} from "./libraries/OrderLib.sol";
import {ISeltraAggregationRouter, RouteData} from "./interfaces/ISeltraAggregationRouter.sol";

/// @title SeltraSettlement
/// @notice Immutable, non-upgradeable settlement contract for both Seltra fill
///         paths (revised spec, locked architecture). One user signature per
///         order: a Permit2 SignatureTransfer with the Order struct as the
///         witness (the UniswapX architecture applied to resting limit
///         orders). Permit2 verifies the signature and consumes the unordered
///         nonce; this contract verifies the economics carried in the witness.
///
///         Maker-protective invariant: the maker always receives at least the
///         signed `takingAmount`. Surplus above it is split between the maker
///         (price improvement, `makerSurplusBps`) and the keeper, from whose
///         side an optional capped protocol fee is taken.
///
///         Cancellation is always live, even while fills are paused:
///         single-order cancel is Permit2 `invalidateUnorderedNonces` (called
///         by the maker on Permit2 directly); cancel-all is `incrementEpoch`.
contract SeltraSettlement is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using OrderLib for Order;

    // ---------------------------------------------------------------- errors

    error BadMaker();
    error BadReceiver();
    error OrderExpired();
    error InvalidEpoch();
    error PrivateOrder();
    error BadPermitToken();
    error BadPermitAmount();
    error BadPermitDeadline();
    error BadFlags();
    error InsufficientOutput();
    error AssetMismatch();
    error SizeMismatch();
    error PriceNotCrossed();
    error FillsPausedError();
    error UnknownAdapter();
    error TokenNotAllowed(address token);
    error NotGuardian();
    error BadFeeParams();
    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken(address token);

    // ---------------------------------------------------------------- events

    event OrderFilledDEX(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed keeper,
        uint8 adapterId,
        uint256 makingAmount,
        uint256 amountOut,
        uint256 makerImprovement,
        uint256 keeperReward
    );
    event OrderFilledP2P(
        bytes32 indexed hashA,
        bytes32 indexed hashB,
        uint256 surplus,
        uint256 makerShareA,
        uint256 makerShareB,
        uint256 keeperReward
    );
    event EpochIncremented(address indexed maker, uint256 newEpoch);
    event FillsPaused(address guardian);
    event FillsUnpaused();
    event GuardianSet(address guardian);
    event SurplusParamsSet(uint16 makerSurplusBps, uint16 protocolFeeBps, address treasury);
    event TokenAllowed(address indexed token, bool allowed);

    // ---------------------------------------------------------------- state

    /// @dev Canonical Permit2 singleton (0x000000000022D473030F116dDEE9F6B43aC78BA3).
    ISignatureTransfer public immutable PERMIT2;
    ISeltraAggregationRouter public immutable ROUTER;

    /// @notice Cancel-all epoch; orders sign the epoch they were created under.
    mapping(address => uint256) public currentEpoch;

    /// @notice Guardian pause: blocks fills only. Cancellation (Permit2 nonce
    ///         invalidation, epoch increments) is never pausable.
    bool public fillsPaused;
    address public guardian;

    /// @notice Surplus split parameters (spec 1.4). keeperSurplusBps is
    ///         derived: 10000 - makerSurplusBps.
    uint16 public makerSurplusBps = 7_000;
    uint16 public protocolFeeBps; // taken from the keeper side
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 1_000;
    address public treasury;

    /// @notice V1 token allowlist (spec 1.5); no fee-on-transfer or rebasing
    ///         tokens. Mutations go through the owner (timelock + multisig in
    ///         production).
    mapping(address => bool) public allowedTokens;

    modifier whenFillsNotPaused() {
        if (fillsPaused) revert FillsPausedError();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(ISignatureTransfer permit2_, ISeltraAggregationRouter router_, address owner_, address guardian_)
        Ownable(owner_)
    {
        if (address(permit2_) == address(0) || address(router_) == address(0) || guardian_ == address(0)) {
            revert ZeroAddress();
        }
        PERMIT2 = permit2_;
        ROUTER = router_;
        guardian = guardian_;
    }

    // ----------------------------------------------------------------- views

    /// @notice The order hash passed to Permit2 as the witness. Note this is a
    ///         bare struct hash: domain separation and replay protection live
    ///         in Permit2's PermitWitnessTransferFrom digest around it.
    function hashOrder(Order calldata order) public pure returns (bytes32) {
        return order.hash();
    }

    function keeperSurplusBps() external view returns (uint16) {
        return 10_000 - makerSurplusBps;
    }

    // ------------------------------------------------------------- DEX fill

    /// @notice Fill a resting order against AMM liquidity via the aggregation
    ///         router. RouteData carries no economics: tokenIn, tokenOut,
    ///         amountIn and minOut are all derived from the signed order, so
    ///         no keeper-supplied parameter can alter them (spec 6).
    function fillOrderDEX(
        Order calldata order,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature,
        RouteData calldata route
    ) external nonReentrant whenFillsNotPaused returns (uint256 amountOut) {
        _checkOrder(order, permit);
        if (!ROUTER.isRegistered(route.adapterId)) revert UnknownAdapter();

        bytes32 orderHash = order.hash();
        IERC20 takerAsset = IERC20(order.takerAsset);
        IERC20 makerAsset = IERC20(order.makerAsset);

        uint256 balanceBefore = takerAsset.balanceOf(address(this));

        // Permit2 verifies the witness signature and consumes the unordered
        // nonce (replay protection lives entirely in Permit2).
        _permitWitnessPull(order, permit, signature, orderHash);

        makerAsset.forceApprove(address(ROUTER), order.makingAmount);
        ROUTER.swap(
            route.adapterId, order.makerAsset, order.takerAsset, order.makingAmount, order.takingAmount, route.extra
        );
        makerAsset.forceApprove(address(ROUTER), 0);

        // Balance-delta measurement, not the adapter's return value (spec 5.1).
        amountOut = takerAsset.balanceOf(address(this)) - balanceBefore;

        // Maker-protective invariant.
        if (amountOut < order.takingAmount) revert InsufficientOutput();

        // Surplus split: maker improvement floor-rounds, so dust lands on the
        // keeper side deterministically; the protocol fee floor-rounds off the
        // keeper side.
        uint256 surplus = amountOut - order.takingAmount;
        uint256 makerImprovement = Math.mulDiv(surplus, makerSurplusBps, 10_000);
        uint256 keeperSide = surplus - makerImprovement;
        uint256 protocolFee = Math.mulDiv(keeperSide, protocolFeeBps, 10_000);
        uint256 keeperReward = keeperSide - protocolFee;

        _safeTransferExact(takerAsset, order.receiver, order.takingAmount + makerImprovement);
        _safeTransferExact(takerAsset, msg.sender, keeperReward);
        _safeTransferExact(takerAsset, treasury, protocolFee);

        emit OrderFilledDEX(
            orderHash,
            order.maker,
            msg.sender,
            route.adapterId,
            order.makingAmount,
            amountOut,
            makerImprovement,
            keeperReward
        );
    }

    // ------------------------------------------------------------- P2P fill

    /// @notice Settle two crossing orders peer to peer, zero AMM interaction,
    ///         zero slippage (spec 5.2). V1 is exact-size, opposite-asset,
    ///         all-or-nothing.
    ///
    ///         Base/quote convention (the matching engine must submit orders
    ///         in this position): order `a` sells base token X for quote token
    ///         Y; order `b` sells quote token Y for base token X. The X leg
    ///         matches exactly (`a.makingAmount == b.takingAmount`) and the
    ///         crossed spread appears as surplus in Y:
    ///         `surplusY = b.makingAmount - a.takingAmount`.
    ///
    ///         Because the X leg is exact and amounts are nonzero, price
    ///         crossing reduces exactly to `b.makingAmount >= a.takingAmount`.
    ///         This avoids overflow-prone cross multiplication.
    function fillOrderP2P(
        Order calldata a,
        ISignatureTransfer.PermitTransferFrom calldata permitA,
        bytes calldata sigA,
        Order calldata b,
        ISignatureTransfer.PermitTransferFrom calldata permitB,
        bytes calldata sigB
    ) external nonReentrant whenFillsNotPaused {
        _checkOrder(a, permitA);
        _checkOrder(b, permitB);

        if (a.makerAsset != b.takerAsset || a.takerAsset != b.makerAsset) revert AssetMismatch();
        if (a.makingAmount != b.takingAmount) revert SizeMismatch();
        if (b.makingAmount < a.takingAmount) revert PriceNotCrossed();

        bytes32 hashA = a.hash();
        bytes32 hashB = b.hash();

        // Pull X from A and Y from B; both Permit2 nonces consumed atomically.
        _permitWitnessPull(a, permitA, sigA, hashA);
        _permitWitnessPull(b, permitB, sigB, hashB);

        // X leg is exact: all of A's X goes to B's receiver.
        _safeTransferExact(IERC20(a.makerAsset), b.receiver, a.makingAmount);

        // Y leg: A's signed minimum first, then the surplus split. The maker
        // share is split evenly between both receivers (both makers formed the
        // cross); division dust lands on the keeper side.
        uint256 surplusY = b.makingAmount - a.takingAmount; // nonnegative given the checks above
        uint256 makerShare = Math.mulDiv(surplusY, makerSurplusBps, 10_000);
        uint256 shareA = makerShare / 2;
        uint256 shareB = makerShare - shareA;
        uint256 keeperSide = surplusY - makerShare;
        uint256 protocolFee = Math.mulDiv(keeperSide, protocolFeeBps, 10_000);
        uint256 keeperReward = keeperSide - protocolFee;

        IERC20 quote = IERC20(b.makerAsset);
        _safeTransferExact(quote, a.receiver, a.takingAmount + shareA);
        _safeTransferExact(quote, b.receiver, shareB);
        _safeTransferExact(quote, msg.sender, keeperReward);
        _safeTransferExact(quote, treasury, protocolFee);

        emit OrderFilledP2P(hashA, hashB, surplusY, shareA, shareB, keeperReward);
    }

    // ---------------------------------------------------------- cancellation

    /// @notice Cancel-all for the caller: every outstanding order signed under
    ///         a previous epoch becomes permanently unfillable. Never pausable.
    ///         (Single-order cancel is `PERMIT2.invalidateUnorderedNonces`,
    ///         called by the maker on Permit2 directly.)
    function incrementEpoch() external {
        uint256 newEpoch = ++currentEpoch[msg.sender];
        emit EpochIncremented(msg.sender, newEpoch);
    }

    // -------------------------------------------------------------- guardian

    /// @notice Guardian circuit breaker: blocks fills only. Cancellation and
    ///         epoch paths stay live; nobody can ever be trapped.
    function pauseFills() external onlyGuardian {
        fillsPaused = true;
        emit FillsPaused(msg.sender);
    }

    /// @notice Unpausing requires the owner (timelock + multisig in production).
    function unpauseFills() external onlyOwner {
        fillsPaused = false;
        emit FillsUnpaused();
    }

    // ----------------------------------------------------------------- admin

    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Surplus split and protocol fee parameters; owner-only, which is
    ///         the timelock in production. The protocol fee is capped and only
    ///         ever comes from the keeper side of the surplus.
    function setSurplusParams(uint16 makerSurplusBps_, uint16 protocolFeeBps_, address treasury_) external onlyOwner {
        if (makerSurplusBps_ > 10_000 || protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert BadFeeParams();
        if (protocolFeeBps_ > 0 && treasury_ == address(0)) revert ZeroAddress();
        makerSurplusBps = makerSurplusBps_;
        protocolFeeBps = protocolFeeBps_;
        treasury = treasury_;
        emit SurplusParamsSet(makerSurplusBps_, protocolFeeBps_, treasury_);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    // ------------------------------------------------------------- internals

    /// @dev Mandatory per-order checks, both paths (spec 1.4), plus the V1
    ///      token allowlist (spec 1.5). Signature validity and replay are
    ///      Permit2's job and are enforced during the witness pull.
    function _checkOrder(Order calldata order, ISignatureTransfer.PermitTransferFrom calldata permit) internal view {
        if (order.maker == address(0)) revert BadMaker();
        if (order.receiver == address(0)) revert BadReceiver();
        if (order.makingAmount == 0 || order.takingAmount == 0) revert ZeroAmount();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (order.epoch != currentEpoch[order.maker]) revert InvalidEpoch();
        if (order.allowedSender != address(0) && order.allowedSender != msg.sender) revert PrivateOrder();
        if (order.flags != 0) revert BadFlags();
        if (permit.permitted.token != order.makerAsset) revert BadPermitToken();
        if (permit.permitted.amount != order.makingAmount) revert BadPermitAmount();
        if (permit.deadline != order.expiry) revert BadPermitDeadline();
        if (!allowedTokens[order.makerAsset]) revert TokenNotAllowed(order.makerAsset);
        if (!allowedTokens[order.takerAsset]) revert TokenNotAllowed(order.takerAsset);
    }

    function _permitWitnessPull(
        Order calldata order,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature,
        bytes32 orderHash
    ) internal {
        PERMIT2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: order.makingAmount}),
            order.maker,
            orderHash,
            OrderLib.WITNESS_TYPE_STRING,
            signature
        );
    }

    /// @dev V1 supports only tokens whose transfers deliver the exact amount
    ///      to the recipient. This enforces the allowlist policy at runtime,
    ///      so transfer fees or balance anomalies cannot be hidden by surplus.
    function _safeTransferExact(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 balanceBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        uint256 balanceAfter = token.balanceOf(to);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert UnsupportedToken(address(token));
        }
    }
}
