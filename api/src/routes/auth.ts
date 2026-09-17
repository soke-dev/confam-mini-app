import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { storage } from '../storage.js';
import { usdcBalanceOf, tokenBalanceOf } from '../chain.js';
import { ngnRate } from '../rates.js';
import { syncDeposits } from '../deposits.js';
import { authenticate } from '../auth.js';
import { one, query } from '../db.js';

export const authRouter: Router = Router();

/**
 * Who am I, and what does this server already know about me.
 *
 * Called once after Privy login. It is what turns a Privy session into an Ask
 * Nearby account: `authenticate` creates the local row on first sight, so this
 * endpoint doubles as registration without a separate signup step.
 */
authRouter.get('/me', authenticate, async (req, res) => {
  const user = req.user!;

  const profile = await one<{
    username: string | null;
    displayName: string;
    avatarUrl: string | null;
    homeArea: string | null;
    homeState: string | null;
    onboardedAt: string | null;
    alertJobsNearby: boolean;
    alertQuestionTaken: boolean;
    alertEvidenceBack: boolean;
    alertPayments: boolean;
    alertReviews: boolean;
    alertProductNews: boolean;
    answersPublicByDefault: boolean;
  }>(
    `SELECT username,
            display_name  AS "displayName",
            avatar_url    AS "avatarUrl",
            home_area     AS "homeArea",
            home_state    AS "homeState",
            onboarded_at  AS "onboardedAt",
            alert_jobs_nearby         AS "alertJobsNearby",
            alert_question_taken      AS "alertQuestionTaken",
            alert_evidence_back       AS "alertEvidenceBack",
            alert_payments            AS "alertPayments",
            alert_reviews             AS "alertReviews",
            alert_product_news        AS "alertProductNews",
            answers_public_by_default AS "answersPublicByDefault"
       FROM profiles WHERE user_id = $1`,
    [user.id],
  );

  const identity = await one<{ status: string; verifiedName: string | null }>(
    `SELECT status, verified_name AS "verifiedName"
       FROM identity_checks
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [user.id],
  );

  res.json({
    id: user.id,
    email: user.email,
    wallet: user.walletAddress ? { address: user.walletAddress, chain: 'base' } : null,
    profile: {
      username: profile?.username ?? null,
      // Only ever what KYC returned. There is no user-editable name.
      name: identity?.status === 'verified' ? identity.verifiedName : null,
      avatarUrl: profile?.avatarUrl ?? null,
      homeArea: profile?.homeArea ?? null,
      homeState: profile?.homeState ?? null,
    },
    identity: { status: identity?.status ?? 'unverified' },
    onboarded: Boolean(profile?.onboardedAt),
    preferences: {
      jobsNearby: profile?.alertJobsNearby ?? true,
      questionTaken: profile?.alertQuestionTaken ?? true,
      evidenceBack: profile?.alertEvidenceBack ?? true,
      payments: profile?.alertPayments ?? true,
      reviews: profile?.alertReviews ?? true,
      productNews: profile?.alertProductNews ?? false,
      answersPublicByDefault: profile?.answersPublicByDefault ?? true,
    },
  });
});

/** Claims a username. Case-insensitive unique, so two people cannot share one. */
authRouter.patch('/me', authenticate, async (req, res) => {
  const user = req.user!;
  const body = req.body as {
    username?: unknown;
    homeArea?: unknown;
    homeState?: unknown;
    homeCountry?: unknown;
  };

  const patch: {
    username?: string;
    homeArea?: string;
    homeState?: string;
    homeCountry?: string;
  } = {};

  if (body.username !== undefined) {
    const username = String(body.username)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 20);
    if (username.length < 3) {
      res.status(400).json({ error: 'username_too_short' });
      return;
    }
    patch.username = username;
  }
  if (typeof body.homeArea === 'string') patch.homeArea = body.homeArea.slice(0, 120);
  if (typeof body.homeCountry === 'string') patch.homeCountry = body.homeCountry.slice(0, 80);
  if (typeof body.homeState === 'string') patch.homeState = body.homeState.slice(0, 120);

  try {
    await query(
      `UPDATE profiles
          SET username     = COALESCE($2, username),
              home_area    = COALESCE($3, home_area),
              home_state   = COALESCE($4, home_state),
              home_country = COALESCE($5, home_country),
              onboarded_at = COALESCE(onboarded_at, now()),
              updated_at   = now()
        WHERE user_id = $1`,
      [
        user.id,
        patch.username ?? null,
        patch.homeArea ?? null,
        patch.homeState ?? null,
        patch.homeCountry ?? null,
      ],
    );
  } catch (error) {
    // 23505 is unique_violation — the only failure a caller can act on.
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      res.status(409).json({ error: 'username_taken' });
      return;
    }
    throw error;
  }

  res.json({ ok: true, username: patch.username ?? null });
});

/**
 * Marks the first-run sheet as done, including when it was skipped.
 *
 * Skipping is a real outcome, not an absence of one — without recording it the
 * sheet would reappear on every launch for anyone who chose "Not now".
 */
authRouter.post('/onboarded', authenticate, async (req, res) => {
  await query(
    `UPDATE profiles SET onboarded_at = COALESCE(onboarded_at, now()) WHERE user_id = $1`,
    [req.user!.id],
  );
  res.json({ ok: true });
});

/**
 * Profile pictures.
 *
 * Held in memory rather than streamed to disk because every upload is resized
 * before it is stored — a 6MB phone photo has no business being a 96px avatar,
 * and on Nigerian mobile data the difference is the whole experience.
 */
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

authRouter.post('/avatar', authenticate, avatarUpload.single('avatar'), async (req, res) => {
  const user = req.user!;
  const file = req.file;

  if (!file) {
    res.status(400).json({ error: 'no_file' });
    return;
  }
  if (!file.mimetype.startsWith('image/')) {
    res.status(400).json({ error: 'not_an_image' });
    return;
  }

  let resized: Buffer;
  try {
    /**
     * Re-encoded, not just resized. Decoding and re-emitting the pixels drops
     * everything that was wrapped around them — EXIF GPS coordinates most of
     * all. People photograph themselves at home, and a profile picture that
     * carries the coordinates of that home is a safety problem on an app that
     * sends strangers to addresses.
     */
    resized = await sharp(file.buffer)
      .rotate() // apply EXIF orientation before it is discarded
      .resize(512, 512, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    res.status(400).json({ error: 'unreadable_image' });
    return;
  }

  const stored = await storage.put(resized, 'image/jpeg');
  const url = storage.urlFor(stored.key);

  await query(`UPDATE profiles SET avatar_url = $2, updated_at = now() WHERE user_id = $1`, [
    user.id,
    url,
  ]);

  res.json({ ok: true, url });
});

/**
 * Updates one or more settings.
 *
 * Every field is optional and only what is sent is written, so a toggle can
 * post just itself. That matters because these save on flip rather than behind
 * a Save button: two toggles flipped quickly must not have the first one's
 * stale copy of the second overwrite it.
 */
const PREFERENCE_COLUMNS: Record<string, string> = {
  jobsNearby: 'alert_jobs_nearby',
  questionTaken: 'alert_question_taken',
  evidenceBack: 'alert_evidence_back',
  payments: 'alert_payments',
  reviews: 'alert_reviews',
  productNews: 'alert_product_news',
  answersPublicByDefault: 'answers_public_by_default',
};

authRouter.patch('/preferences', authenticate, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const sets: string[] = [];
  const values: unknown[] = [req.user!.id];

  for (const [key, column] of Object.entries(PREFERENCE_COLUMNS)) {
    if (typeof body[key] !== 'boolean') continue;
    values.push(body[key]);
    // Column names come from the map above, never from the request, so the
    // interpolation here cannot be influenced by the caller.
    sets.push(`${column} = $${values.length}`);
  }

  if (sets.length === 0) {
    res.status(400).json({ error: 'nothing_to_update' });
    return;
  }

  await query(
    `UPDATE profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`,
    values,
  );

  res.json({ ok: true, updated: sets.length });
});

/**
 * The wallet ledger and the numbers derived from it.
 *
 * Everything is computed from `wallet_entries` rather than stored as running
 * totals. A denormalised balance is a second source of truth that drifts the
 * first time a write half-applies, and this is money: the ledger is the
 * account, and every figure here is a fold over it.
 */
authRouter.get('/wallet', authenticate, async (req, res) => {
  const userId = req.user!.id;

  const entries = await query<{
    id: string;
    kind: string;
    amountKobo: number;
    pending: boolean;
    amountUsdc: number | null;
    txHash: string | null;
    memo: string | null;
    createdAt: string;
    question: string | null;
  }>(
    `SELECT w.id,
            w.kind::text     AS kind,
            w.amount_kobo    AS "amountKobo",
            w.amount_usdc    AS "amountUsdc",
            w.tx_hash        AS "txHash",
            w.pending,
            w.memo,
            w.created_at     AS "createdAt",
            q.body           AS question
       FROM wallet_entries w
       LEFT JOIN questions q ON q.id = w.question_id
      WHERE w.user_id = $1
      ORDER BY w.created_at DESC
      LIMIT 200`,
    [userId],
  );

  const [totals] = await query<{
    earnedKobo: number;
    depositedUsdc: number;
    jobsDone: number;
    questionsAsked: number;
  }>(
    `SELECT
       COALESCE((SELECT sum(amount_kobo) FROM wallet_entries
                  WHERE user_id = $1 AND kind = 'earning' AND NOT pending), 0) AS "earnedKobo",
       COALESCE((SELECT sum(amount_usdc) FROM wallet_entries
                  WHERE user_id = $1 AND kind = 'deposit' AND NOT pending), 0) AS "depositedUsdc",
       (SELECT count(*) FROM tasks
         WHERE verifier_id = $1 AND status = 'confirmed')                      AS "jobsDone",
       (SELECT count(*) FROM questions WHERE asker_id = $1)                    AS "questionsAsked"`,
    [userId],
  );

  /**
   * Money out is anything that leaves the wallet: a bounty held, a tip sent,
   * the platform's cut, a withdrawal to another address.
   *
   * This list used to name only holds and tips, which meant a fee *added* to
   * the balance and a withdrawal made you richer. Both are outflows, and the
   * omission was worth real money in the wrong direction.
   */
  const OUTFLOWS = new Set(['hold', 'tip', 'fee', 'withdrawal']);

  // Pending entries are excluded — money that has not settled is not
  // spendable, and showing it as available is how someone tries to withdraw
  // what is not there.
  const balanceKobo = entries
    .filter((e) => !e.pending)
    .reduce((sum, e) => (OUTFLOWS.has(e.kind) ? sum - e.amountKobo : sum + e.amountKobo), 0);

  res.json({
    balanceKobo,
    earnedKobo: totals?.earnedKobo ?? 0,
    // Dollars, because a top-up arrives in USDC. Summing its naira value
    // would give a figure that changes with the exchange rate.
    depositedUsdc: totals?.depositedUsdc ?? 0,
    jobsDone: totals?.jobsDone ?? 0,
    questionsAsked: totals?.questionsAsked ?? 0,
    entries,
  });
});

/**
 * The real, on-chain USDC balance.
 *
 * Separate from /auth/wallet because the two answer different questions and
 * fail independently. /auth/wallet is the internal ledger — what this app owes
 * and holds — and it is always available. This is the chain, which can be slow
 * or rate-limited, and folding it into the same response would mean an RPC
 * hiccup took the ledger down with it.
 */
authRouter.get('/balance', authenticate, async (req, res) => {
  const address = req.user!.walletAddress;

  if (!address) {
    res.json({ address: null, usdc: 0, blockNumber: null, status: 'no_wallet' });
    return;
  }

  /**
   * Which chain to count on, said by the client rather than guessed here.
   *
   * The caller is the only one that knows: the mini app runs inside a wallet
   * host offering Polygon, the phone app has an embedded wallet on Base, and
   * both present the same kind of session. Inferring it from the credential
   * would be a rule that happens to hold today and silently misreports the
   * day somebody signs into the web app with a wallet that is on Base.
   *
   * Anything unrecognised falls back to Base, which is this server's chain.
   */
  const chain = req.query.chain === 'polygon' ? 'polygon' : 'base';

  try {
    // The rate must never take the balance down with it, so a failure here
    // resolves to null rather than rejecting.
    const [balance, rate] = await Promise.all([tokenBalanceOf(address, chain), ngnRate()]);

    res.json({
      address,
      /*
       * `amount` and `token` are the honest pair. `usdc` is kept beside them
       * because shipped copies of the app read it, and it carries the same
       * number — but a field called usdc holding USDT would be exactly the
       * kind of quiet lie that survives review, so anything new reads
       * `amount` and labels it with `token`.
       */
      amount: balance.usdc,
      token: balance.token,
      chain: balance.chain,
      usdc: balance.usdc,
      raw: balance.raw,
      blockNumber: balance.blockNumber,
      cached: balance.cached,
      ngnPerUsd: rate?.ngnPerUsd ?? null,
      rateUpdatedAt: rate?.updatedAt ?? null,
      status: 'ok',
    });
  } catch (error) {
    // Reported as unreadable rather than as zero. A zero here would be a claim
    // about someone's money that we are in no position to make.
    res.status(503).json({
      address,
      usdc: null,
      status: 'unreachable',
      detail: error instanceof Error ? error.message : 'RPC failed',
    });
  }
});

/**
 * Reads Base for deposits and records any that are new.
 *
 * Safe to call as often as the client likes: the unique index on
 * (tx_hash, log_index) means a transfer already recorded is skipped by the
 * database rather than double-credited.
 */
authRouter.post('/deposits/sync', authenticate, async (req, res) => {
  const address = req.user!.walletAddress;
  if (!address) {
    res.json({ scannedTo: null, found: 0, inserted: 0, moreToScan: false, status: 'no_wallet' });
    return;
  }

  try {
    const result = await syncDeposits(req.user!.id, address);
    res.json({ ...result, status: 'ok' });
  } catch (error) {
    res.status(503).json({
      status: 'rpc_failed',
      detail: error instanceof Error ? error.message : 'chain unreachable',
    });
  }
});
