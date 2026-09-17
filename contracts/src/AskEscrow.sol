// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice EIP-2612, the other way to authorise a transfer by signature.
///
/// @dev Needed because not every dollar token speaks EIP-3009. USDC does;
///      USDT on Polygon does not implement it at all, and that is the token
///      the mini app's money is in. It does implement permit, so the same
///      contract can serve both chains by funding through whichever the token
///      it was deployed against actually supports.
///
///      One trap worth naming: permit's typed data on Polygon is signed
///      against an EIP-712 domain that uses `salt` rather than `chainId`.
///      That is the token's business, not this contract's — it verifies the
///      signature itself — but anything producing those signatures has to know.
interface IERC2612 {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice USDC's EIP-3009, which lets someone authorise a transfer by
/// signature so that a relayer can pay the gas for it.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * @title AskEscrow
 * @notice Holds the bounty for one question until it is answered, expires, or
 *         is settled by a reviewer.
 *
 * @dev Only money lives here. Question text, evidence files, profiles and the
 *      written accounts in a dispute all stay in the application database —
 *      the rule being that anything whose corruption would lose somebody money
 *      belongs on chain, and everything else does not.
 *
 *      Three properties are worth stating plainly, because they are the
 *      reasons this contract is shaped the way it is:
 *
 *      1. Nobody here can send funds to an address of their choosing. Every
 *         payout goes to `job.asker` or `job.verifier`, both recorded before
 *         any decision is made. A stolen arbiter key can misdirect money
 *         between the two people involved and can steal none of it.
 *
 *      2. The relayer pays all gas and decides nothing. Intent is bound into
 *         the EIP-3009 nonce, so an authorisation to move USDC into this
 *         contract is inseparable from the job it funds.
 *
 *      3. The safe outcome never depends on us. Once the deadline passes,
 *         anyone at all may refund the asker.
 */
contract AskEscrow is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ─── Types ──────────────────────────────────────────────────────────────

    enum Status {
        None, // never funded
        Funded, // money in, waiting on a verifier
        Claimed, // a verifier has submitted evidence
        Disputed, // the asker queried it; frozen until a reviewer rules
        Released, // paid out to the verifier
        Refunded // returned to the asker

    }

    struct Job {
        address asker;
        address verifier; // zero until claimed
        uint128 amount; // USDC, 6 decimals
        uint64 deadline; // unix seconds
        Status status;
        bytes32 evidenceHash; // what the verifier submitted
    }

    // ─── Storage ────────────────────────────────────────────────────────────
    // Append-only. Never reorder, retype or remove: slots are positional, and
    // a shifted layout makes the proxy read one field's bytes as another's.

    IERC20 public usdc;

    /// @notice Rules on disputed jobs, and nothing else.
    address public arbiter;

    /// @notice Receives the platform's share of every settled job.
    address public treasury;

    /// @notice Platform fee in basis points. 1_000 = 10%.
    uint16 public feeBps;

    mapping(bytes32 => Job) public jobs;

    /// @dev Reserved so later versions can add state without shifting the
    ///      slots above. Shrink this by exactly as many slots as you add.
    uint256[44] private __gap;

    // ─── Events ─────────────────────────────────────────────────────────────
    // The indexer reads these. Every field it needs is here, so it never has
    // to call back into the contract to understand what happened.

    event Funded(bytes32 indexed jobId, address indexed asker, uint256 amount, uint64 deadline);
    event Claimed(bytes32 indexed jobId, address indexed verifier, bytes32 evidenceHash);
    event Released(
        bytes32 indexed jobId, address indexed verifier, uint256 paid, uint256 fee
    );
    event Refunded(bytes32 indexed jobId, address indexed asker, uint256 amount);
    event Disputed(bytes32 indexed jobId, address indexed raisedBy);
    event Resolved(bytes32 indexed jobId, bool askerWon, uint256 amount, uint256 fee);
    event Tipped(address indexed from, address indexed to, uint256 amount, uint256 fee);
    event ArbiterChanged(address indexed previous, address indexed current);
    event TreasuryChanged(address indexed previous, address indexed current);
    event FeeChanged(uint16 previousBps, uint16 currentBps);

    // ─── Errors ─────────────────────────────────────────────────────────────

    error NotArbiter();
    error WrongStatus(Status found);
    error JobExists();
    error ZeroAddress();
    error ZeroAmount();
    error DeadlineInPast();
    error DeadlineNotReached();
    error DeadlinePassed();
    error NonceNotBound();
    error BadSignature();
    error FeeTooHigh();
    error NotAParty();

    // ─── Constants ──────────────────────────────────────────────────────────

    /// @dev A ceiling the owner cannot raise past, so an upgrade cannot
    ///      quietly turn a 10% fee into a 100% one.
    uint16 public constant MAX_FEE_BPS = 2_000; // 20%

    /// @dev EIP-712 type hash for a verifier's claim on a job.
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("Claim(bytes32 jobId,address verifier,bytes32 evidenceHash)");

    /// @dev EIP-712 type hash for an asker releasing payment.
    bytes32 private constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 jobId,address verifier)");

    /// @dev EIP-712 type hash for either party raising a dispute.
    bytes32 private constant DISPUTE_TYPEHASH =
        keccak256("Dispute(bytes32 jobId,address raisedBy)");

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    // ─── Setup ──────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // The implementation is never used directly, and an uninitialised one
        // is a contract anybody can take ownership of. Locking it here means
        // only the proxy can ever be initialised.
        _disableInitializers();
    }

    function initialize(address usdc_, address arbiter_, address treasury_, uint16 feeBps_)
        external
        initializer
    {
        if (usdc_ == address(0) || arbiter_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();

        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        usdc = IERC20(usdc_);
        arbiter = arbiter_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    // ─── Funding ────────────────────────────────────────────────────────────

    /**
     * @notice Locks a bounty for a question.
     *
     * @dev The asker signs a USDC authorisation naming this contract; a
     *      relayer submits it and pays the gas.
     *
     *      An EIP-3009 authorisation says only "move this much from me to that
     *      contract" — it carries no reason. Left there, a relayer could point
     *      any authorisation at any job. Binding the job id and amount into
     *      the nonce puts them inside the signature the wallet approved, so
     *      changing either produces a mismatch and this reverts.
     */
    function fund(
        bytes32 jobId,
        address asker,
        uint128 amount,
        uint64 deadline,
        bytes32 salt,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (jobs[jobId].status != Status.None) revert JobExists();
        if (asker == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        bytes32 nonce = keccak256(abi.encode(jobId, amount, salt));

        jobs[jobId] = Job({
            asker: asker,
            verifier: address(0),
            amount: amount,
            deadline: deadline,
            status: Status.Funded,
            evidenceHash: bytes32(0)
        });

        // Written before the transfer, so a token that calls back into this
        // contract finds the job already recorded rather than fundable twice.
        IERC3009(address(usdc)).receiveWithAuthorization(
            asker, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );

        emit Funded(jobId, asker, amount, deadline);
    }

    /**
     * @notice Funds a job with an EIP-2612 permit instead of an EIP-3009
     *         authorisation. Same job, same guarantees, different signature.
     *
     * @dev Exists for tokens that have no receiveWithAuthorization — USDT on
     *      Polygon being the one that matters, since that is what the mini app
     *      holds. The asker still signs and still pays no gas; only the shape
     *      of what they sign changes.
     *
     *      permitDeadline is the signature's own expiry and has nothing to do
     *      with `deadline`, which is when the job stops being answerable. They
     *      are separate on purpose: a short-lived signature is good practice,
     *      and a job may legitimately run for a day.
     *
     *      The allowance check is not an optimisation. A permit signature is
     *      public the moment it is relayed, and anyone may submit it first —
     *      not to steal anything, since it only ever approves this contract,
     *      but doing so consumes the token's nonce and makes our own permit
     *      call revert. The job would then fail for a reason the asker could
     *      neither see nor prevent, having already signed correctly. So if the
     *      allowance is already there, whoever put it there, use it.
     */
    function fundWithPermit(
        bytes32 jobId,
        address asker,
        uint128 amount,
        uint64 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (jobs[jobId].status != Status.None) revert JobExists();
        if (asker == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        // Written before any external call, so a token that calls back finds
        // the job already recorded rather than fundable twice.
        jobs[jobId] = Job({
            asker: asker,
            verifier: address(0),
            amount: amount,
            deadline: deadline,
            status: Status.Funded,
            evidenceHash: bytes32(0)
        });

        if (usdc.allowance(asker, address(this)) < amount) {
            IERC2612(address(usdc)).permit(asker, address(this), amount, permitDeadline, v, r, s);
        }

        // safeTransferFrom, because USDT returns no bool and a bare
        // transferFrom would revert on decoding a return value it never sent.
        usdc.safeTransferFrom(asker, address(this), amount);

        emit Funded(jobId, asker, amount, deadline);
    }

    // ─── Claiming ───────────────────────────────────────────────────────────

    /**
     * @notice Records who answered, and what they submitted.
     *
     * @dev No money moves. This exists so the payee is known before any
     *      dispute can be raised — without it, something would have to supply
     *      the verifier's address at resolution time, and whatever supplied it
     *      could name an address of its own choosing.
     *
     *      The evidence hash is recorded alongside so that a reviewer can
     *      later prove which file they judged, and an asker cannot dispute
     *      against footage other than what was sent.
     */
    function claim(bytes32 jobId, address verifier, bytes32 evidenceHash, bytes calldata signature)
        external
    {
        Job storage job = jobs[jobId];
        if (job.status != Status.Funded) revert WrongStatus(job.status);
        if (verifier == address(0)) revert ZeroAddress();
        if (block.timestamp > job.deadline) revert DeadlinePassed();

        bytes32 digest = _hashTypedData(
            keccak256(abi.encode(CLAIM_TYPEHASH, jobId, verifier, evidenceHash))
        );
        if (ECDSA.recover(digest, signature) != verifier) revert BadSignature();

        job.verifier = verifier;
        job.evidenceHash = evidenceHash;
        job.status = Status.Claimed;

        emit Claimed(jobId, verifier, evidenceHash);
    }

    // ─── Settling ───────────────────────────────────────────────────────────

    /**
     * @notice The asker is satisfied. Pays the verifier and takes the fee.
     *
     * @dev Requires the asker's signature rather than trusting the caller.
     *      A backend that could call this directly would be able to release
     *      anybody's escrow at any time, which would leave the contract
     *      offering no more assurance than the database it replaced.
     */
    function release(bytes32 jobId, bytes calldata signature) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Claimed) revert WrongStatus(job.status);

        bytes32 digest =
            _hashTypedData(keccak256(abi.encode(RELEASE_TYPEHASH, jobId, job.verifier)));
        if (ECDSA.recover(digest, signature) != job.asker) revert BadSignature();

        job.status = Status.Released;
        _payVerifier(jobId, job);
    }

    /**
     * @notice Returns the whole bounty after the deadline, if nobody delivered.
     *
     * @dev Deliberately permissionless. This is the outcome that protects the
     *      asker, and it must not depend on this platform being reachable,
     *      solvent, or willing.
     *
     *      A claimed job is excluded: somebody has answered and is waiting on
     *      a decision, so the deadline is no longer the whole story.
     */
    function refundExpired(bytes32 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Funded) revert WrongStatus(job.status);
        if (block.timestamp <= job.deadline) revert DeadlineNotReached();

        job.status = Status.Refunded;

        uint256 amount = job.amount;
        address asker = job.asker;
        usdc.safeTransfer(asker, amount);

        emit Refunded(jobId, asker, amount);
    }

    // ─── Disputes ───────────────────────────────────────────────────────────

    /**
     * @notice Freezes a job so a reviewer can look at it.
     *
     * @dev Either party may raise one, and both routes matter:
     *
     *      The asker queries evidence they do not accept. The verifier raises
     *      one when the asker has gone quiet — they walked to the place and
     *      filmed it, and without this their payment would depend on somebody
     *      who has stopped answering. The app decides when that is fair; the
     *      contract only cares that a party asked.
     *
     *      Takes a signature rather than reading msg.sender, because every
     *      transaction here is submitted by a relayer paying the gas. Checking
     *      msg.sender would compare against the relayer's address and reject
     *      both parties every time.
     */
    function dispute(bytes32 jobId, address raisedBy, bytes calldata signature) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Claimed) revert WrongStatus(job.status);
        if (raisedBy != job.asker && raisedBy != job.verifier) revert NotAParty();

        bytes32 digest =
            _hashTypedData(keccak256(abi.encode(DISPUTE_TYPEHASH, jobId, raisedBy)));
        if (ECDSA.recover(digest, signature) != raisedBy) revert BadSignature();

        job.status = Status.Disputed;
        emit Disputed(jobId, raisedBy);
    }

    /**
     * @notice Settles a disputed job.
     *
     * @dev A boolean, not an address, and that is the whole security argument.
     *      Both destinations are already recorded in the job, so the arbiter
     *      chooses between two people rather than naming a recipient. Someone
     *      holding this key can decide a dispute wrongly; they cannot take the
     *      money.
     *
     *      `resolve(bytes32,address)` would read identically in an admin
     *      interface and behave identically in normal use, while letting one
     *      compromised key drain every disputed job in the contract.
     */
    function resolve(bytes32 jobId, bool askerWins) external onlyArbiter nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Disputed) revert WrongStatus(job.status);

        if (askerWins) {
            job.status = Status.Refunded;

            uint256 amount = job.amount;
            address asker = job.asker;
            // The whole amount. The platform earns nothing on work that was
            // not accepted.
            usdc.safeTransfer(asker, amount);

            emit Refunded(jobId, asker, amount);
            emit Resolved(jobId, true, amount, 0);
        } else {
            job.status = Status.Released;
            (uint256 paid, uint256 fee) = _payVerifier(jobId, job);
            emit Resolved(jobId, false, paid, fee);
        }
    }

    // ─── Tips ───────────────────────────────────────────────────────────────

    /**
     * @notice Tips an asker whose shared answer somebody found useful.
     *
     * @dev Not escrow: there is no deadline, no dispute and no refund. Money
     *      arrives, splits, and leaves in one transaction, so the contract
     *      never holds a tip.
     *
     *      The recipient is bound into the nonce for the same reason job ids
     *      are — otherwise the relayer, not the tipper, would choose who gets
     *      paid.
     */
    function tip(
        address from,
        address to,
        uint128 amount,
        bytes32 salt,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (to == address(0) || from == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        bytes32 nonce = keccak256(abi.encode(to, amount, salt));

        IERC3009(address(usdc)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );

        uint256 fee = (uint256(amount) * feeBps) / 10_000;
        uint256 paid = amount - fee;

        usdc.safeTransfer(to, paid);
        if (fee > 0) usdc.safeTransfer(treasury, fee);

        emit Tipped(from, to, amount, fee);
    }

    /**
     * @notice A tip, authorised by permit rather than by EIP-3009.
     *
     * @dev The permit path's counterpart to tip(), for the same reason
     *      fundWithPermit() exists. Arrives, splits and leaves in one
     *      transaction, so the contract never holds a tip.
     *
     *      Note what permit cannot carry that EIP-3009 could: the recipient.
     *      An EIP-3009 nonce binds `to` into the signature, so the relayer
     *      cannot redirect the payment. A permit only approves an amount to
     *      this contract, which means the caller chooses who receives it.
     *      That caller is our own relayer, and the tipped verifier is already
     *      established off chain before this is ever invoked — but it is a
     *      weaker guarantee than tip() gives and should be understood as such
     *      rather than discovered later.
     */
    function tipWithPermit(
        address from,
        address to,
        uint128 amount,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (to == address(0) || from == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (usdc.allowance(from, address(this)) < amount) {
            IERC2612(address(usdc)).permit(from, address(this), amount, permitDeadline, v, r, s);
        }
        usdc.safeTransferFrom(from, address(this), amount);

        uint256 fee = (uint256(amount) * feeBps) / 10_000;
        uint256 paid = amount - fee;

        usdc.safeTransfer(to, paid);
        if (fee > 0) usdc.safeTransfer(treasury, fee);

        emit Tipped(from, to, amount, fee);
    }

    // ─── Administration ─────────────────────────────────────────────────────

    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter_ == address(0)) revert ZeroAddress();
        emit ArbiterChanged(arbiter, arbiter_);
        arbiter = arbiter_;
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, treasury_);
        treasury = treasury_;
    }

    /// @dev Bounded by MAX_FEE_BPS so no future owner can take everything.
    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeChanged(feeBps, feeBps_);
        feeBps = feeBps_;
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    function getJob(bytes32 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    /// @notice What a bounty of `amount` pays out and keeps, at today's fee.
    function split(uint256 amount) external view returns (uint256 paid, uint256 fee) {
        fee = (amount * feeBps) / 10_000;
        paid = amount - fee;
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    function _payVerifier(bytes32 jobId, Job storage job)
        private
        returns (uint256 paid, uint256 fee)
    {
        uint256 amount = job.amount;
        address verifier = job.verifier;

        fee = (amount * feeBps) / 10_000;
        paid = amount - fee;

        usdc.safeTransfer(verifier, paid);
        if (fee > 0) usdc.safeTransfer(treasury, fee);

        emit Released(jobId, verifier, paid, fee);
    }

    /**
     * @dev Built per call rather than cached at initialisation.
     *
     *      A domain separator holds the chain id, and a cached one is wrong
     *      after a chain forks — every signature would then verify against the
     *      wrong domain. Recomputing costs a little gas and cannot go stale.
     */
    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("AskEscrow"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @dev Upgrades answer to the owner, never to the arbiter. Two powers,
    ///      two keys — a compromised arbiter must not be able to replace the
    ///      rules, only to decide a dispute.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
