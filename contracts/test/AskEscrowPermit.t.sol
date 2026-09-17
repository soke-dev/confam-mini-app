// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AskEscrow} from "../src/AskEscrow.sol";
import {MockUSDT} from "./MockUSDT.sol";

/**
 * @notice The permit funding path, against a token shaped like USDT on Polygon.
 *
 * @dev Separate from AskEscrow.t.sol because it is a different token with a
 *      different signature scheme, not a variation on the same one. The suite
 *      there proves the EIP-3009 path on a USDC-shaped token; this proves the
 *      EIP-2612 path on a USDT-shaped one, including the Polygon domain that
 *      uses `salt` instead of `chainId`.
 *
 *      What these tests are really for is the two ways this path can be wrong
 *      while looking right: a signature built against the wrong domain, which
 *      fails only on mainnet, and a permit front-run by a stranger, which
 *      fails only occasionally and only in production.
 */
contract AskEscrowPermitTest is Test {
    AskEscrow escrow;
    MockUSDT usdt;

    uint256 askerKey = 0xA11CE;
    uint256 verifierKey = 0xB0B;
    uint256 strangerKey = 0xBAD;

    address asker;
    address verifier;
    address stranger;
    address arbiter = address(0xA);
    address treasury = address(0x7);
    address relayer = address(0xDEAD); // pays gas, decides nothing

    uint128 constant BOUNTY = 500e6;
    uint16 constant FEE_BPS = 1_000; // 10%

    function setUp() public {
        asker = vm.addr(askerKey);
        verifier = vm.addr(verifierKey);
        stranger = vm.addr(strangerKey);

        usdt = new MockUSDT();

        AskEscrow implementation = new AskEscrow();
        bytes memory init =
            abi.encodeCall(AskEscrow.initialize, (address(usdt), arbiter, treasury, FEE_BPS));
        escrow = AskEscrow(address(new ERC1967Proxy(address(implementation), init)));

        usdt.mint(asker, 10_000e6);
        usdt.mint(stranger, 10_000e6);
        vm.warp(1_700_000_000);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /// @dev Signs a permit the way the client must: salt domain, current nonce.
    function _permitSig(uint256 key, address owner, uint256 value, uint256 permitDeadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                address(escrow),
                value,
                usdt.nonces(owner),
                permitDeadline
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(usdt.DOMAIN_SEPARATOR(), structHash);
        (v, r, s) = vm.sign(key, digest);
    }

    /// @dev The escrow's own EIP-712 domain, which is the ordinary one.
    function _escrowDomain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("AskEscrow"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
    }

    function _claimSig(uint256 key, bytes32 jobId, address who, bytes32 evidence)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Claim(bytes32 jobId,address verifier,bytes32 evidenceHash)"),
                jobId,
                who,
                evidence
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, MessageHashUtils.toTypedDataHash(_escrowDomain(), structHash));
        return abi.encodePacked(r, s, v);
    }

    function _releaseSig(uint256 key, bytes32 jobId, address who)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Release(bytes32 jobId,address verifier)"), jobId, who)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, MessageHashUtils.toTypedDataHash(_escrowDomain(), structHash));
        return abi.encodePacked(r, s, v);
    }

    function _fund(bytes32 jobId) internal returns (uint64 deadline) {
        deadline = uint64(block.timestamp + 1 days);
        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(askerKey, asker, BOUNTY, permitDeadline);

        vm.prank(relayer);
        escrow.fundWithPermit(jobId, asker, BOUNTY, deadline, permitDeadline, v, r, s);
    }

    // ─── The path itself ────────────────────────────────────────────────────

    function test_fundWithPermit_movesTheMoneyAndRecordsTheJob() public {
        uint256 before = usdt.balanceOf(asker);
        bytes32 jobId = keccak256("job-1");

        _fund(jobId);

        assertEq(usdt.balanceOf(address(escrow)), BOUNTY, "escrow holds the bounty");
        assertEq(usdt.balanceOf(asker), before - BOUNTY, "asker paid exactly once");

        (address jobAsker,, uint128 amount,, AskEscrow.Status status,) = escrow.jobs(jobId);
        assertEq(jobAsker, asker);
        assertEq(amount, BOUNTY);
        assertEq(uint8(status), uint8(AskEscrow.Status.Funded));
    }

    function test_fundWithPermit_paysNoGasFromTheAsker() public {
        // The relayer sends it. The asker only ever signed.
        bytes32 jobId = keccak256("job-gasless");
        _fund(jobId);
        assertEq(usdt.balanceOf(address(escrow)), BOUNTY);
    }

    /**
     * The front-running case, which is the reason for the allowance check.
     *
     * A permit signature is public once relayed and anybody may submit it
     * first. It grants nothing to them — the spender is fixed at the escrow —
     * but it consumes the nonce, so our own permit call would revert on a
     * signature the asker produced perfectly correctly.
     */
    function test_fundWithPermit_survivesSomebodyElseSubmittingThePermit() public {
        bytes32 jobId = keccak256("job-frontrun");
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(askerKey, asker, BOUNTY, permitDeadline);

        // A stranger relays the permit first, consuming the nonce.
        vm.prank(stranger);
        usdt.permit(asker, address(escrow), BOUNTY, permitDeadline, v, r, s);
        assertEq(usdt.allowance(asker, address(escrow)), BOUNTY, "allowance is already in place");

        // The same signature is now spent, and funding must still work.
        vm.prank(relayer);
        escrow.fundWithPermit(jobId, asker, BOUNTY, deadline, permitDeadline, v, r, s);

        assertEq(usdt.balanceOf(address(escrow)), BOUNTY, "job funded anyway");
    }

    function test_fundWithPermit_rejectsAnExpiredPermit() public {
        bytes32 jobId = keccak256("job-expired");
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 permitDeadline = block.timestamp - 1; // already past
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(askerKey, asker, BOUNTY, permitDeadline);

        vm.prank(relayer);
        vm.expectRevert(MockUSDT.PermitExpired.selector);
        escrow.fundWithPermit(jobId, asker, BOUNTY, deadline, permitDeadline, v, r, s);
    }

    function test_fundWithPermit_rejectsSomebodyElsesSignature() public {
        bytes32 jobId = keccak256("job-forged");
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 permitDeadline = block.timestamp + 1 hours;

        // The stranger signs, but the job names the asker as the payer.
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(strangerKey, asker, BOUNTY, permitDeadline);

        vm.prank(relayer);
        vm.expectRevert(MockUSDT.InvalidPermit.selector);
        escrow.fundWithPermit(jobId, asker, BOUNTY, deadline, permitDeadline, v, r, s);
    }

    function test_fundWithPermit_refusesTwoJobsWithOneId() public {
        bytes32 jobId = keccak256("job-dup");
        _fund(jobId);

        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(askerKey, asker, BOUNTY, permitDeadline);

        vm.prank(relayer);
        vm.expectRevert(AskEscrow.JobExists.selector);
        escrow.fundWithPermit(jobId, asker, BOUNTY, deadline, permitDeadline, v, r, s);
    }

    function test_fundWithPermit_refusesADeadlineAlreadyPast() public {
        bytes32 jobId = keccak256("job-past");
        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(askerKey, asker, BOUNTY, permitDeadline);

        vm.prank(relayer);
        vm.expectRevert(AskEscrow.DeadlineInPast.selector);
        escrow.fundWithPermit(
            jobId, asker, BOUNTY, uint64(block.timestamp - 1), permitDeadline, v, r, s
        );
    }

    // ─── The rest of the life cycle still works on this token ───────────────

    function test_aPermitFundedJobReleasesToTheVerifier() public {
        bytes32 jobId = keccak256("job-release");
        _fund(jobId);

        bytes32 evidenceHash = keccak256("a photograph");

        vm.prank(relayer);
        escrow.claim(jobId, verifier, evidenceHash, _claimSig(verifierKey, jobId, verifier, evidenceHash));

        vm.prank(relayer);
        escrow.release(jobId, _releaseSig(askerKey, jobId, verifier));

        uint256 fee = (uint256(BOUNTY) * FEE_BPS) / 10_000;
        assertEq(usdt.balanceOf(verifier), BOUNTY - fee, "verifier paid, less the fee");
        assertEq(usdt.balanceOf(treasury), fee, "treasury took its share");
        assertEq(usdt.balanceOf(address(escrow)), 0, "nothing left behind");
    }

    function test_tipWithPermit_splitsAndKeepsNothing() public {
        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(askerKey, asker, BOUNTY, permitDeadline);

        vm.prank(relayer);
        escrow.tipWithPermit(asker, verifier, BOUNTY, permitDeadline, v, r, s);

        uint256 fee = (uint256(BOUNTY) * FEE_BPS) / 10_000;
        assertEq(usdt.balanceOf(verifier), BOUNTY - fee);
        assertEq(usdt.balanceOf(treasury), fee);
        assertEq(usdt.balanceOf(address(escrow)), 0, "the contract never holds a tip");
    }

    /**
     * The domain really is the Polygon one.
     *
     * Signing against the ordinary EIP-712 domain is the mistake this whole
     * path invites, and it produces a signature that is valid in every respect
     * except the one that counts. Here it must be rejected, so that a client
     * built the obvious way fails in this suite rather than on mainnet.
     */
    function test_aStandardDomainSignatureIsRejected() public {
        bytes32 jobId = keccak256("job-wrong-domain");
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 permitDeadline = block.timestamp + 1 hours;

        bytes32 wrongDomain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("USDT0")),
                keccak256(bytes("1")),
                block.chainid,
                address(usdt)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                asker,
                address(escrow),
                uint256(BOUNTY),
                usdt.nonces(asker),
                permitDeadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(askerKey, MessageHashUtils.toTypedDataHash(wrongDomain, structHash));

        vm.prank(relayer);
        vm.expectRevert(MockUSDT.InvalidPermit.selector);
        escrow.fundWithPermit(jobId, asker, BOUNTY, deadline, permitDeadline, v, r, s);
    }
}
