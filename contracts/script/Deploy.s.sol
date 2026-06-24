// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialToken} from "../src/ConfidentialToken.sol";

/// @notice Deploys ConfidentialToken to whichever chain is selected by `--rpc-url`.
///         Assumes fhEVM host contracts are already deployed at canonical addresses
///         (forge-fhevm deploy-local.sh does this).
contract Deploy is Script {
    function run() external returns (ConfidentialToken token) {
        vm.startBroadcast();
        token = new ConfidentialToken("Confidential USD", "cUSD", "https://example.com/cusd");
        console2.log("ConfidentialToken deployed at:", address(token));
        vm.stopBroadcast();
    }
}
