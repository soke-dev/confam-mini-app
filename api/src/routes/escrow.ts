import { keccak256, toHex } from 'viem';
import { combineHashes } from '../evidenceHash.js';
import { storage } from '../storage.js';
import { proofPage } from '../proofPage.js';
import { Router } from 'express';
import { authenticate } from '../auth.js';
import { authenticateEither } from '../agentAuth.js';
import { one, query, transaction } from '../db.js';
import { notify, nearbyVerifiers } from '../push.js';
import { config, hasEscrow } from '../config.js';
import { ngnRate } from '../rates.js';
import { originOf } from '../origin.js';
import {
  claimPayload,
  disputePayload,
  fundPayload,
  jobIdFor,
  randomSalt,
  readJob,
  relayClaim,
  relayDispute,
  relayFund,
  relayRefund,
  relayRelease,
  releasePayload,
  permitPayload,
  relayFundWithPermit,
  hasPolygonEscrow,
  type EscrowChain,
} from '../escrow.js';

export const escrowRouter: Router = Router();

/** Long enough to read and approve, short enough that a stale one expires. */
const AUTH_TTL_SECONDS = 15 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates the question id before it reaches a query or a job id.
 *
 * Express only guarantees the parameter is present, not that it is a UUID —
 * and `jobIdFor` parses it as hex, so a malformed one would produce a garbage
 * job id rather than an error anybody could act on.
 */
function questionIdOf(value: string | undefined): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/**
 * Each step is two calls: one that hands back what to sign, one that relays
 * the signature.
 *
 * The payload is always built here rather than in the app, so the amount, the
 * job and the recipient are fixed by the server. A client that assembled its
 * own could sign something other than what it displayed.
 */

/**
 * Which chain a job's money is on, as a value the relays accept.
 *
 * Read from the row rather than from the request, because by this point it is
 * a fact rather than a choice: the money is already locked in one specific
 * contract and nothing a caller says can move it. Anything unrecognised falls
 * back to Base, which is where every job funded before Polygon existed lives.
 */
const chainOf = (row: { fundChain?: string | null }): EscrowChain =>
  row.fundChain === 'polygon' ? 'polygon' : 'base';

escrowRouter.get('/status', authenticate, (_req, res) => {
  res.json({ available: hasEscrow() });
});

// ─── Funding ────────────────────────────────────────────────────────────────

escrowRouter.post('/:questionId/fund/quote', authenticateEither, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const user = req.user!;
  if (!hasEscrow()) {
    res.status(503).json({ error: 'escrow_unconfigured' });
    return;
  }
  if (!user.walletAddress) {
    res.status(400).json({ error: 'no_wallet' });
    return;
  }

  const q = await one<{
    bountyKobo: number;
    deadlineMinutes: number;
    chainJobId: string | null;
    fundSalt: string | null;
    fundUsdc: string | null;
  }>(
    `SELECT bounty_kobo AS "bountyKobo", deadline_minutes AS "deadlineMinutes",
            chain_job_id AS "chainJobId", fund_salt AS "fundSalt",
            fund_usdc AS "fundUsdc"
       FROM questions WHERE id = $1 AND asker_id = $2`,
    [questionId, user.id],
  );

  if (!q) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (q.chainJobId) {
    res.status(409).json({ error: 'already_funded' });
    return;
  }

  const jobId = jobIdFor(questionId);
  // Reuse the salt if one was already issued, so a retry after a failed relay
  // produces the same nonce rather than orphaning the first signature.
  const salt = (q.fundSalt as `0x${string}` | null) ?? randomSalt();
  const validBefore = Math.floor(Date.now() / 1000) + AUTH_TTL_SECONDS;
  const deadline = Math.floor(Date.now() / 1000) + q.deadlineMinutes * 60;

  /**
   * Naira in, USDC out — converted once, here.
   *
   * A bounty is priced in naira and escrowed in USDC. Passing the naira figure
   * straight through meant ₦500 was funded as 500 USDC: a thousand times the
   * intended amount, which reverted as "transfer amount exceeds balance".
   *
   * Reused on a retry rather than recomputed, because the nonce is
   * keccak(jobId, amount, salt) — a rate that moved between two attempts would
   * change the amount, change the nonce, and invalidate the signature.
   */
  let usdc: number;
  let usedRate: number | null = null;

  if (q.fundUsdc !== null) {
    usdc = Number(q.fundUsdc);
  } else {
    const rate = await ngnRate();
    if (!rate) {
      res.status(503).json({
        error: 'no_rate',
        detail: 'The exchange rate is unavailable, so this cannot be priced yet.',
      });
      return;
    }
    usedRate = rate.ngnPerUsd;
    // Six decimals is all USDC can represent; rounding up by one unit avoids
    // escrowing a hair less than the bounty promised.
    usdc = Math.ceil((q.bountyKobo / 100 / rate.ngnPerUsd) * 1e6) / 1e6;
  }

  await query(
    `UPDATE questions
        SET fund_salt = $2,
            fund_usdc = COALESCE(fund_usdc, $3),
            fund_rate = COALESCE(fund_rate, $4)
      WHERE id = $1`,
    [questionId, salt, usdc, usedRate],
  );

  /**
   * Which chain the caller is funding on.
   *
   * Said by the client, because the client is the one holding the wallet and
   * knows what chain it is on. The mini app runs inside a host that offers
   * Polygon; everything else is on Base and says nothing, which is why Base is
   * what an absent parameter means.
   *
   * The two produce different signatures entirely — EIP-3009 on Base, EIP-2612
   * permit on Polygon, because USDT there has no receiveWithAuthorization at
   * all — so this decides what the caller is asked to sign.
   */
  if (req.query.chain === 'polygon') {
    if (!hasPolygonEscrow()) {
      res.status(503).json({
        error: 'escrow_unconfigured',
        detail: 'Funding on Polygon is not available yet.',
      });
      return;
    }

    const { permitDeadline, typedData: permitTyped } = await permitPayload({
      owner: user.walletAddress,
      amount: usdc,
    });

    res.json({
      jobId,
      salt,
      deadline,
      permitDeadline,
      usdc,
      chain: 'polygon',
      token: 'USDT',
      typedData: permitTyped,
    });
    return;
  }

  const { typedData } = fundPayload({
    jobId,
    asker: user.walletAddress,
    usdc,
    validBefore,
    salt,
  });

  res.json({ jobId, salt, deadline, validBefore, usdc, chain: 'base', token: 'USDC', typedData });
});

escrowRouter.post('/:questionId/fund', authenticateEither, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const user = req.user!;
  const { signature, deadline, validBefore } = req.body as Record<string, unknown>;

  if (typeof signature !== 'string') {
    res.status(400).json({ error: 'missing_signature' });
    return;
  }

  const q = await one<{
    bountyKobo: number;
    fundSalt: string | null;
    chainJobId: string | null;
    fundUsdc: string | null;
    body: string;
  }>(
    `SELECT bounty_kobo AS "bountyKobo", fund_salt AS "fundSalt",
            chain_job_id AS "chainJobId", fund_usdc AS "fundUsdc", body
       FROM questions WHERE id = $1 AND asker_id = $2`,
    [questionId, user.id],
  );

  if (!q?.fundSalt || q.fundUsdc === null) {
    res.status(409).json({ error: 'no_quote', detail: 'Ask for a quote first.' });
    return;
  }
  if (q.chainJobId) {
    res.status(409).json({ error: 'already_funded' });
    return;
  }

  const jobId = jobIdFor(questionId);
  const onPolygon = req.query.chain === 'polygon';

  if (onPolygon && !hasPolygonEscrow()) {
    res.status(503).json({
      error: 'escrow_unconfigured',
      detail: 'Funding on Polygon is not available yet.',
    });
    return;
  }

  try {
    /*
     * The amount the quote fixed, either way. Recomputing it here would break
     * the Base nonce, which is keccak(jobId, amount, salt), and would mean
     * signing for one figure and relaying another on Polygon.
     */
    const result = onPolygon
      ? await relayFundWithPermit({
          jobId,
          asker: user.walletAddress!,
          usdt: Number(q.fundUsdc),
          deadline: Number(deadline),
          permitDeadline: Number((req.body as Record<string, unknown>).permitDeadline),
          signature,
        })
      : await relayFund({
          jobId,
          asker: user.walletAddress!,
          usdc: Number(q.fundUsdc),
          deadline: Number(deadline),
          salt: q.fundSalt as `0x${string}`,
          validBefore: Number(validBefore),
          signature,
        });

    /**
     * Funded — so now it becomes a job, and now the ledger records the hold.
     *
     * Both in one transaction with the chain reference. A question marked
     * dispatched without its hold shows money still in the wallet that is
     * actually in escrow; a hold without dispatch takes the money and
     * advertises nothing.
     *
     * The deadline starts here rather than at creation: the clock a verifier
     * races is the one that began when the bounty became real.
     */
    await transaction(async (client) => {
      await client.query(
        /*
         * fund_chain is written here and nowhere else. It stops being a
         * preference and becomes a fact about where this person's money is
         * the moment the transaction confirms, and every later relay — claim,
         * release, dispute, refund — reads it to know which contract to talk
         * to.
         */
        `UPDATE questions
            SET chain_job_id = $2, fund_tx = $3, fund_chain = $4,
                dispatched_at = COALESCE(dispatched_at, now())
          WHERE id = $1`,
        [questionId, jobId, result.txHash, onPolygon ? 'polygon' : 'base'],
      );
      await client.query(
        `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
         VALUES ($1, 'hold', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        // Names the question. "Locked in escrow" alone told somebody scanning
        // a list of identical rows nothing about which one this was.
        [user.id, q.bountyKobo, questionId, `Held for: ${q.body.slice(0, 80)}`],
      );
    });

    res.json({ ok: true, jobId, txHash: result.txHash });

    /**
     * The job is only real once the money is locked, so this is where the
     * board is told — not when the question was typed.
     *
     * Everybody who asked for nearby alerts and is not the asker. Sent one at
     * a time rather than as one broadcast because each row is also written to
     * that person's own feed, and the two surfaces have to agree.
     */
    void (async () => {
      const audience = await nearbyVerifiers(questionId);
      for (const userId of audience) {
        await notify({
          userId,
          kind: 'job',
          title: 'A job near you',
          body: `${q.body.slice(0, 60)} · ₦${Math.round(q.bountyKobo / 100)}`,
          href: `/task/${questionId}`,
        });
      }
    })();
  } catch (error) {
    res.status(502).json({
      error: 'fund_failed',
      detail: error instanceof Error ? error.message : 'Could not fund the job.',
    });
  }
});

// ─── Claiming ───────────────────────────────────────────────────────────────

/**
 * The proof, for anybody at all.
 *
 * Deliberately unauthenticated. A commitment that can only be checked by
 * asking us whether it checks out is not a commitment — the value of putting a
 * hash on Base is that somebody who distrusts this server entirely can fetch
 * the files, hash them with any Ethereum library, read Claimed() from the
 * contract, and compare. This endpoint exists to make that possible, not to
 * perform it on their behalf.
 *
 * Public questions only. A private answer stays private, and a proof that
 * leaked its evidence to anyone holding a question id would be a worse
 * trade than not offering one.
 */
/**
 * A transaction hash and where to read it.
 *
 * Base has one canonical explorer and nobody checking a claim should have to
 * know its address — the point of publishing a hash is that it can be opened.
 */
function link(tx: string | null): { hash: string; url: string } | null {
  if (!tx) return null;
  return { hash: tx, url: `https://basescan.org/tx/${tx}` };
}

escrowRouter.get('/:questionId/proof', async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }

  const q = await one<{
    chainJobId: string | null;
    body: string;
    place: string | null;
    fundTx: string | null;
    releaseTx: string | null;
    refundTx: string | null;
    claimTx: string | null;
  }>(
    `SELECT q.chain_job_id AS "chainJobId", q.fund_chain AS "fundChain", q.body, p.name AS place,
            q.fund_tx AS "fundTx", q.release_tx AS "releaseTx",
            q.refund_tx AS "refundTx", t.claim_tx AS "claimTx"
       FROM questions q
       LEFT JOIN places p ON p.id = q.place_id
       LEFT JOIN tasks t  ON t.question_id = q.id
      WHERE q.id = $1 AND q.visibility = 'public'`,
    [questionId],
  );
  if (!q) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const files = await query<{
    hash: string | null;
    key: string;
    bytes: string | null;
    capturedAt: Date | null;
    lat: number | null;
    lng: number | null;
    distance: number | null;
  }>(
    `SELECT e.content_hash AS hash, e.storage_key AS key, e.bytes,
            e.captured_at AS "capturedAt", e.captured_lat AS lat,
            e.captured_lng AS lng, e.distance_metres AS distance
       FROM evidence e
       JOIN tasks t ON t.id = e.task_id
      WHERE t.question_id = $1
        AND e.attempt IS NOT DISTINCT FROM
            (SELECT max(attempt) FROM evidence WHERE task_id = t.id)
      ORDER BY e.created_at`,
    [questionId],
  );

  const hashes = files.map((f) => f.hash).filter((h): h is string => Boolean(h));

  const view = {
    question: q.body,
    place: q.place,
    chain: {
      jobId: q.chainJobId,
      escrow: config.chain.escrowAddress || null,
      chainId: config.chain.chainId,
      /** What claim() committed. Compare against Claimed(jobId, ...). */
      evidenceHash: combineHashes(hashes),
      /**
       * The transactions themselves, so this can be opened rather than taken
       * on trust. Each is a link somebody can paste into a block explorer and
       * read without any part of this server in the way.
       */
      transactions: {
        funded: link(q.fundTx),
        claimed: link(q.claimTx),
        released: link(q.releaseTx),
        refunded: link(q.refundTx),
      },
    },
    evidence: files.map((f) => ({
      url: storage.urlFor(f.key),
      keccak256: f.hash,
      bytes: f.bytes ? Number(f.bytes) : null,
      capturedAt: f.capturedAt,
      lat: f.lat,
      lng: f.lng,
      metresFromPlace: f.distance,
    })),
    /**
     * Said in the response rather than in documentation somebody has to find,
     * because the instruction is three lines and the whole claim rests on
     * anybody being able to follow it.
     */
    verify: [
      'Download each evidence url.',
      'keccak256 the bytes of each file.',
      'Sort those hashes as strings, concatenate without 0x, keccak256 the result.',
      'A single file is its own hash, uncombined.',
      'Compare with evidenceHash in the Claimed event for this jobId on Base.',
    ],
    unverifiable: hashes.length === 0 ? 'This was submitted before evidence was hashed at upload.' : null,
  };

  /**
   * The same facts, in the shape the caller can use.
   *
   * A browser asking for HTML gets a page; an agent gets the JSON it was
   * always getting. This endpoint was built for machines and returned hex to
   * anybody who clicked a link labelled "proof", which is the one audience
   * that cannot do anything with it.
   *
   * ?format=json overrides, for looking at the raw shape from a browser.
   */
  const wantsJson =
    req.query.format === 'json' || !req.accepts('html');

  if (wantsJson) {
    res.json(view);
    return;
  }

  res.type('html').send(proofPage(view, originOf(req)));
});

escrowRouter.post('/:questionId/claim/quote', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const user = req.user!;
  const evidence = String((req.body as { evidence?: unknown }).evidence ?? '');

  const q = await one<{ chainJobId: string | null; fundChain: string }>(
    `SELECT chain_job_id AS "chainJobId", fund_chain AS "fundChain"
       FROM questions WHERE id = $1`,
    [questionId],
  );
  if (!q?.chainJobId) {
    res.status(409).json({ error: 'not_funded', detail: 'This job is not on chain.' });
    return;
  }
  if (!user.walletAddress) {
    res.status(400).json({ error: 'no_wallet' });
    return;
  }

  /**
   * The hash of the evidence itself, taken from what was stored.
   *
   * This used to hash whatever string the client sent, and what the app sent
   * was `shots[0].uri` — a file:// path on one phone. So the chain carried a
   * commitment to a filename that existed nowhere, and replacing the stored
   * photograph afterwards would not have changed it. A verifiable claim about
   * evidence that could not verify the evidence.
   *
   * Read from the database rather than accepted from the caller, because a
   * commitment the committer chooses is not a commitment. The client no longer
   * has any say in it; the `evidence` field it still sends is used only when
   * there is nothing stored to hash.
   */
  const files = await query<{ hash: string }>(
    `SELECT content_hash AS hash
       FROM evidence e
       JOIN tasks t ON t.id = e.task_id
      WHERE t.question_id = $1
        AND e.content_hash IS NOT NULL
        AND e.attempt IS NOT DISTINCT FROM
            (SELECT max(attempt) FROM evidence WHERE task_id = t.id)`,
    [questionId],
  );

  /**
   * Falls back only when there is genuinely nothing to hash.
   *
   * A ledger-only answer with no file still has to commit to something, and
   * the question id at least identifies which job was claimed. Rows written
   * before content_hash existed land here too — they were never committed to
   * honestly and cannot be repaired, since the old value hashed something
   * else entirely.
   */
  const evidenceHash =
    combineHashes(files.map((f) => f.hash)) ?? keccak256(toHex(evidence || questionId));

  res.json({
    jobId: q.chainJobId,
    evidenceHash,
    typedData: claimPayload(q.chainJobId as `0x${string}`, user.walletAddress, evidenceHash),
  });
});

escrowRouter.post('/:questionId/claim', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const user = req.user!;
  const { signature, evidenceHash } = req.body as Record<string, unknown>;

  if (typeof signature !== 'string' || typeof evidenceHash !== 'string') {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }

  const q = await one<{ chainJobId: string | null; fundChain: string }>(
    `SELECT chain_job_id AS "chainJobId", fund_chain AS "fundChain"
       FROM questions WHERE id = $1`,
    [questionId],
  );
  if (!q?.chainJobId) {
    res.status(409).json({ error: 'not_funded' });
    return;
  }

  try {
    const result = await relayClaim(
      q.chainJobId as `0x${string}`,
      user.walletAddress!,
      evidenceHash as `0x${string}`,
      signature,
      chainOf(q),
    );

    await query(
      `UPDATE tasks SET claim_tx = $2, evidence_hash = $3
        WHERE question_id = $1 AND verifier_id = $4`,
      [questionId, result.txHash, evidenceHash, user.id],
    );

    res.json({ ok: true, txHash: result.txHash });
  } catch (error) {
    res.status(502).json({
      error: 'claim_failed',
      detail: error instanceof Error ? error.message : 'Could not record the claim.',
    });
  }
});

// ─── Releasing ──────────────────────────────────────────────────────────────

escrowRouter.post('/:questionId/release/quote', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const job = await one<{ chainJobId: string | null; fundChain: string; verifierWallet: string | null }>(
    `SELECT q.chain_job_id AS "chainJobId", q.fund_chain AS "fundChain",
            u.wallet_address AS "verifierWallet"
       FROM questions q
       LEFT JOIN tasks t ON t.question_id = q.id
       LEFT JOIN users u ON u.id = t.verifier_id
      WHERE q.id = $1 AND q.asker_id = $2`,
    [questionId, req.user!.id],
  );

  if (!job?.chainJobId) {
    res.status(409).json({ error: 'not_funded' });
    return;
  }
  if (!job.verifierWallet) {
    res.status(409).json({ error: 'no_verifier', detail: 'Nobody has claimed this yet.' });
    return;
  }

  res.json({
    jobId: job.chainJobId,
    typedData: releasePayload(job.chainJobId as `0x${string}`, job.verifierWallet),
  });
});

escrowRouter.post('/:questionId/release', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const signature = String((req.body as { signature?: unknown }).signature ?? '');
  if (!signature) {
    res.status(400).json({ error: 'missing_signature' });
    return;
  }

  const job = await one<{ chainJobId: string | null; fundChain: string }>(
    `SELECT chain_job_id AS "chainJobId", fund_chain AS "fundChain"
       FROM questions WHERE id = $1 AND asker_id = $2`,
    [questionId, req.user!.id],
  );
  if (!job?.chainJobId) {
    res.status(409).json({ error: 'not_funded' });
    return;
  }

  /**
   * The contract must know who to pay before it can pay them.
   *
   * A job whose verifier is still the zero address was never claimed on chain
   * — the verifier submitted their answer but their signature did not land.
   * release() reverts on it, and the revert message says nothing useful, so
   * the reason is checked here and stated plainly instead.
   */
  const chainJob = await readJob(job.chainJobId as `0x${string}`, chainOf(job));
  if (chainJob && /^0x0+$/.test(chainJob.verifier)) {
    res.status(409).json({
      error: 'no_claim_on_chain',
      detail:
        'The verifier has not signed for this job yet, so the contract has nobody to pay. ' +
        'Ask them to open it and sign, or wait for the deadline and take a refund.',
    });
    return;
  }

  try {
    const result = await relayRelease(job.chainJobId as `0x${string}`, signature, chainOf(job));
    await query(`UPDATE questions SET release_tx = $2 WHERE id = $1`, [
      questionId,
      result.txHash,
    ]);
    res.json({ ok: true, txHash: result.txHash });
  } catch (error) {
    res.status(502).json({
      error: 'release_failed',
      detail: error instanceof Error ? error.message : 'Could not release payment.',
    });
  }
});

// ─── Refund and dispute ─────────────────────────────────────────────────────

/**
 * Refunds an expired job. Needs no signature — the contract enforces the
 * deadline itself, and the money can only go back to the recorded asker.
 */
escrowRouter.post('/:questionId/refund', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const job = await one<{ chainJobId: string | null; fundChain: string }>(
    `SELECT chain_job_id AS "chainJobId", fund_chain AS "fundChain"
       FROM questions WHERE id = $1 AND asker_id = $2`,
    [questionId, req.user!.id],
  );
  if (!job?.chainJobId) {
    res.status(409).json({ error: 'not_funded' });
    return;
  }

  try {
    const result = await relayRefund(job.chainJobId as `0x${string}`, chainOf(job));
    await query(`UPDATE questions SET refund_tx = $2 WHERE id = $1`, [
      questionId,
      result.txHash,
    ]);
    res.json({ ok: true, txHash: result.txHash });
  } catch (error) {
    res.status(502).json({
      error: 'refund_failed',
      detail: error instanceof Error ? error.message : 'Could not refund.',
    });
  }
});

escrowRouter.post('/:questionId/dispute/quote', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const job = await one<{ chainJobId: string | null; fundChain: string }>(
    `SELECT chain_job_id AS "chainJobId", fund_chain AS "fundChain"
       FROM questions WHERE id = $1`,
    [questionId],
  );
  if (!job?.chainJobId || !req.user!.walletAddress) {
    res.status(409).json({ error: 'not_funded' });
    return;
  }
  res.json({
    typedData: disputePayload(job.chainJobId as `0x${string}`, req.user!.walletAddress),
  });
});

escrowRouter.post('/:questionId/dispute', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const signature = String((req.body as { signature?: unknown }).signature ?? '');
  const job = await one<{ chainJobId: string | null; fundChain: string }>(
    `SELECT chain_job_id AS "chainJobId", fund_chain AS "fundChain"
       FROM questions WHERE id = $1`,
    [questionId],
  );
  if (!job?.chainJobId || !signature) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }

  try {
    const result = await relayDispute(
      job.chainJobId as `0x${string}`,
      req.user!.walletAddress!,
      signature,
      chainOf(job),
    );
    res.json({ ok: true, txHash: result.txHash });
  } catch (error) {
    res.status(502).json({
      error: 'dispute_failed',
      detail: error instanceof Error ? error.message : 'Could not raise the dispute.',
    });
  }
});

/** The chain's view of a job, for reconciling against ours. */
escrowRouter.get('/:questionId/job', authenticate, async (req, res) => {
  const questionId = questionIdOf(req.params.questionId);
  if (!questionId) {
    res.status(400).json({ error: 'bad_question_id' });
    return;
  }
  const job = await one<{ chainJobId: string | null; fundChain: string }>(
    `SELECT chain_job_id AS "chainJobId", fund_chain AS "fundChain"
       FROM questions WHERE id = $1`,
    [questionId],
  );
  if (!job?.chainJobId) {
    res.json({ job: null });
    return;
  }
  res.json({ job: await readJob(job.chainJobId as `0x${string}`, chainOf(job)) });
});
