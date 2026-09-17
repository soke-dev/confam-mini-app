import { apiFetch, hasApi } from './api';
import { WALLET_MODE } from '@/utils/privyShared';

/**
 * The escrow, from the app's side.
 *
 * Every step is quote-then-relay: ask the server what to sign, sign it, send
 * the signature back. The server builds the payload so the amount, the job and
 * the recipient are fixed before anybody signs — an app that assembled its own
 * could display one thing and sign another.
 *
 * Nobody pays gas. The relayer covers it, and can only broadcast what was
 * signed.
 */

export type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

type Signer = (typedData: TypedData) => Promise<string>;

export type EscrowResult =
  | { ok: true; txHash: string }
  | { ok: false; detail: string; code: string | null };

/** True when this build has a contract to talk to at all. */
export async function escrowAvailable(): Promise<boolean> {
  if (!hasApi) return false;
  const result = await apiFetch<{ available: boolean }>('/escrow/status');
  return result.ok && result.data.available;
}

/**
 * Runs one quote-sign-relay round.
 *
 * A declined signature is not an error — somebody looked at what they were
 * being asked to authorise and said no, which is the prompt working.
 */
async function step(
  quotePath: string,
  relayPath: string,
  sign: Signer,
  quoteBody?: Record<string, unknown>,
  extra?: (quote: Record<string, unknown>) => Record<string, unknown>,
): Promise<EscrowResult> {
  const quote = await apiFetch<Record<string, unknown> & { typedData: TypedData }>(quotePath, {
    method: 'POST',
    body: JSON.stringify(quoteBody ?? {}),
  });
  if (!quote.ok) return { ok: false, detail: quote.detail, code: quote.code };

  let signature: string;
  try {
    signature = await sign(quote.data.typedData);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Signing failed.';
    return {
      ok: false,
      code: /reject|denied|cancel/i.test(message) ? 'declined' : 'sign_failed',
      /*
       * Labelled as a signing failure. Without the prefix this arrives beside
       * network errors in the same sentence — "the bounty could not be locked,
       * <message>" — and there is no way to tell from the screen whether the
       * wallet or the server was the problem.
       */
      detail: /reject|denied|cancel/i.test(message)
        ? 'You cancelled the signature.'
        : `signing failed: ${message}`,
    };
  }

  /*
   * Longer than the default, because the server is waiting on Base.
   *
   * A relay submits the transaction and then waits for its receipt, with its
   * own 90 second ceiling. The client's default is 30, so it gave up on a call
   * that was working: the app said the bounty could not be locked and the
   * server said nothing at all, because a request the client abandons never
   * reaches res.on('finish') and so is never logged. Whatever the chain does,
   * the answer arrives here rather than being cut off mid-way.
   */
  const relayed = await apiFetch<{ txHash: string }>(relayPath, {
    method: 'POST',
    timeoutMs: 120_000,
    body: JSON.stringify({ signature, ...(extra ? extra(quote.data) : {}) }),
  });
  if (!relayed.ok) return { ok: false, detail: relayed.detail, code: relayed.code };

  return { ok: true, txHash: relayed.data.txHash };
}

/**
 * Locks the bounty in the contract. Signed by the asker.
 *
 * Two shapes, because the two chains authorise payment differently. On Base
 * the asker signs an EIP-3009 authorisation carrying its own validity window;
 * on Polygon they sign an EIP-2612 permit, because USDT there has no
 * receiveWithAuthorization at all. The server decides what to ask for from the
 * same `chain` parameter, so the two can never disagree about which is being
 * signed.
 */
export const fundJob = (questionId: string, sign: Signer) => {
  const chain = WALLET_MODE ? '?chain=polygon' : '';
  return step(
    `/escrow/${questionId}/fund/quote${chain}`,
    `/escrow/${questionId}/fund${chain}`,
    sign,
    undefined,
    (quote) =>
      WALLET_MODE
        ? { deadline: quote.deadline, permitDeadline: quote.permitDeadline }
        : { deadline: quote.deadline, validBefore: quote.validBefore },
  );
};

/** Records who answered, and a hash of what they sent. Signed by the verifier. */
export const claimJob = (questionId: string, evidence: string, sign: Signer) =>
  step(`/escrow/${questionId}/claim/quote`, `/escrow/${questionId}/claim`, sign, { evidence }, (quote) => ({
    evidenceHash: quote.evidenceHash,
  }));

/** Pays the verifier 90% and the platform 10%. Signed by the asker. */
export const releaseJob = (questionId: string, sign: Signer) =>
  step(`/escrow/${questionId}/release/quote`, `/escrow/${questionId}/release`, sign);

/** Freezes the job for a reviewer. Signed by whichever side raised it. */
export const disputeJob = (questionId: string, sign: Signer) =>
  step(`/escrow/${questionId}/dispute/quote`, `/escrow/${questionId}/dispute`, sign);

/**
 * Returns the money after the deadline. Needs no signature — the contract
 * checks the deadline itself and can only pay the recorded asker.
 */
export const refundJob = (questionId: string) =>
  apiFetch<{ txHash: string }>(`/escrow/${questionId}/refund`, { method: 'POST' });

export type ChainJob = {
  asker: string;
  verifier: string;
  amountUsdc: number;
  deadline: number;
  status: string;
  evidenceHash: string;
};

/** The chain's own view, for when it disagrees with ours. */
export const readChainJob = (questionId: string) =>
  apiFetch<{ job: ChainJob | null }>(`/escrow/${questionId}/job`);
