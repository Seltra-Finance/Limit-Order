// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";

interface ISafeAction {
    function nonce() external view returns (uint256);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 safeNonce
    ) external view returns (bytes32);

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool success);
}

/// @notice Executes one call through a 1-of-1 Safe using its EOA owner key.
/// Env: PRIVATE_KEY, SAFE, TARGET, CALLDATA; optional VALUE and OPERATION.
contract SafeAction is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        ISafeAction safe = ISafeAction(vm.envAddress("SAFE"));
        address target = vm.envAddress("TARGET");
        bytes memory data = vm.envBytes("CALLDATA");
        uint256 value = vm.envOr("VALUE", uint256(0));
        uint8 operation = uint8(vm.envOr("OPERATION", uint256(0)));
        uint256 safeNonce = safe.nonce();

        bytes32 txHash =
            safe.getTransactionHash(target, value, data, operation, 0, 0, 0, address(0), address(0), safeNonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, txHash);
        bytes memory signatures = abi.encodePacked(r, s, v);

        vm.startBroadcast(pk);
        bool success =
            safe.execTransaction(target, value, data, operation, 0, 0, 0, address(0), payable(address(0)), signatures);
        vm.stopBroadcast();
        require(success, "Safe transaction failed");

        console.log("Safe nonce executed:", safeNonce);
        console.log("target:", target);
        console.logBytes32(txHash);
    }
}
