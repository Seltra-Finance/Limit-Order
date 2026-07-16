// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice A Seltra limit order (revised spec 1.2). Signed exclusively as a
///         Permit2 witness inside a PermitWitnessTransferFrom signature; there
///         is no Seltra EIP-712 domain and no Seltra nonce field. Replay
///         protection is Permit2's unordered nonce; cancel-all is the signed
///         `epoch` field checked against `currentEpoch[maker]`.
struct Order {
    address maker; //         signer, funds source
    address receiver; //      proceeds destination, must be nonzero
    address makerAsset; //    token maker sells
    address takerAsset; //    token maker buys
    uint256 makingAmount; //  amount maker sells
    uint256 takingAmount; //  min amount maker accepts (limit)
    uint256 salt; //          uniqueness / offchain bookkeeping
    uint256 epoch; //         must equal currentEpoch[maker] at fill
    uint40 expiry; //         unix seconds
    address allowedSender; // 0 = any keeper, else restricted
    uint8 flags; //           reserved (partial fills etc.), must be 0 in V1
}

library OrderLib {
    /// @dev Typehash of the Order struct type string. Field order must match
    ///      the struct exactly.
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags)"
    );

    /// @dev Witness type string per the Permit2 SignatureTransfer rules: it is
    ///      appended to the PermitWitnessTransferFrom stub
    ///      ("...uint256 nonce,uint256 deadline,"), so it starts with the
    ///      witness declaration, closes the parent type, then lists referenced
    ///      subtypes in alphabetical order (Order before TokenPermissions).
    string internal constant WITNESS_TYPE_STRING =
        "Order witness)Order(address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags)TokenPermissions(address token,uint256 amount)";

    /// @notice The order hash passed to Permit2 as the witness.
    function hash(Order calldata order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.maker,
                order.receiver,
                order.makerAsset,
                order.takerAsset,
                order.makingAmount,
                order.takingAmount,
                order.salt,
                order.epoch,
                order.expiry,
                order.allowedSender,
                order.flags
            )
        );
    }
}
