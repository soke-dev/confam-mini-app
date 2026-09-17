// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @notice A stand-in for USDT on Polygon, with a real EIP-2612 permit and no
 *         EIP-3009 at all.
 *
 * @dev Copied from the live contract rather than from the spec, because the
 *      live contract differs from the spec in the one way that matters.
 *
 *      Its EIP-712 domain uses `salt` where almost every other token uses
 *      `chainId`:
 *
 *          EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)
 *
 *      This was verified against 0xc2132D05...B58e8F on Polygon mainnet by
 *      rebuilding both candidate domains and comparing each to the value the
 *      contract returns from DOMAIN_SEPARATOR(). The salt form matched, with
 *      name "USDT0" and version "1"; the standard form did not.
 *
 *      That is why the mock reproduces it. A mock using the ordinary domain
 *      would accept the signatures our client produces and pass every test,
 *      while the real token rejected every one of them in production — the
 *      exact failure this mock exists to catch.
 *
 *      Deliberately absent: receiveWithAuthorization. If anything reaches for
 *      EIP-3009 on this token the call should fail in a test rather than on
 *      mainnet.
 */
contract MockUSDT is ERC20 {
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @dev The Polygon variant. Note `salt`, and note that `chainId` is absent.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");

    mapping(address => uint256) public nonces;

    error PermitExpired();
    error InvalidPermit();

    constructor() ERC20("USDT0", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("USDT0")),
                keccak256(bytes("1")),
                address(this),
                bytes32(block.chainid)
            )
        );
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();

        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR(), structHash);

        address signer = ECDSA.recover(digest, v, r, s);
        if (signer != owner || signer == address(0)) revert InvalidPermit();

        _approve(owner, spender, value);
    }
}
