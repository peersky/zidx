// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {FHE, externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialToken
/// @dev Inherits from OpenZeppelin ERC7984 and exposes a public mint() taking an
///      externally-encrypted euint64 with its input proof. ZamaEthereumConfig wires
///      the canonical fhEVM host contract addresses (FHEVMExecutor, ACL, etc.).
contract ConfidentialToken is ERC7984, ZamaEthereumConfig {
    constructor(string memory name_, string memory symbol_, string memory uri_)
        ERC7984(name_, symbol_, uri_)
    {}

    /// @notice Mint encrypted tokens to `to`. Caller supplies a ciphertext + proof
    ///         produced off-chain via the Zama SDK's input encryption flow.
    /// @param to Recipient.
    /// @param encryptedAmount Externally-encrypted amount handle.
    /// @param inputProof EIP-712 proof binding (encryptedAmount, caller) to the input.
    /// @return amount The internal handle for the freshly-minted amount.
    function mint(address to, externalEuint64 encryptedAmount, bytes calldata inputProof)
        external
        returns (euint64 amount)
    {
        amount = FHE.fromExternal(encryptedAmount, inputProof);
        _mint(to, amount);
    }
}
