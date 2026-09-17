import { Router } from 'express';
import { authenticate } from '../auth.js';
import { one, query, transaction } from '../db.js';
import { hasEscrow } from '../config.js';
import { usdcBalanceOf, tokenBalanceOf } from '../chain.js';
import { ngnRate } from '../rates.js';
import { storage } from '../storage.js';
import { notify, nearbyVerifiers } from '../push.js';
import { LATEST_EVIDENCE, evidenceUrls } from '../evidenceSql.js';

export const questionsRouter: Router = Router();

/** Mirrors MIN_TIP / MAX_TIP in constants/money.ts. */
const MIN_TIP_NGN = 20;
const MAX_TIP_NGN = 20_000;

/**
 * The Ask and Earn loop, against the database.
 *
 * Money is still moved by ledger rows here rather than by the escrow
 * contract. The interfaces are shaped so that swapping them over is a change
 * of implementation and not of API: `hold` becomes `fund`, `earning` becomes
 * `release`, and the routes keep their names.
 */

const CATEGORIES = [
  'housing',
  'traffic',
  'fuel',
  'food',
  'shopping',
  'safety',
  'other',
] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * Guesses a category from the wording.
 *
 * Only used to colour-code a card, so being wrong is cosmetic. It is a keyword
 * match rather than a model call because a category is not worth a round trip.
 *
 * Housing is tested first: "is the road to the flat passable" is about the
 * flat, and the later traffic and safety patterns would both claim it.
 * Unmatched questions fall to 'other' rather than 'shopping' — that was a
 * stand-in for "no idea", and labelling an unknown question as shopping told
 * the board something we had not worked out.
 */
function categorise(body: string): Category {
  const text = body.toLowerCase();
  if (/rent|house|housing|apartment|flat|self[- ]?con|landlord|agent|room|accommodation|lodge/.test(text)) {
    return 'housing';
  }
  if (/traffic|road|go[- ]?slow|flood|bridge|route|jam|toll/.test(text)) return 'traffic';
  if (/fuel|petrol|diesel|filling|nnpc|queue at the pump/.test(text)) return 'fuel';
  if (/food|restaurant|eat|menu|jollof|buka|canteen/.test(text)) return 'food';
  if (/market|shop|store|price|buy|supermarket|mall|stock/.test(text)) return 'shopping';
  if (/safe|police|crowd|protest|okada|secure/.test(text)) return 'safety';
  return 'other';
}

/** "in 25m", "in 3h" — how long a job has left. */
function minutesLeft(dispatchedAt: Date | null, deadlineMinutes: number): number {
  if (!dispatchedAt) return deadlineMinutes;
  const elapsed = (Date.now() - dispatchedAt.getTime()) / 60_000;
  return Math.max(0, Math.round(deadlineMinutes - elapsed));
}

function ago(when: Date): string {
  const minutes = Math.max(1, Math.round((Date.now() - when.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Dispatches a question: creates it, and holds the bounty.
 *
 * Both in one transaction. A question that exists without its hold is a job
 * somebody could take with no money behind it; a hold without a question is
 * money taken for nothing.
 */
questionsRouter.post('/', authenticate, async (req, res) => {
  const user = req.user!;
  const body = req.body as {
    text?: unknown;
    placeName?: unknown;
    area?: unknown;
    state?: unknown;
    lat?: unknown;
    lng?: unknown;
    bounty?: unknown;
    deadlineMinutes?: unknown;
    visibility?: unknown;
    verifiedOnly?: unknown;
  };

  const text = String(body.text ?? '').trim();
  const bounty = Number(body.bounty);
  const deadlineMinutes = Number(body.deadlineMinutes);

  if (text.length < 5) {
    res.status(400).json({ error: 'question_too_short', detail: 'Say a little more.' });
    return;
  }
  if (!Number.isFinite(bounty) || bounty <= 0) {
    res.status(400).json({ error: 'bad_bounty' });
    return;
  }
  if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) {
    res.status(400).json({ error: 'bad_deadline' });
    return;
  }

  /**
   * Can they actually pay for this?
   *
   * Checked against the chain, not the ledger. Funding a job pulls USDC out of
   * the asker's wallet with an EIP-3009 authorisation, so what matters is what
   * that wallet holds — a ledger balance is our own bookkeeping and cannot
   * make a transfer succeed. Without this, dispatch writes a hold, drives the
   * balance negative, and puts a job on the board that can never be funded;
   * somebody would walk to a filling station for a bounty that never existed.
   */
  const bountyKobo = Math.round(bounty * 100);

  if (hasEscrow()) {
    if (!user.walletAddress) {
      res.status(400).json({
        error: 'no_wallet',
        detail: 'Your wallet is still being created. Try again in a moment.',
      });
      return;
    }

    /**
     * Which chain holds the money that will pay for this.
     *
     * Said by the client for the same reason as everywhere else: it is the one
     * holding the wallet. A mini app asker's balance is USDT on Polygon, and
     * checking Base would refuse every question they ever ask against a zero
     * belonging to an account they have never used.
     */
    const fundingChain = req.query.chain === 'polygon' ? 'polygon' : 'base';

    const [balance, rate, committed] = await Promise.all([
      tokenBalanceOf(user.walletAddress, fundingChain),
      ngnRate(),
      /**
       * Bounties already promised but not yet locked on chain.
       *
       * Those questions will draw on the same USDC, so they have to come off
       * the available figure — otherwise two questions dispatched in quick
       * succession both pass the check and only one of them can ever fund.
       */
      query<{ kobo: number }>(
        `SELECT COALESCE(SUM(bounty_kobo), 0)::bigint AS kobo
           FROM questions
          WHERE asker_id = $1 AND closed_at IS NULL AND chain_job_id IS NULL`,
        [user.id],
      ),
    ]);

    if (!rate) {
      res.status(503).json({
        error: 'no_rate',
        detail: 'The exchange rate is unavailable, so we cannot price this yet.',
      });
      return;
    }

    const committedKobo = committed[0]?.kobo ?? 0;
    const neededUsdc = (bountyKobo + committedKobo) / 100 / rate.ngnPerUsd;

    if (balance.usdc < neededUsdc) {
      const shortfallNaira = Math.ceil((neededUsdc - balance.usdc) * rate.ngnPerUsd);
      res.status(402).json({
        error: 'insufficient_funds',
        detail:
          committedKobo > 0
            ? `You have ${balance.usdc.toFixed(2)} ${balance.token}, and ₦${(committedKobo / 100).toLocaleString()} is already promised to other questions. Top up about ₦${shortfallNaira.toLocaleString()}.`
            : `You have ${balance.usdc.toFixed(2)} ${balance.token}. This costs about ${neededUsdc.toFixed(2)} ${balance.token} — top up around ₦${shortfallNaira.toLocaleString()}.`,
        availableUsdc: balance.usdc,
        requiredUsdc: Number(neededUsdc.toFixed(6)),
      });
      return;
    }
  }

  const placeName = String(body.placeName ?? '').trim() || 'Somewhere nearby';
  const area = String(body.area ?? '').trim() || null;
  const state = String(body.state ?? '').trim() || null;

  try {
    const created = await transaction(async (client) => {
      const place = await client.query<{ id: string }>(
        `INSERT INTO places (provider, name, area, state, lat, lng)
         VALUES ('app', $1, $2, $3, $4, $5) RETURNING id`,
        [
          placeName,
          area,
          state,
          Number.isFinite(Number(body.lat)) ? Number(body.lat) : null,
          Number.isFinite(Number(body.lng)) ? Number(body.lng) : null,
        ],
      );

      /**
       * Dispatched only once the money is locked.
       *
       * `dispatched_at` is what puts a question on the Earn board, and with an
       * escrow contract configured it stays null until fund() succeeds. Setting
       * it here would advertise a job whose bounty is not committed — somebody
       * could post one, decline the signature, and let a verifier walk to a
       * filling station for money that was never taken from anybody.
       *
       * Without a contract there is nothing to wait for, so it dispatches
       * immediately and the ledger hold is the only commitment there is.
       */
      const question = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO questions
           (asker_id, body, place_id, bounty_kobo, visibility, deadline_minutes,
            verified_only, dispatched_at)
         VALUES ($1, $2, $3, $4, $5::visibility, $6, $7,
                 CASE WHEN $8::boolean THEN NULL ELSE now() END)
         RETURNING id, created_at`,
        [
          user.id,
          text,
          place.rows[0]!.id,
          Math.round(bounty * 100),
          body.visibility === 'private' ? 'private' : 'public',
          Math.round(deadlineMinutes),
          Boolean(body.verifiedOnly),
          hasEscrow(),
        ],
      );

      /**
       * The ledger hold, for the database-only path.
       *
       * With a contract, the hold is written when fund() confirms — recording
       * it here would show money committed before any left the wallet, and a
       * declined signature would leave a hold against nothing.
       */
      if (!hasEscrow()) {
        await client.query(
          `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
           VALUES ($1, 'hold', $2, $3, $4)`,
          [user.id, Math.round(bounty * 100), question.rows[0]!.id, `Held for: ${text.slice(0, 80)}`],
        );
      }

      return question.rows[0]!;
    });

    res.status(201).json({
      id: created.id,
      createdAt: created.created_at,
      // The app must fund before this becomes a job anybody can see.
      needsFunding: hasEscrow(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'dispatch_failed',
      detail: error instanceof Error ? error.message : 'Could not send the question.',
    });
  }
});

/** The asker's own questions, with whatever has happened to each. */
questionsRouter.get('/mine', authenticate, async (req, res) => {
  const rows = await query(
    `SELECT q.id,
            q.body                AS text,
            q.bounty_kobo         AS "bountyKobo",
            q.deadline_minutes    AS "deadlineMinutes",
            q.created_at          AS "createdAt",
            q.dispatched_at       AS "dispatchedAt",
            q.closed_at           AS "closedAt",
            q.verified_only       AS "verifiedOnly",
            q.visibility::text    AS visibility,
            p.name                AS "placeName",
            p.area, p.state,
            t.id                  AS "taskId",
            t.status::text        AS "taskStatus",
            v.username            AS "verifierName",
            a.body                AS answer,
            e.kind::text          AS "evidenceKind",
            e.keys                AS "evidenceKeys",
            e.distance_metres     AS "distanceMetres",
            d.status::text        AS "disputeStatus",
            sa.verdict::text      AS "sentPastCheck"
       FROM questions q
       LEFT JOIN places p   ON p.id = q.place_id
       LEFT JOIN tasks t    ON t.question_id = q.id
       LEFT JOIN profiles v ON v.user_id = t.verifier_id
       LEFT JOIN LATERAL (
         SELECT body FROM answers WHERE task_id = t.id ORDER BY submitted_at DESC LIMIT 1
       ) a ON TRUE
       ${LATEST_EVIDENCE}
       LEFT JOIN disputes d ON d.question_id = q.id
       /*
        * Whether the verifier sent this over a check that objected, and how
        * loudly it objected — 'warn', 'fail', or null for a clean pass.
        *
        * The asker is the one being asked to accept the answer, so they are
        * the one who has to be told the machine had a problem with it. Without
        * this the override would be invisible to everybody except the desk,
        * which is the wrong half of the audience.
        */
       LEFT JOIN LATERAL (
         SELECT verdict FROM submission_attempts
          WHERE task_id = t.id AND overridden
          ORDER BY attempt DESC LIMIT 1
       ) sa ON TRUE
      WHERE q.asker_id = $1
      ORDER BY q.created_at DESC
      LIMIT 100`,
    [req.user!.id],
  );

  res.json({
    questions: rows.map((r) => ({
      ...r,
      // A path the app can load. Without it the asker is asked to judge
      // evidence they cannot see.
      /**
       * Every file from the attempt, plus the first of them on its own.
       *
       * `evidenceUrl` stays because a card, a thumbnail and a share sheet all
       * want one representative image and should not each pick their own. The
       * array is what the viewer opens, so two photos sent are two photos seen.
       */
      evidenceUrls: evidenceUrls(r.evidenceKeys),
      evidenceUrl: evidenceUrls(r.evidenceKeys)[0] ?? null,
      minutesLeft: minutesLeft(r.dispatchedAt as Date | null, r.deadlineMinutes as number),
    })),
  });
});

/**
 * Open jobs somebody could take.
 *
 * Never your own questions: paying yourself to answer yourself is the
 * simplest way to launder a bounty, and it is meaningless besides.
 */
questionsRouter.get('/nearby', authenticate, async (req, res) => {
  const area = typeof req.query.area === 'string' ? req.query.area : '';

  const rows = await query(
    `SELECT q.id,
            q.body             AS text,
            q.bounty_kobo      AS "bountyKobo",
            q.deadline_minutes AS "deadlineMinutes",
            q.dispatched_at    AS "dispatchedAt",
            q.verified_only    AS "verifiedOnly",
            p.name             AS "placeName",
            p.area, p.state,
            asker.username     AS "askerName"
       FROM questions q
       LEFT JOIN places p       ON p.id = q.place_id
       LEFT JOIN profiles asker ON asker.user_id = q.asker_id
       LEFT JOIN tasks t        ON t.question_id = q.id
      WHERE q.asker_id <> $1
        AND q.closed_at IS NULL
        AND q.dispatched_at IS NOT NULL
        AND t.id IS NULL
        AND q.dispatched_at + (q.deadline_minutes || ' minutes')::interval > now()
        AND ($2 = '' OR p.area ILIKE $2)
      ORDER BY q.dispatched_at DESC
      LIMIT 50`,
    [req.user!.id, area],
  );

  res.json({
    jobs: rows.map((r) => ({
      ...r,
      category: categorise(String(r.text)),
      minutesLeft: minutesLeft(r.dispatchedAt as Date | null, r.deadlineMinutes as number),
    })),
  });
});

/**
 * Jobs this person has taken.
 *
 * A separate list from /nearby, which deliberately excludes anything already
 * claimed — so the moment somebody accepts, the job leaves that list. Without
 * this route it leaves their app entirely: accepted, paid for, and invisible
 * to the only person who can deliver it.
 */
questionsRouter.get('/taken', authenticate, async (req, res) => {
  const rows = await query(
    `SELECT q.id,
            q.body             AS text,
            q.bounty_kobo      AS "bountyKobo",
            q.deadline_minutes AS "deadlineMinutes",
            q.dispatched_at    AS "dispatchedAt",
            q.verified_only    AS "verifiedOnly",
            p.name             AS "placeName",
            p.area, p.state,
            asker.username     AS "askerName",
            t.id               AS "taskId",
            t.status::text     AS "taskStatus",
            t.accepted_at      AS "acceptedAt",
            t.claim_tx         AS "claimTx",
            q.chain_job_id     AS "chainJobId",
            a.body             AS answer
       FROM tasks t
       JOIN questions q         ON q.id = t.question_id
       LEFT JOIN places p       ON p.id = q.place_id
       LEFT JOIN profiles asker ON asker.user_id = q.asker_id
       LEFT JOIN LATERAL (
         SELECT body FROM answers WHERE task_id = t.id ORDER BY submitted_at DESC LIMIT 1
       ) a ON TRUE
      WHERE t.verifier_id = $1
      ORDER BY t.accepted_at DESC
      LIMIT 50`,
    [req.user!.id],
  );

  res.json({
    jobs: rows.map((r) => ({
      ...r,
      category: categorise(String(r.text)),
      minutesLeft: minutesLeft(r.dispatchedAt as Date | null, r.deadlineMinutes as number),
    })),
  });
});

/** Recently answered public questions, for the Ask tab's feed. */
questionsRouter.get('/answered', authenticate, async (_req, res) => {
  const rows = await query(
    `SELECT q.id,
            q.body           AS text,
            -- The name as well as the area: OSM puts the locality in one or
            -- the other depending on the place, so matching "Surulere" against
            -- area alone never hits.
            p.name           AS "placeName",
            p.area, p.state,
            e.kind::text     AS proof,
            t.status::text   AS "taskStatus",
            t.submitted_at   AS "submittedAt"
       FROM questions q
       JOIN tasks t     ON t.question_id = q.id
       LEFT JOIN places p ON p.id = q.place_id
       LEFT JOIN LATERAL (
         SELECT kind FROM evidence WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
       ) e ON TRUE
      WHERE q.visibility = 'public'
        AND t.submitted_at IS NOT NULL
      ORDER BY t.submitted_at DESC
      LIMIT 20`,
  );

  res.json({
    answered: rows.map((r) => ({
      id: r.id,
      text: r.text,
      area: r.area ?? '',
      state: r.state ?? '',
      proof: (r.proof as string) === 'video' ? 'video' : 'photo',
      confirmed: r.taskStatus === 'confirmed',
      ago: ago(r.submittedAt as Date),
    })),
  });
});

/**
 * Takes a job.
 *
 * The unique constraint on tasks.question_id is what actually enforces one
 * verifier per question — two people tapping at the same moment race here,
 * and the database decides, not the order the requests happened to arrive in.
 */
/**
 * How close counts as being there, in metres.
 *
 * Ikeja to Surulere is about 12.5km, and those are the two the rule has to
 * separate — so anything near that is no rule at all. 5km is wide enough that
 * a phone with a poor fix in a built-up area is not turned away, and narrow
 * enough that it means the neighbourhood rather than the city.
 */
const ACCEPT_RADIUS_M = 5_000;

/** Haversine. Good to a few metres at these distances, and needs no PostGIS. */
function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

questionsRouter.post('/:id/accept', authenticate, async (req, res) => {
  const user = req.user!;

  const question = await one<{
    askerId: string;
    verifiedOnly: boolean;
    closedAt: Date | null;
    placeText: string;
    placeLat: number | null;
    placeLng: number | null;
  }>(
    /*
     * Name, area and state together, because which of the three carries the
     * locality depends on where the place came from. OSM returns a coarse
     * area and puts the specific part in the name — the Surulere job is
     * stored as area "Lagos", name "Surulere" — so matching on `area` alone
     * would let somebody in Benin through on a Lagos job.
     */
    `SELECT q.asker_id AS "askerId", q.verified_only AS "verifiedOnly", q.closed_at AS "closedAt",
            lower(concat_ws(' ', p.name, p.area, p.state)) AS "placeText",
            p.lat AS "placeLat", p.lng AS "placeLng"
       FROM questions q
       LEFT JOIN places p ON p.id = q.place_id
      WHERE q.id = $1`,
    [req.params.id],
  );

  if (!question) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (question.askerId === user.id) {
    res.status(400).json({ error: 'own_question', detail: 'You cannot take your own question.' });
    return;
  }
  if (question.closedAt) {
    res.status(409).json({ error: 'closed', detail: 'That question is closed.' });
    return;
  }

  /**
   * You have to actually be there.
   *
   * This was a check against the area on your profile, which is a claim, not a
   * position — somebody in Ikeja could take a Surulere job by having typed
   * Surulere once during onboarding. Where the phone says it is at the moment
   * of taking the job is the only version of this that means anything.
   *
   * Accepting is the commitment, so it is the right gate: the deadline starts
   * here, and every minute a job is held by somebody who was never going to
   * arrive is a minute the asker is not getting an answer and nobody else can
   * take it either.
   */
  const { lat, lng, where } = req.body ?? {};
  const here =
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng }
      : null;

  if (!here) {
    res.status(400).json({
      error: 'location_required',
      detail: 'Turn on location so we can check you are near this place.',
    });
    return;
  }

  if (question.placeLat !== null && question.placeLng !== null) {
    const away = metresBetween(here, { lat: question.placeLat, lng: question.placeLng });

    /**
     * A place can be a point or an area, and the radius only suits one.
     *
     * "NNPC Ikeja" is a forecourt and 5km around it means what it says.
     * "Oredo" is a local government area some 20km across, stored as its
     * centroid — so somebody standing in Oredo measured 11km from Oredo and
     * was refused a job they were plainly at.
     *
     * The distance test is kept for the places it fits, and the name of where
     * the phone says it is answers for the rest. Both come from the same GPS
     * fix, so this admits nobody the radius would have kept out for real:
     * faking the area means faking the coordinates it was derived from.
     */
    const inTheArea =
      typeof where === 'string' &&
      where.trim().length > 0 &&
      question.placeText
        .split(/[\s,]+/)
        .filter((word) => word.length > 3)
        .some((word) => where.toLowerCase().includes(word));

    if (away > ACCEPT_RADIUS_M && !inTheArea) {
      const km = Math.round(away / 100) / 10;
      res.status(403).json({
        error: 'too_far',
        detail: `You are about ${km}km away. You have to be at the place to take this one.`,
      });
      return;
    }
  }

  if (question.verifiedOnly) {
    const identity = await one<{ status: string }>(
      `SELECT status FROM identity_checks WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    if (identity?.status !== 'verified') {
      res.status(403).json({
        error: 'verification_required',
        detail: 'This one is for verified people only.',
      });
      return;
    }
  }

  try {
    const task = await one<{ id: string }>(
      `INSERT INTO tasks (question_id, verifier_id) VALUES ($1, $2) RETURNING id`,
      [req.params.id, user.id],
    );
    res.status(201).json({ taskId: task?.id });

    /**
     * Told after the response, never before it.
     *
     * The verifier is standing in the street waiting to know whether the job
     * is theirs; making them wait on Expo's servers to find out would be a
     * poor trade for a notification going to somebody else entirely.
     */
    void (async () => {
      const q = await one<{ askerId: string; body: string }>(
        `SELECT asker_id AS "askerId", body FROM questions WHERE id = $1`,
        [req.params.id],
      );
      const who = await one<{ username: string | null }>(
        `SELECT username FROM profiles WHERE user_id = $1`,
        [user.id],
      );
      if (!q) return;
      await notify({
        userId: q.askerId,
        kind: 'job',
        title: 'Somebody is on it',
        body: `${who?.username ?? 'A verifier'} took: ${q.body.slice(0, 60)}`,
        href: `/tracking/${req.params.id}`,
      });
    })();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      res.status(409).json({ error: 'already_taken', detail: 'Somebody just took this one.' });
      return;
    }
    throw error;
  }
});

/**
 * Pays a verifier again for work they already did.
 *
 * Reached from the screen that hands somebody an existing answer instead of
 * sending anybody. That answer cost its original asker ₦500 and cost the
 * verifier a walk; the person reading it now pays neither. A tip is the only
 * thing in the app that pays for evidence after the fact, which is what makes
 * old evidence worth taking well rather than just well enough.
 *
 * Two rows, not a transfer. `tip` is an outflow and `earning` an inflow in the
 * same ledger the rest of the app reads, so this needs no new concept and
 * cannot disagree with the balance shown everywhere else.
 */
questionsRouter.post('/:id/tip', authenticate, async (req, res) => {
  const user = req.user!;
  const naira = Number((req.body as { amountNgn?: unknown }).amountNgn);

  if (!Number.isFinite(naira) || naira < MIN_TIP_NGN || naira > MAX_TIP_NGN) {
    res.status(400).json({
      error: 'bad_amount',
      detail: `A tip is between ₦${MIN_TIP_NGN} and ₦${MAX_TIP_NGN}.`,
    });
    return;
  }
  const kobo = Math.round(naira * 100);

  const job = await one<{ verifierId: string | null; verifier: string | null; status: string | null }>(
    `SELECT t.verifier_id AS "verifierId", p.username AS verifier, t.status::text AS status
       FROM questions q
       LEFT JOIN tasks t    ON t.question_id = q.id
       LEFT JOIN profiles p ON p.user_id = t.verifier_id
      WHERE q.id = $1 AND q.visibility = 'public'`,
    [req.params.id],
  );

  if (!job?.verifierId) {
    res.status(404).json({ error: 'nobody_to_tip', detail: 'No verifier answered this.' });
    return;
  }
  if (job.status !== 'submitted' && job.status !== 'confirmed') {
    res.status(409).json({ error: 'not_answered', detail: 'Nothing has been delivered yet.' });
    return;
  }
  /**
   * Refused rather than quietly allowed.
   *
   * Two rows against one account net to nothing, so the money would be fine
   * and the wallet history would show a tip that never left — which reads to
   * everybody, later, as evidence that somebody was paid.
   */
  if (job.verifierId === user.id) {
    res.status(400).json({ error: 'self_tip', detail: 'You cannot tip yourself.' });
    return;
  }

  /**
   * Checked against the same arithmetic the wallet screen uses.
   *
   * A tip is spending, and spending past the balance would put the ledger
   * negative — a state nothing else in the app can produce and nothing
   * downstream is written to expect.
   */
  const balance = await one<{ kobo: string }>(
    `SELECT COALESCE(SUM(
              CASE WHEN kind IN ('hold','tip','fee','withdrawal')
                   THEN -amount_kobo ELSE amount_kobo END), 0)::bigint AS kobo
       FROM wallet_entries WHERE user_id = $1 AND pending = FALSE`,
    [user.id],
  );

  if (Number(balance?.kobo ?? 0) < kobo) {
    res.status(400).json({
      error: 'insufficient',
      detail: `That is more than your balance of ₦${Math.floor(Number(balance?.kobo ?? 0) / 100)}.`,
    });
    return;
  }

  const me = await one<{ username: string | null }>(
    `SELECT username FROM profiles WHERE user_id = $1`,
    [user.id],
  );

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
       VALUES ($1, 'tip', $2, $3, $4)`,
      [user.id, kobo, req.params.id, `Tip to ${job.verifier ?? 'a verifier'}`],
    );
    await client.query(
      `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
       VALUES ($1, 'earning', $2, $3, $4)`,
      [job.verifierId, kobo, req.params.id, `Tip from ${me?.username ?? 'someone'}`],
    );
  });

  res.json({ ok: true, amountNgn: naira, verifier: job.verifier });

  void notify({
    userId: job.verifierId,
    kind: 'payment',
    title: `₦${Math.round(naira)} tip`,
    body: `${me?.username ?? 'Somebody'} used your answer and tipped you for it.`,
    href: '/(tabs)/you',
  });
});

/** Submits the answer and the evidence behind it. */
questionsRouter.post('/:id/submit', authenticate, async (req, res) => {
  const user = req.user!;
  const body = req.body as {
    answer?: unknown;
    evidenceKind?: unknown;
    storageKey?: unknown;
    lat?: unknown;
    lng?: unknown;
    distanceMetres?: unknown;
  };

  const task = await one<{ id: string; status: string }>(
    `SELECT id, status::text AS status FROM tasks
      WHERE question_id = $1 AND verifier_id = $2`,
    [req.params.id, user.id],
  );

  if (!task) {
    res.status(404).json({ error: 'not_your_job' });
    return;
  }
  if (task.status !== 'accepted') {
    res.status(409).json({ error: 'already_submitted' });
    return;
  }

  const answer = String(body.answer ?? '').trim();
  if (answer.length === 0) {
    res.status(400).json({ error: 'answer_required', detail: 'Say what you saw.' });
    return;
  }

  await transaction(async (client) => {
    await client.query(`INSERT INTO answers (task_id, body) VALUES ($1, $2)`, [task.id, answer]);

    if (typeof body.storageKey === 'string' && body.storageKey.length > 0) {
      await client.query(
        `INSERT INTO evidence (task_id, kind, storage_key, captured_lat, captured_lng,
                               distance_metres, captured_at)
         VALUES ($1, $2::evidence_kind, $3, $4, $5, $6, now())`,
        [
          task.id,
          body.evidenceKind === 'video' ? 'video' : 'photo',
          body.storageKey,
          Number.isFinite(Number(body.lat)) ? Number(body.lat) : null,
          Number.isFinite(Number(body.lng)) ? Number(body.lng) : null,
          Number.isFinite(Number(body.distanceMetres)) ? Math.round(Number(body.distanceMetres)) : null,
        ],
      );
    }

    await client.query(
      `UPDATE tasks SET status = 'submitted', submitted_at = now() WHERE id = $1`,
      [task.id],
    );

    /**
     * Records that this went out over the gate's objection.
     *
     * Derived, never reported: the client sends no flag for this, and is not
     * asked to. The attempt row and its verdict were written by the gate
     * itself when it ran, so marking the newest one is a statement about what
     * this server computed rather than about what a phone claims. A modified
     * client can still skip the gate entirely — it has always been able to —
     * but it cannot make an attempt this server failed look like one it passed.
     *
     * `verdict <> 'pass'` covers the warning override too, which had gone
     * unrecorded since it was added. The verdict stays on the row, so a
     * reviewer can tell a shrugged-off warning from an ignored failure.
     */
    await client.query(
      `UPDATE submission_attempts SET overridden = TRUE
        WHERE task_id = $1
          AND verdict <> 'pass'
          AND attempt = (SELECT max(attempt) FROM submission_attempts WHERE task_id = $1)`,
      [task.id],
    );
  });

  res.json({ ok: true });

  void (async () => {
    const q = await one<{ askerId: string; body: string }>(
      `SELECT asker_id AS "askerId", body FROM questions WHERE id = $1`,
      [req.params.id],
    );
    if (!q) return;
    await notify({
      userId: q.askerId,
      kind: 'answer',
      title: 'Your answer is ready',
      body: q.body.slice(0, 70),
      href: `/tracking/${req.params.id}`,
    });
  })();
});

/**
 * The asker accepts the answer, and the verifier is paid.
 *
 * The hold placed at dispatch is not returned — it stays spent, and the
 * verifier's earning is created against it. The fee is recorded as its own
 * row so the platform's take is a line in the ledger rather than arithmetic
 * nobody can audit.
 */
questionsRouter.post('/:id/confirm', authenticate, async (req, res) => {
  const user = req.user!;

  const job = await one<{
    taskId: string;
    verifierId: string;
    bountyKobo: number;
    taskStatus: string;
  }>(
    `SELECT t.id AS "taskId", t.verifier_id AS "verifierId",
            q.bounty_kobo AS "bountyKobo", t.status::text AS "taskStatus"
       FROM questions q JOIN tasks t ON t.question_id = q.id
      WHERE q.id = $1 AND q.asker_id = $2`,
    [req.params.id, user.id],
  );

  if (!job) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (job.taskStatus === 'confirmed') {
    res.status(409).json({ error: 'already_confirmed' });
    return;
  }
  if (job.taskStatus !== 'submitted') {
    res.status(409).json({ error: 'nothing_submitted', detail: 'No answer has come back yet.' });
    return;
  }

  /**
   * The earning is the *gross* bounty and the fee is deducted beside it, so
   * the verifier's statement reads "earned ₦500, fee −₦50" and nets to ₦450.
   *
   * Recording the earning already reduced to 90% *and* a fee row deducts the
   * cut twice — which is exactly what it did, paying ₦400 on a ₦500 job.
   */
  const feeKobo = Math.round(job.bountyKobo * 0.1);
  const payoutKobo = job.bountyKobo - feeKobo;

  await transaction(async (client) => {
    await client.query(
      `UPDATE tasks SET status = 'confirmed', completed_at = now() WHERE id = $1`,
      [job.taskId],
    );
    await client.query(`UPDATE questions SET closed_at = now() WHERE id = $1`, [req.params.id]);
    await client.query(
      `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
       VALUES ($1, 'earning', $2, $3, 'Answer confirmed')`,
      [job.verifierId, job.bountyKobo, req.params.id],
    );
    // Queued inside the transaction but sent regardless of it: a push about
    // money is worth sending even if a later statement here rolls back, and
    // the ledger row is the thing that decides what was actually paid.
    void notify({
      userId: job.verifierId,
      kind: 'payment',
      title: 'You were paid',
      body: `Your answer was confirmed. ₦${Math.round(job.bountyKobo / 100)} is in your wallet.`,
      href: '/activity',
    });
    await client.query(
      `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
       VALUES ($1, 'fee', $2, $3, 'Platform fee')`,
      [job.verifierId, feeKobo, req.params.id],
    );
  });

  res.json({ ok: true, paidKobo: payoutKobo, feeKobo });
});

/**
 * Closes a question nobody delivered on, and returns the money.
 *
 * Refused once an answer has been submitted: the deadline is for *delivery*,
 * and letting an asker close after evidence arrived would be a free answer.
 */
/**
 * Puts an unanswered question back on the board with a fresh clock.
 *
 * "Keep waiting" did nothing at all — it navigated home and left the question
 * exactly as it was: past its deadline, still locked to a verifier who never
 * turned up, and invisible to everybody else because /nearby hides any
 * question that has a task row at all. Waiting was not an option, it was a
 * word on a button.
 *
 * The stale task is deleted rather than marked expired, because tasks.question_id
 * is UNIQUE — that constraint is what stops two people taking the same job, and
 * it also means a leftover row would block the next person from taking it. Only
 * ever a task with nothing to show for it: one that produced evidence is not
 * abandoned, and this route refuses to touch it.
 */
/**
 * Gives a job back, so somebody else can take it.
 *
 * Two things need this. A verifier who accepts and then thinks better of it
 * should be able to say so rather than sitting on the job until the deadline —
 * every minute they hold it is a minute the asker is not getting an answer and
 * nobody else can start. And the app calls it automatically when the "I will
 * go now" window closes untouched, because somebody who has not confirmed they
 * are setting off has not started.
 *
 * The task row is deleted rather than marked abandoned, for the same reason
 * relist deletes it: tasks.question_id is UNIQUE, and a leftover row would
 * block the next person from accepting.
 */
questionsRouter.post('/:id/abandon', authenticate, async (req, res) => {
  const user = req.user!;

  const task = await one<{ id: string; status: string; evidence: string }>(
    `SELECT t.id, t.status::text AS status,
            (SELECT count(*) FROM evidence e WHERE e.task_id = t.id)::text AS evidence
       FROM tasks t
      WHERE t.question_id = $1 AND t.verifier_id = $2`,
    [req.params.id, user.id],
  );

  if (!task) {
    res.status(404).json({ error: 'not_yours', detail: 'That job is not yours to give back.' });
    return;
  }

  /**
   * Work already done is not the verifier's to withdraw.
   *
   * Once evidence is in, the asker owes a decision on it and the bounty is
   * theirs to win — dropping the job here would throw away a walk somebody
   * already made and leave the asker with nothing to rule on.
   */
  if (Number(task.evidence) > 0 || task.status !== 'accepted') {
    res.status(409).json({
      error: 'already_started',
      detail: 'You have already sent something for this one.',
    });
    return;
  }

  await query(`DELETE FROM tasks WHERE id = $1`, [task.id]);
  res.json({ ok: true });
});

questionsRouter.post('/:id/relist', authenticate, async (req, res) => {
  const user = req.user!;

  const job = await one<{
    closedAt: Date | null;
    dispatchedAt: Date | null;
    taskId: string | null;
    taskStatus: string | null;
    evidence: string;
  }>(
    `SELECT q.closed_at AS "closedAt", q.dispatched_at AS "dispatchedAt",
            t.id AS "taskId", t.status::text AS "taskStatus",
            (SELECT count(*) FROM evidence e WHERE e.task_id = t.id)::text AS evidence
       FROM questions q LEFT JOIN tasks t ON t.question_id = q.id
      WHERE q.id = $1 AND q.asker_id = $2`,
    [req.params.id, user.id],
  );

  if (!job) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (job.closedAt) {
    res.status(409).json({ error: 'already_closed' });
    return;
  }
  if (!job.dispatchedAt) {
    res.status(409).json({ error: 'not_dispatched', detail: 'That question was never sent out.' });
    return;
  }
  // Anything that produced work, or is being reviewed, is not the asker's to
  // reset — the same rule the close route applies, for the same reason.
  if (Number(job.evidence) > 0 || job.taskStatus === 'submitted' ||
      job.taskStatus === 'confirmed' || job.taskStatus === 'disputed') {
    res.status(409).json({
      error: 'answer_exists',
      detail: 'Somebody already sent something. Confirm it or query it.',
    });
    return;
  }

  await transaction(async (client) => {
    if (job.taskId) {
      await client.query(`DELETE FROM tasks WHERE id = $1`, [job.taskId]);
    }
    // A new deadline from now, which is the whole point of waiting on.
    await client.query(`UPDATE questions SET dispatched_at = now() WHERE id = $1`, [req.params.id]);
  });

  res.json({ ok: true });
});

questionsRouter.post('/:id/close', authenticate, async (req, res) => {
  const user = req.user!;

  const job = await one<{
    bountyKobo: number;
    closedAt: Date | null;
    taskStatus: string | null;
  }>(
    `SELECT q.bounty_kobo AS "bountyKobo", q.closed_at AS "closedAt",
            t.status::text AS "taskStatus"
       FROM questions q LEFT JOIN tasks t ON t.question_id = q.id
      WHERE q.id = $1 AND q.asker_id = $2`,
    [req.params.id, user.id],
  );

  if (!job) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (job.closedAt) {
    res.status(409).json({ error: 'already_closed' });
    return;
  }
  if (job.taskStatus === 'submitted' || job.taskStatus === 'confirmed') {
    res.status(409).json({
      error: 'answer_submitted',
      detail: 'An answer already came back. Confirm it or query it.',
    });
    return;
  }

  /**
   * A queried question is not the asker's to close.
   *
   * This was missing, and it is the expensive kind of missing: querying an
   * answer freezes the bounty for a reviewer, and closing it refunds that same
   * bounty to the asker. Both were reachable at once, so an asker could take
   * their money back and still have a reviewer later decide for the verifier
   * and pay them out of it. The deadline running out does not change this —
   * the clock is about nobody turning up, and somebody did.
   */
  if (job.taskStatus === 'disputed') {
    res.status(409).json({
      error: 'under_review',
      detail: 'You queried this one, so a reviewer decides it. You cannot close it yourself.',
    });
    return;
  }

  await transaction(async (client) => {
    await client.query(`UPDATE questions SET closed_at = now() WHERE id = $1`, [req.params.id]);
    await client.query(
      `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
       VALUES ($1, 'refund', $2, $3, 'Nobody delivered in time')`,
      [user.id, job.bountyKobo, req.params.id],
    );
    await client.query(
      `UPDATE tasks SET status = 'expired' WHERE question_id = $1 AND status = 'accepted'`,
      [req.params.id],
    );
  });

  res.json({ ok: true, refundedKobo: job.bountyKobo });
});

/**
 * Notifications.
 *
 * Derived from what actually happened rather than stored as their own rows:
 * a job being taken, evidence arriving, money moving, a dispute opening are
 * all already recorded, and writing a second copy at each of those points is
 * two things to keep in step. The notifications table exists for anything
 * that has no other home — it is unioned in here.
 */
/**
 * Disputes this person is actually part of, and which side they are on.
 *
 * There was no route at all: the app kept disputes in device-local state,
 * written by whoever raised one. That made a query visible only on the asker's
 * phone and invisible to the verifier being asked to answer it — the one
 * person the whole flow is waiting on.
 *
 * Role comes from the row rather than from the caller's belief about
 * themselves, so a client cannot present the wrong side of its own dispute.
 */
questionsRouter.get('/disputes/mine', authenticate, async (req, res) => {
  const rows = await query(
    `SELECT d.id, d.status::text AS status, d.asker_reason AS "askerReason",
            d.verifier_reply AS "verifierReply", d.admin_note AS "adminNote",
            d.created_at AS "createdAt",
            q.id AS "questionId", q.body AS question, q.bounty_kobo AS "bountyKobo",
            pl.name AS "placeName",
            asker.username AS "askerName", verifier.username AS "verifierName",
            e.kind::text AS "evidenceKind", e.keys AS "evidenceKeys",
            a.body AS answer,
            CASE WHEN q.asker_id = $1 THEN 'asker' ELSE 'verifier' END AS role
       FROM disputes d
       JOIN questions q ON q.id = d.question_id
       LEFT JOIN places pl ON pl.id = q.place_id
       LEFT JOIN profiles asker ON asker.user_id = q.asker_id
       LEFT JOIN tasks t ON t.id = d.task_id
       LEFT JOIN profiles verifier ON verifier.user_id = t.verifier_id
       ${LATEST_EVIDENCE}
       -- What the verifier actually wrote. Both parties are arguing about it,
       -- so both need to be able to read it back.
       LEFT JOIN LATERAL (
         SELECT body FROM answers WHERE task_id = t.id ORDER BY submitted_at DESC LIMIT 1
       ) a ON TRUE
      WHERE q.asker_id = $1 OR t.verifier_id = $1
      ORDER BY d.created_at DESC
      LIMIT 50`,
    [req.user!.id],
  );

  res.json({
    disputes: rows.map((r) => ({
      ...r,
      /**
       * Every file from the attempt, plus the first of them on its own.
       *
       * `evidenceUrl` stays because a card, a thumbnail and a share sheet all
       * want one representative image and should not each pick their own. The
       * array is what the viewer opens, so two photos sent are two photos seen.
       */
      evidenceUrls: evidenceUrls(r.evidenceKeys),
      evidenceUrl: evidenceUrls(r.evidenceKeys)[0] ?? null,
    })),
  });
});

questionsRouter.get('/notifications', authenticate, async (req, res) => {
  const userId = req.user!.id;

  const rows = await query(
    /*
     * Every branch prefixes its id with the event it describes, not just the
     * row it came from.
     *
     * Two branches read the same task: one when it is accepted, one when
     * evidence arrives. A task that has been through both — which is every
     * completed job — emitted t.id twice, so React saw duplicate keys, and
     * marking one of the pair read marked the other with it. The id has to
     * identify the event, and only kind + row does that.
     */
    `SELECT * FROM (
       -- Somebody took your question
       SELECT 'job'::text AS kind, 'task-accepted:' || t.id::text AS id, t.accepted_at AS at,
              'Somebody is on it' AS title,
              COALESCE(v.username, 'A verifier') || ' took: ' || left(q.body, 60) AS body,
              '/tracking/' || q.id::text AS href
         FROM tasks t
         JOIN questions q ON q.id = t.question_id
         LEFT JOIN profiles v ON v.user_id = t.verifier_id
        WHERE q.asker_id = $1

       UNION ALL
       -- Evidence came back
       SELECT 'answer', 'task-submitted:' || t.id::text, t.submitted_at,
              'Your answer is ready',
              left(q.body, 70), '/tracking/' || q.id::text
         FROM tasks t JOIN questions q ON q.id = t.question_id
        WHERE q.asker_id = $1 AND t.submitted_at IS NOT NULL

       UNION ALL
       -- Money moved, either direction
       SELECT 'payment', 'wallet:' || w.id::text, w.created_at,
              CASE w.kind
                WHEN 'earning'    THEN 'You were paid'
                WHEN 'refund'     THEN 'You were refunded'
                WHEN 'deposit'    THEN 'Top up received'
                WHEN 'withdrawal' THEN 'Withdrawal sent'
                ELSE 'Wallet updated'
              END,
              COALESCE(w.memo, w.kind::text), '/activity'
         FROM wallet_entries w
        WHERE w.user_id = $1 AND w.kind IN ('earning','refund','deposit','withdrawal')

       UNION ALL
       -- A dispute that needs this person
       SELECT 'dispute', 'dispute:' || d.id::text, d.created_at,
              CASE WHEN q.asker_id = $1 THEN 'Your query is being reviewed'
                   ELSE 'An answer of yours was queried' END,
              left(d.asker_reason, 70),
              CASE WHEN q.asker_id = $1 THEN '/tracking/' || q.id::text ELSE '/disputes' END
         FROM disputes d
         JOIN questions q ON q.id = d.question_id
         LEFT JOIN tasks t ON t.id = d.task_id
        WHERE q.asker_id = $1 OR t.verifier_id = $1

       UNION ALL
       /*
        * A job appeared near you.
        *
        * The one alert a verifier actually needs, and the only side of the
        * app that had none: every other row here is about something the
        * person already did. Filtered to their area, to questions they did
        * not ask, to jobs nobody has taken, and to people who asked for these
        * alerts.
        */
       SELECT 'job', 'nearby:' || q.id::text, q.dispatched_at,
              'A job near you',
              left(q.body, 70) || ' · ₦' || (q.bounty_kobo / 100)::text,
              '/task/' || q.id::text
         FROM questions q
         JOIN places p    ON p.id = q.place_id
         JOIN profiles me ON me.user_id = $1
         LEFT JOIN tasks t ON t.question_id = q.id
        WHERE q.asker_id <> $1
          AND q.closed_at IS NULL
          AND q.dispatched_at IS NOT NULL
          AND t.id IS NULL
          AND me.alert_jobs_nearby
          AND (me.home_area IS NULL OR p.area ILIKE me.home_area)
          AND q.dispatched_at + (q.deadline_minutes || ' minutes')::interval > now()

       UNION ALL
       -- Anything written directly
       SELECT n.kind, 'direct:' || n.id::text, n.created_at, n.title, n.body, n.href
         FROM notifications n
        WHERE n.user_id = $1
     ) feed
     WHERE at IS NOT NULL
     ORDER BY at DESC
     LIMIT 50`,
    [userId],
  );

  res.json({ notifications: rows });
});

/**
 * A recent public answer about the same place, if there is one.
 *
 * This is what lets a question be answered instantly and free: somebody
 * already went, and shared it. Only public answers, only confirmed ones, and
 * only recent — a stale answer about a filling station is worse than none.
 */
questionsRouter.get('/cached', authenticate, async (req, res) => {
  const placeName = typeof req.query.place === 'string' ? req.query.place.trim() : '';
  if (placeName.length < 3) {
    res.json({ answer: null });
    return;
  }

  const row = await one<{
    text: string;
    answer: string;
    placeName: string;
    area: string | null;
    submittedAt: Date;
    proof: string | null;
  }>(
    `SELECT q.body AS text, a.body AS answer, p.name AS "placeName", p.area,
            t.submitted_at AS "submittedAt", e.kind::text AS proof
       FROM questions q
       JOIN tasks t   ON t.question_id = q.id
       JOIN answers a ON a.task_id = t.id
       LEFT JOIN places p ON p.id = q.place_id
       LEFT JOIN LATERAL (
         SELECT kind FROM evidence WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
       ) e ON TRUE
      WHERE q.visibility = 'public'
        AND t.status = 'confirmed'
        AND p.name ILIKE $1
        AND t.submitted_at > now() - interval '12 hours'
      ORDER BY t.submitted_at DESC
      LIMIT 1`,
    [`%${placeName}%`],
  );

  if (!row) {
    res.json({ answer: null });
    return;
  }

  const hoursOld = (Date.now() - row.submittedAt.getTime()) / 3_600_000;
  res.json({
    answer: {
      question: row.text,
      answer: row.answer,
      placeName: row.placeName,
      area: row.area,
      proof: row.proof === 'video' ? 'video' : 'photo',
      hoursOld: Math.max(0.1, Number(hoursOld.toFixed(1))),
    },
  });
});

/**
 * Records a query against an answer.
 *
 * This route was missing entirely. The app opened disputes in local state and
 * froze the job on chain, but nothing reached Postgres — so the review desk,
 * which reads Postgres, saw nothing to decide and the money stayed frozen
 * with no way to release it.
 */
questionsRouter.post('/:id/dispute', authenticate, async (req, res) => {
  const user = req.user!;
  const reason = String((req.body as { reason?: unknown }).reason ?? '').trim();

  if (reason.length < 10) {
    res.status(400).json({
      error: 'reason_too_short',
      detail: 'Say what is wrong with it — a reviewer has to judge on this.',
    });
    return;
  }

  const job = await one<{
    taskId: string | null;
    askerId: string;
    verifierId: string | null;
    body: string;
  }>(
    `SELECT t.id AS "taskId", q.asker_id AS "askerId",
            t.verifier_id AS "verifierId", q.body
       FROM questions q LEFT JOIN tasks t ON t.question_id = q.id
      WHERE q.id = $1`,
    [req.params.id],
  );

  if (!job) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (job.askerId !== user.id) {
    res.status(403).json({ error: 'not_your_question' });
    return;
  }

  try {
    const created = await transaction(async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO disputes (question_id, task_id, asker_reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (question_id) DO NOTHING
         RETURNING id`,
        [req.params.id, job.taskId, reason.slice(0, 2000)],
      );
      // The job stops being ordinary work the moment it is contested.
      if (job.taskId) {
        await client.query(`UPDATE tasks SET status = 'disputed' WHERE id = $1`, [job.taskId]);
      }
      return row.rows[0]?.id ?? null;
    });

    if (!created) {
      res.status(409).json({ error: 'already_disputed' });
      return;
    }
    res.status(201).json({ ok: true, id: created });

    /**
     * The verifier is told their answer is being questioned.
     *
     * Nothing told them at all, which left the one person the flow is now
     * waiting on as the only person unaware it had moved: they had walked
     * somewhere, sent evidence, and their job silently changed state. The
     * reply window is theirs to use and they could only find it by opening
     * the app and noticing.
     */
    if (job.verifierId) {
      void notify({
        userId: job.verifierId,
        kind: 'dispute',
        title: 'Your answer was queried',
        body: `${job.body.slice(0, 60)} — say what you saw and a reviewer decides.`,
        href: '/disputes',
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'dispute_failed',
      detail: error instanceof Error ? error.message : 'Could not record it.',
    });
  }
});

/** The verifier's answer to a query. */
questionsRouter.post('/:id/dispute/reply', authenticate, async (req, res) => {
  const reply = String((req.body as { reply?: unknown }).reply ?? '').trim();
  if (reply.length < 10) {
    res.status(400).json({ error: 'reply_too_short', detail: 'Say a little more.' });
    return;
  }

  const updated = await one<{ id: string }>(
    `UPDATE disputes d
        SET verifier_reply = $3, status = 'awaiting_admin'
       FROM tasks t
      WHERE d.question_id = $1
        AND t.id = d.task_id
        AND t.verifier_id = $2
        AND d.status = 'awaiting_verifier'
      RETURNING d.id`,
    [req.params.id, req.user!.id, reply.slice(0, 2000)],
  );

  if (!updated) {
    res.status(409).json({ error: 'not_awaiting_you' });
    return;
  }
  res.json({ ok: true });

  /**
   * And the asker learns there is something to read.
   *
   * They raised the query, so they are waiting on exactly this — and the
   * dispute moves to the reviewer at the same moment, which is worth knowing
   * before they chase it.
   */
  void (async () => {
    const q = await one<{ askerId: string; body: string }>(
      `SELECT asker_id AS "askerId", body FROM questions WHERE id = $1`,
      [req.params.id],
    );
    if (!q) return;
    await notify({
      userId: q.askerId,
      kind: 'dispute',
      title: 'The verifier replied',
      body: `${q.body.slice(0, 60)} — a reviewer is looking at it now.`,
      href: `/tracking/${req.params.id}`,
    });
  })();
});
