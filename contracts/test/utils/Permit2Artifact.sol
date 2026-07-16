// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Standalone compilation unit so the vendored Permit2 (pinned to solc 0.8.17)
// is built and its artifact is available to 0.8.24 tests via deployCode().
import {Permit2} from "permit2/src/Permit2.sol";
