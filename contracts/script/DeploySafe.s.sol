// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface ISafeProxyFactory {
    function createChainSpecificProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @notice Deploys a production-shaped 1-of-1 Safe for Fuji governance.
/// @dev Addresses are Safe v1.4.1 canonical deployments for chain 43113 from
///      safe-global/safe-deployments. The chain-specific factory method keeps
///      the counterfactual address distinct across chains.
contract DeploySafe is Script {
    address constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address safeOwner = vm.envOr("SAFE_OWNER", deployer);
        uint256 saltNonce = vm.envOr("SAFE_SALT_NONCE", uint256(keccak256("seltra.fuji.governance.safe.v1")));

        require(block.chainid == 43_113, "Fuji only");
        require(SAFE_L2_SINGLETON.code.length > 0, "Safe singleton missing");
        require(SAFE_PROXY_FACTORY.code.length > 0, "Safe proxy factory missing");
        require(FALLBACK_HANDLER.code.length > 0, "Safe fallback handler missing");

        address[] memory owners = new address[](1);
        owners[0] = safeOwner;
        bytes memory initializer = abi.encodeCall(
            ISafeSetup.setup, (owners, 1, address(0), bytes(""), FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );

        vm.startBroadcast(pk);
        address safe = ISafeProxyFactory(SAFE_PROXY_FACTORY)
            .createChainSpecificProxyWithNonce(SAFE_L2_SINGLETON, initializer, saltNonce);
        vm.stopBroadcast();

        address[] memory installedOwners = ISafeSetup(safe).getOwners();
        require(installedOwners.length == 1 && installedOwners[0] == safeOwner, "unexpected Safe owner");
        require(ISafeSetup(safe).getThreshold() == 1, "unexpected Safe threshold");

        string memory json = "seltra-safe";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "safe", safe);
        vm.serializeAddress(json, "owner", safeOwner);
        vm.serializeUint(json, "threshold", 1);
        vm.serializeAddress(json, "singleton", SAFE_L2_SINGLETON);
        vm.serializeAddress(json, "proxyFactory", SAFE_PROXY_FACTORY);
        vm.serializeAddress(json, "fallbackHandler", FALLBACK_HANDLER);
        string memory out = vm.serializeUint(json, "saltNonce", saltNonce);
        vm.writeJson(out, "./safe.fuji.json");

        console.log("Safe:", safe);
        console.log("owner:", safeOwner);
        console.log("threshold: 1");
    }
}
