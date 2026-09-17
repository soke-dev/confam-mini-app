// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AskEscrow} from "../src/AskEscrow.sol";

/**
 * @notice Deploys the implementation and its proxy, then checks the result.
 *
 * @dev Two contracts go out: the implementation, which holds the code and no
 *      money, and the proxy, which holds the money and delegates to it. The
 *      proxy address is the one that matters — it is what the app talks to and
 *      what survives every upgrade.
 *
 *      Run against a fork first. `forge script` simulates before broadcasting,
 *      so a failing assertion here costs nothing, whereas a wrong arbiter or
 *      treasury on a live deploy costs a redeploy and a migration.
 */
contract Deploy is Script {
    /// Circle's USDC on Base mainnet.
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", USDC_BASE);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(1_000)));

        require(owner != address(0), "OWNER_ADDRESS unset");
        require(arbiter != address(0), "ARBITER_ADDRESS unset");
        require(treasury != address(0), "TREASURY_ADDRESS unset");

        /**
         * The one deployment mistake that cannot be fixed by an upgrade.
         *
         * If the owner and the arbiter are the same key, then whoever holds it
         * can both rule on disputes and replace the contract's rules — and
         * since the arbiter key lives on a server to sign resolutions, a
         * server compromise becomes total. Two powers, two keys.
         */
        require(owner != arbiter, "owner and arbiter must be different keys");

        /**
         * Can this token actually be funded?
         *
         * The escrow accepts money two ways and no token has both: USDC has
         * EIP-3009, USDT on Polygon has EIP-2612 permit. Deploying against a
         * token with neither produces a contract that looks perfectly healthy,
         * accepts an owner, an arbiter and a treasury, and cannot take a single
         * payment — a fact nobody discovers until the first person tries to ask
         * a question.
         *
         * Probed rather than assumed, because the address is an environment
         * variable and the whole point of a deploy script is that the thing it
         * puts on a chain forever was checked first.
         */
        (bool has3009,) = usdc.staticcall(
            abi.encodeWithSignature("authorizationState(address,bytes32)", address(1), bytes32(0))
        );
        (bool hasPermit,) =
            usdc.staticcall(abi.encodeWithSignature("nonces(address)", address(1)));

        require(has3009 || hasPermit, "token supports neither EIP-3009 nor EIP-2612");

        console2.log("token funding paths available:");
        console2.log("  EIP-3009 (fund)           :", has3009);
        console2.log("  EIP-2612 (fundWithPermit) :", hasPermit);

        /**
         * Accepts a key with or without the 0x prefix.
         *
         * Exporters disagree: some emit 64 bare hex characters, others prefix
         * them. Both describe the same key, and refusing one of them fails a
         * deployment for the sake of two characters.
         */
        string memory rawKey = vm.envString("DEPLOYER_PRIVATE_KEY");
        uint256 deployerKey = vm.parseUint(
            bytes(rawKey).length == 64 ? string.concat("0x", rawKey) : rawKey
        );
        vm.startBroadcast(deployerKey);

        AskEscrow implementation = new AskEscrow();

        bytes memory init =
            abi.encodeCall(AskEscrow.initialize, (usdc, arbiter, treasury, feeBps));
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), init);

        AskEscrow escrow = AskEscrow(address(proxy));

        // Ownership starts with the deployer, because initialize() runs as the
        // deployer. Handing it over is part of the deployment, not a follow-up
        // somebody might forget.
        if (owner != vm.addr(deployerKey)) {
            escrow.transferOwnership(owner);
        }

        vm.stopBroadcast();

        // Read it back rather than trusting the writes.
        require(address(escrow.usdc()) == usdc, "usdc mismatch");
        require(escrow.arbiter() == arbiter, "arbiter mismatch");
        require(escrow.treasury() == treasury, "treasury mismatch");
        require(escrow.feeBps() == feeBps, "fee mismatch");
        require(escrow.owner() == owner, "ownership was not transferred");

        console2.log("");
        console2.log("=== AskEscrow deployed ===");
        console2.log("proxy (use this one) :", address(proxy));
        console2.log("implementation       :", address(implementation));
        console2.log("usdc                 :", usdc);
        console2.log("owner  (upgrades)    :", owner);
        console2.log("arbiter (disputes)   :", arbiter);
        console2.log("treasury (fees)      :", treasury);
        console2.log("fee bps              :", feeBps);
        console2.log("");
        console2.log("Put the proxy address in api/.env as ESCROW_ADDRESS.");
    }
}
