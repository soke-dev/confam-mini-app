import { privateKeyToAccount } from 'viem/accounts';
import { config, hasEscrow } from './config.js';
import { one, query } from './db.js';
import { ngnRate } from './rates.js';
import {
  fundPayload,
  jobIdFor,
  randomSalt,
  readJob,
  relayFund,
  relayRelease,
  releasePayload,
} from './escrow.js';

/**
 * The agent's own wallet, and the money that leaves it.
 *
 * A job dispatched by an agent used to be a row in the ledger and nothing
 * more. The app's jobs funded a real escrow on Base and an agent's did not,
 * which meant the sentence everybody wanted to say — the agent pays a human in
 * USDC — was true of the half nobody was looking at and false of the half on
 * the demonstration page.
 *
 * The reason was never the chain. Funding pulls USDC with an EIP-3009
 * authorisation signed by the asker, and the asker was a Privy wallet that
 * only a signed-in person could operate. An agent has no person. So it gets a
 * wallet of its own and signs with it here, which is the same thing the gas
 * relayer has always done — sign server-side and submit — pointed at a
 * different key.
 *
 * Nothing else changes. Same contract, same jobId derivation, same salt, same
 * relay. An escrow funded this way is indistinguishable on-chain from one a
 * person funded, which is the point: there is no agent-flavoured money.
 */

/** The address the agent pays from. Null when no key is configured. */
export function agentAddress(): `0x${string}` | null {
  const key = config.chain.agentWalletKey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return privateKeyToAccount(key as `0x${string}`).address;
}

export const hasAgentWallet = () => agentAddress() !== null;

/** How long a signed authorisation stays valid. Mirrors the app's own. */
const AUTH_TTL_SECONDS = 30 * 60;

export type FundResult =
  | { ok: true; txHash: string; jobId: string; usdc: number }
  | { ok: false; reason: string };

/**
 * Locks the bounty for a question in the escrow, paying from the agent wallet.
 *
 * Deliberately returns rather than throws. A job that reached the board and
 * failed to fund is a real problem, but it is not a reason to fail the request
 * that created it — somebody may already be walking, and the honest thing is
 * to record that the money is not locked rather than to pretend the job never
 * happened.
 */
export async function fundAsAgent(questionId: string, bountyKobo: number): Promise<FundResult> {
  if (!hasEscrow()) return { ok: false, reason: 'no_escrow_configured' };

  const key = config.chain.agentWalletKey;
  const asker = agentAddress();
  if (!asker) return { ok: false, reason: 'no_agent_wallet' };

  const q = await one<{ deadlineMinutes: number; fundSalt: string | null }>(
    `SELECT deadline_minutes AS "deadlineMinutes", fund_salt AS "fundSalt"
       FROM questions WHERE id = $1`,
    [questionId],
  );
  if (!q) return { ok: false, reason: 'no_question' };

  /**
   * A rate, even when the provider is unreachable.
   *
   * This used to give up, and giving up means a dispatched job with nothing
   * locked against it — worse than pricing it a few percent off. Which rate
   * was used is written to the row, so the approximation is visible rather
   * than silent.
   */
  const live = await ngnRate();
  const ngnPerUsd = live?.ngnPerUsd ?? config.rates.fallbackNgnPerUsd;
  if (!live) {
    console.warn('[agent] no live FX rate, pricing at the fallback', ngnPerUsd);
  }

  const jobId = jobIdFor(questionId);
  // Reused if one was already issued, so a retry after a failed relay signs
  // the same authorisation rather than a second one against the same job.
  const salt = (q.fundSalt as `0x${string}` | null) ?? randomSalt();
  const validBefore = Math.floor(Date.now() / 1000) + AUTH_TTL_SECONDS;
  const deadline = Math.floor(Date.now() / 1000) + q.deadlineMinutes * 60;

  // Rounded up at six decimals, the same way the app prices a bounty, so an
  // agent and a person asking the same question lock the same amount.
  const usdc = Math.ceil((bountyKobo / 100 / ngnPerUsd) * 1e6) / 1e6;

  const { typedData } = fundPayload({ jobId, asker, usdc, validBefore, salt });

  const account = privateKeyToAccount(key as `0x${string}`);
  const signature = await account.signTypedData(typedData as never).catch(() => null);
  if (!signature) return { ok: false, reason: 'could_not_sign' };

  /**
   * `fund_tx` included, the same as the app's own funding route stores.
   *
   * It was left out here, so an agent-funded job was on chain and had nothing
   * pointing at the transaction that put it there — which is exactly the thing
   * somebody checking the claim wants to open.
   */
  const record = async (txHash: string | null) =>
    query(
      `UPDATE questions
          SET chain_job_id = $2, fund_salt = $3,
              fund_usdc = COALESCE(fund_usdc, $4),
              fund_rate = COALESCE(fund_rate, $5),
              fund_tx  = COALESCE(fund_tx, $6)
        WHERE id = $1`,
      [questionId, jobId, salt, usdc, ngnPerUsd, txHash],
    );

  /**
   * Retried, because the failure that actually happens is the network.
   *
   * The first job dispatched in testing came back unfunded on an ECONNRESET
   * from the RPC — not a rejection, just a dropped connection — and a job on
   * the board with no escrow behind it is the worst state this can produce:
   * somebody can see it and walk before the money is locked.
   *
   * The same signed authorisation is reused each time rather than a fresh one.
   * Its nonce is derived from the job, the amount and the salt, so a retry is
   * the same authorisation arriving again, not a second claim on the wallet.
   */
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await relayFund({ jobId, asker, usdc, deadline, salt, validBefore, signature });
      await record(result.txHash);
      return { ok: true, txHash: result.txHash, jobId, usdc };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);

      /**
       * A dropped response looks exactly like a failure.
       *
       * So before trying again, ask the chain. If the transaction actually
       * landed, retrying would send a second one that reverts on status —
       * harmless but wasteful, and it would report a funded job as failed.
       */
      // Base, explicitly: the agent funds through relayFund, which is the
      // EIP-3009 path and therefore always Base. Spelled out rather than left
      // to the default, so that if the agent ever funds elsewhere this line
      // is visibly wrong instead of quietly so.
      const onChain = await readJob(jobId, 'base').catch(() => null);
      if (onChain && onChain.status !== 'none') {
        await record(null);
        return { ok: true, txHash: 'already_funded', jobId, usdc };
      }

      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 800));
    }
  }

  /**
   * Reported, never swallowed. A demo that had quietly stopped putting money
   * on chain would look exactly like one that never did.
   */
  console.warn('[agent] could not fund on chain after 3 tries —', lastError);
  return { ok: false, reason: lastError.slice(0, 200) };
}

/**
 * Pays the verifier, on the agent's say-so.
 *
 * The asker decides when work is accepted, and for an agent's job the agent is
 * the asker — so the signature the contract wants is one only this wallet can
 * produce. Without it an agent could fund a job and dispatch somebody and then
 * have no way to pay them, which is a worse position than not being able to
 * dispatch at all.
 *
 * Same shape as funding: sign here, relay through the gas wallet, and report
 * rather than throw. A release that fails leaves the money in escrow, which is
 * recoverable; pretending it succeeded is not.
 */
export async function releaseAsAgent(questionId: string): Promise<FundResult> {
  if (!hasEscrow()) return { ok: false, reason: 'no_escrow_configured' };

  const key = config.chain.agentWalletKey;
  if (!agentAddress()) return { ok: false, reason: 'no_agent_wallet' };

  const job = await one<{
    chainJobId: string | null;
    fundChain: string;
    verifierWallet: string | null;
  }>(
    `SELECT q.chain_job_id AS "chainJobId", q.fund_chain AS "fundChain",
            u.wallet_address AS "verifierWallet"
       FROM questions q
       LEFT JOIN tasks t ON t.question_id = q.id
       LEFT JOIN users u ON u.id = t.verifier_id
      WHERE q.id = $1`,
    [questionId],
  );

  if (!job?.chainJobId) return { ok: false, reason: 'not_funded' };
  if (!job.verifierWallet) return { ok: false, reason: 'no_verifier' };

  const jobId = job.chainJobId as `0x${string}`;

  /**
   * Asked before signing, because a job already released is not a failure.
   *
   * The commonest way this is reached twice is a retry after a dropped
   * response, and reporting that as an error would send somebody looking for a
   * problem that has already resolved itself.
   */
  const which = job.fundChain === 'polygon' ? 'polygon' : 'base';
  const onChain = await readJob(jobId, which).catch(() => null);
  if (onChain && onChain.status === 'released') {
    return { ok: true, txHash: 'already_released', jobId, usdc: 0 };
  }

  try {
    const account = privateKeyToAccount(key as `0x${string}`);
    const signature = await account.signTypedData(
      releasePayload(jobId, job.verifierWallet) as never,
    );
    const result = await relayRelease(jobId, signature, which);

    await query(`UPDATE questions SET release_tx = COALESCE(release_tx, $2) WHERE id = $1`, [
      questionId,
      result.txHash,
    ]);

    return { ok: true, txHash: result.txHash, jobId, usdc: 0 };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('[agent] could not release —', detail);
    return { ok: false, reason: detail.slice(0, 200) };
  }
}
