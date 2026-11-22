// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";

/// Deploys the registry with the broadcasting account (`--account <keystore>`). The registry has no
/// owner or constructor arguments, so the deployer gains no privileges.
contract DeployStrategyRegistry is Script {
    function run() external returns (StrategyRegistry registry) {
        vm.startBroadcast();
        registry = new StrategyRegistry();
        vm.stopBroadcast();
        console.log("StrategyRegistry", address(registry), "chain", block.chainid);
    }
}
