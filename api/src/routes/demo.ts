import { Router } from 'express';
import { config, hasAgents } from '../config.js';
import { one, query, transaction } from '../db.js';
import { resolveKey } from '../agentAuth.js';
import { ago, triage } from '../agentTriage.js';
import { storage } from '../storage.js';
import { LATEST_EVIDENCE, evidenceUrls } from '../evidenceSql.js';
import { notify, nearbyVerifiers } from '../push.js';
import { DEMO_PAGE } from '../demoPage.js';
import { fundAsAgent } from '../agentWallet.js';
import { relayRefund } from '../escrow.js';
import { acceptAnswer } from '../acceptAnswer.js';

export const demoRouter: Router = Router();

/**
 * The public demonstration.
 *
 * Everything else on this server is reached with a credential. This is the one
 * surface somebody can open with nothing — no account, no key, no app — and
 * watch the agent decide, and if it decides somebody must go, actually send
 * them.
 *
 * Which is the whole difficulty. A job posted from a page anybody can open is
 * a real job: real money leaves a real balance and a real person may walk
 * somewhere for it. So this spends from one account against a ceiling, allows
 * one job per visitor, and says plainly when it will not spend any more. The
 * alternative — a demo that only pretends to dispatch — would be the one lie
 * that makes the entire claim worthless.
 */

/** One job per visitor, so a single caller cannot drain the budget. */
const POSTED = new Map<string, number>();
const ONE_PER_MS = 30 * 60 * 1000;

/** Trimmed whenever it is read, so it cannot grow without bound. */
function alreadyPosted(ip: string): boolean {
  const now = Date.now();
  for (const [k, t] of POSTED) if (now - t > ONE_PER_MS) POSTED.delete(k);
  return POSTED.has(ip);
}

function callerIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.ip ?? 'unknown';
}

demoRouter.use((_req, res, next) => {
  if (!hasAgents()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  next();
});

/**
 * The page itself.
 *
 * Served before the JSON routes so a judge who opens the bare URL lands on
 * something rather than a 404 explaining nothing.
 */
demoRouter.get('/', (_req, res) => {
  res.type('html').send(DEMO_PAGE);
});

/** What is left to spend, so the page can say before somebody tries. */
async function budget(): Promise<{ spentKobo: number; leftKobo: number; jobsLeft: number }> {
  const row = await one<{ kobo: string }>(
    `SELECT COALESCE(SUM(q.bounty_kobo), 0)::bigint AS kobo
       FROM questions q
       JOIN api_keys k ON k.id = q.asked_by_key
      WHERE k.token_hash IS NOT NULL AND q.asked_by_key IS NOT NULL
        AND k.name = 'demo'`,
  );
  const spent = Number(row?.kobo ?? 0);
  const left = Math.max(0, config.agents.demoBudgetKobo - spent);
  return {
    spentKobo: spent,
    leftKobo: left,
    jobsLeft: Math.floor(left / config.agents.demoBountyKobo),
  };
}

demoRouter.get('/budget', async (_req, res) => {
  res.json({
    ...(await budget()),
    bountyKobo: config.agents.demoBountyKobo,
    configured: config.agents.demoKey.length > 0,
  });
});

/**
 * Places the network has actually been.
 *
 * Offered as suggestions on the page, so somebody typing at random is steered
 * towards the places where an answer already exists — which is where the agent
 * gets to show the half that costs nothing, rather than dispatching every time
 * because a judge guessed a town nobody has visited.
 */
demoRouter.get('/places', async (_req, res) => {
  const rows = await query<{ name: string; n: number }>(
    `SELECT p.name, count(*)::int AS n
       FROM questions q
       JOIN tasks t   ON t.question_id = q.id
       JOIN places p  ON p.id = q.place_id
      WHERE q.visibility = 'public'
        AND t.status IN ('submitted', 'confirmed')
        AND p.name IS NOT NULL
      GROUP BY p.name
      ORDER BY max(t.submitted_at) DESC
      LIMIT 6`,
  );
  res.json({ places: rows.map((r) => r.name) });
});

/**
 * Somewhere real, typed at the prompt.
 *
 * The page offered only places the network had already been, which is right
 * for steering somebody towards the free answer and useless the moment they
 * want to ask about anywhere else. The app has always searched OpenStreetMap
 * through Photon; this is the same lookup, so a place picked here and a place
 * picked in the app are the same record with the same coordinates.
 *
 * Proxied rather than called from the browser so the page keeps talking to one
 * origin, and so coverage can be merged in ahead of the live results — a
 * place somebody has already checked is worth more than a better string match.
 */
demoRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) {
    res.json({ places: [] });
    return;
  }

  // Places with real coverage first, so the instant path stays reachable.
  const covered = await query<{ name: string; lat: number | null; lng: number | null }>(
    `SELECT p.name, max(p.lat) AS lat, max(p.lng) AS lng
       FROM questions qq
       JOIN tasks t  ON t.question_id = qq.id
       JOIN places p ON p.id = qq.place_id
      WHERE qq.visibility = 'public'
        AND t.status IN ('submitted', 'confirmed')
        AND p.name ILIKE '%' || $1 || '%'
      /*
       * Grouped by name alone. Grouping by the coordinates too returned the
       * same place twice whenever two rows carried different ones — and one of
       * the duplicates had no coordinates at all, so picking it would have
       * dropped the place back to string matching.
       *
       * max() skips nulls, so a name that has ever had coordinates keeps them.
       */
      GROUP BY p.name
      ORDER BY max(t.submitted_at) DESC
      LIMIT 3`,
    [q],
  );

  const places = covered.map((c) => ({
    name: c.name,
    area: '',
    lat: c.lat,
    lng: c.lng,
    covered: true,
  }));

  /**
   * Then whatever OpenStreetMap knows.
   *
   * Failure here is not an error: the covered list is still useful, and a
   * geocoder being unreachable should narrow the choices rather than break
   * the prompt.
   */
  try {
    const url = new URL('https://photon.komoot.io/api');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '8');
    url.searchParams.set('lang', 'en');
    // Biased toward Lagos, the same as the app does, since Photon ranks by
    // distance from this point and most questions are Nigerian.
    url.searchParams.set('lat', '6.5244');
    url.searchParams.set('lon', '3.3792');

    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (response.ok) {
      const data = (await response.json()) as {
        features?: { properties?: Record<string, unknown>; geometry?: { coordinates?: number[] } }[];
      };

      const seen = new Set(places.map((p2) => p2.name.toLowerCase()));

      for (const f of data.features ?? []) {
        const props = f.properties ?? {};
        const name = String(props.name ?? props.street ?? props.city ?? '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        const area = [props.district, props.city, props.state]
          .filter((x) => typeof x === 'string' && x && x !== name)
          .join(', ');

        const c = f.geometry?.coordinates;
        places.push({
          name,
          area,
          lat: Array.isArray(c) ? (c[1] ?? null) : null,
          lng: Array.isArray(c) ? (c[0] ?? null) : null,
          covered: false,
        });
        if (places.length >= 7) break;
      }
    }
  } catch {
    // Covered results stand on their own.
  }

  res.json({ places });
});

/**
 * What the network has answered lately, anywhere.
 *
 * The terminal shows one conversation and nothing else, so a page that has
 * been open for ten seconds looks like a network with nothing in it. This is
 * the same feed the app puts on its home screen, unfiltered by area: the
 * evidence that the thing is being used by people who are not you.
 *
 * Public questions only, and no evidence: a list is not the place to publish
 * photographs, and anybody who wants one can open the proof.
 */
demoRouter.get('/answered', async (_req, res) => {
  const rows = await query<{
    id: string;
    text: string;
    placeName: string | null;
    area: string | null;
    state: string | null;
    confirmed: boolean;
    minutesOld: number;
  }>(
    `SELECT q.id, q.body AS text,
            p.name AS "placeName", p.area, p.state,
            (t.status = 'confirmed') AS confirmed,
            EXTRACT(EPOCH FROM (now() - t.submitted_at)) / 60 AS "minutesOld"
       FROM questions q
       JOIN tasks t       ON t.question_id = q.id
       LEFT JOIN places p ON p.id = q.place_id
      WHERE q.visibility = 'public'
        AND t.submitted_at IS NOT NULL
      ORDER BY t.submitted_at DESC
      LIMIT 12`,
  );

  res.json({
    answered: rows.map((r) => ({
      id: r.id,
      text: r.text,
      // The most specific name first, the same order the app resolved on:
      // OSM puts the locality in one field or the other depending on the place.
      where: [r.placeName, r.area, r.state].filter(Boolean).join(', ') || 'somewhere',
      confirmed: r.confirmed,
      ago: ago(Math.round(Number(r.minutesOld))),
    })),
  });
});

/**
 * Ask the agent, from the page.
 *
 * The judgment runs for everybody — it costs nothing and is the thing worth
 * seeing. Only the dispatch half is rationed, because only that half spends.
 */
demoRouter.post('/ask', async (req, res) => {
  const body = req.body as {
    question?: unknown;
    place?: unknown;
    lat?: unknown;
    lng?: unknown;
    /** Where the place sits, so the answered feed can find it. */
    area?: unknown;
    /** Set once the visitor has agreed to spend. Absent means only decide. */
    confirm?: unknown;
  };
  const question = String(body.question ?? '').trim().slice(0, 200);
  const place = String(body.place ?? '').trim().slice(0, 120);

  if (question.length < 5 || place.length < 2) {
    res.status(400).json({ error: 'need_question_and_place' });
    return;
  }

  const at =
    Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng))
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : null;

  const verdict = await triage(question, place, at);

  if (verdict.decision === 'reuse') {
    const { prior } = verdict;
    res.json({
      status: 'answered',
      source: 'cached',
      because: verdict.because,
      answer: prior.answer,
      askedAs: prior.question,
      ageMinutes: prior.minutesOld,
      verifier: prior.verifier,
      proof: prior.evidenceKind,
      evidence: prior.evidenceKeys.map((k) => storage.urlFor(k)),
      questionId: prior.questionId,
      costNgn: config.agents.cachedFeeKobo / 100,
    });
    return;
  }

  // ── From here it spends ───────────────────────────────────────────────────

  /**
   * Decided, then asked.
   *
   * Sending somebody costs money and puts a person in a street, and doing that
   * on the same keystroke that asked a question gives nobody a chance to say
   * no. The judgment is free and runs for everybody; the spending waits for an
   * answer.
   *
   * The checks that would refuse anyway run first, so a visitor is not asked
   * to approve something that was never going to happen.
   */
  if (body.confirm !== true) {
    const key = config.agents.demoKey;
    const money = await budget();
    const blocked =
      !key ? 'no_demo_key'
      : money.jobsLeft < 1 ? 'budget_spent'
      : alreadyPosted(callerIp(req as never)) ? 'already_posted'
      : null;

    res.json({
      status: blocked ? 'would_dispatch' : 'needs_confirm',
      because: verdict.because,
      reason: blocked,
      costNgn: config.agents.demoBountyKobo / 100,
      question,
      place,
    });
    return;
  }

  const key = config.agents.demoKey;
  if (!key) {
    res.json({ status: 'would_dispatch', because: verdict.because, reason: 'no_demo_key' });
    return;
  }

  const money = await budget();
  if (money.jobsLeft < 1) {
    res.json({ status: 'would_dispatch', because: verdict.because, reason: 'budget_spent' });
    return;
  }

  const ip = callerIp(req as never);
  if (alreadyPosted(ip)) {
    res.json({ status: 'would_dispatch', because: verdict.because, reason: 'already_posted' });
    return;
  }

  const owner = await resolveKey(key);
  if (!owner) {
    res.json({ status: 'would_dispatch', because: verdict.because, reason: 'bad_demo_key' });
    return;
  }

  const bountyKobo = config.agents.demoBountyKobo;

  /**
   * Coordinates borrowed from somewhere the network has already been.
   *
   * The page asks for a place by name and nothing else, so a demo place had no
   * lat/lng — which quietly excluded it from proximity matching and left it
   * matchable only by an exact string. Two judges typing "Ikeja" and "Ikeja,
   * Lagos" would then have built two separate places that never shared what
   * either of them learned.
   *
   * Only ever borrowed from an existing place of the same name, so it cannot
   * invent a location: if nobody has been there, it stays null, which is
   * honest and no worse than before.
   */
  const known = await one<{ lat: number | null; lng: number | null; area: string | null; state: string | null }>(
    `SELECT lat, lng, area, state FROM places
      WHERE name ILIKE $1
      ORDER BY (lat IS NOT NULL) DESC, created_at DESC
      LIMIT 1`,
    [place],
  );
  const coords = at ?? (known?.lat != null && known.lng != null ? { lat: known.lat, lng: known.lng } : null);

  /**
   * The area, borrowed along with the coordinates.
   *
   * Places created here had none, and the Answered-nearby feed matches on
   * name, area and state together — so every question an agent asked was
   * invisible in it, however close somebody was standing. "Etete Road" does
   * not contain "Oredo".
   */
  const area =
    (typeof body.area === 'string' && body.area.trim() ? body.area.trim() : null) ??
    known?.area ??
    null;
  const state = known?.state ?? null;

  const created = await transaction(async (client) => {
    const placeRow = await client.query<{ id: string }>(
      `INSERT INTO places (provider, name, area, state, lat, lng)
       VALUES ('demo', $1, $2, $3, $4, $5) RETURNING id`,
      [place, area, state, coords?.lat ?? null, coords?.lng ?? null],
    );

    const q = await client.query<{ id: string }>(
      `INSERT INTO questions
         (asker_id, body, place_id, bounty_kobo, visibility, deadline_minutes,
          verified_only, dispatched_at, asked_by_key)
       VALUES ($1, $2, $3, $4, 'public', 60, FALSE, now(), $5)
       RETURNING id`,
      [owner.userId, question, placeRow.rows[0]!.id, bountyKobo, owner.keyId],
    );

    await client.query(
      `INSERT INTO wallet_entries (user_id, kind, amount_kobo, question_id, memo)
       VALUES ($1, 'hold', $2, $3, $4)`,
      [owner.userId, bountyKobo, q.rows[0]!.id, `Demo: ${question.slice(0, 50)}`],
    );

    return q.rows[0]!.id;
  });

  POSTED.set(ip, Date.now());

  /**
   * Locked on Base before the reply, not after.
   *
   * The point of the demo is that none of this is pretend, and the response
   * says whether the money is actually in escrow — so it has to know. It costs
   * a few seconds; the alternative is telling somebody their job is funded and
   * finding out afterwards that it is not.
   */
  const funded = await fundAsAgent(created, bountyKobo);

  res.status(201).json({
    status: 'dispatched',
    source: 'dispatched',
    because: verdict.because,
    id: created,
    costNgn: bountyKobo / 100,
    jobsLeft: money.jobsLeft - 1,
    poll: `/demo/job/${created}`,
    chain: funded.ok
      ? { funded: true, txHash: funded.txHash, usdc: funded.usdc, chainId: config.chain.chainId }
      : { funded: false, why: funded.reason },
  });

  void (async () => {
    for (const userId of await nearbyVerifiers(created)) {
      await notify({
        userId,
        kind: 'job',
        title: 'A job near you',
        body: `${question.slice(0, 60)} · ₦${Math.round(bountyKobo / 100)}`,
        href: `/task/${created}`,
      });
    }
  })();
});

/**
 * Takes an expired job's money back out of the escrow.
 *
 * A job nobody took holds real USDC until somebody asks for it back, and the
 * contract lets anybody do that once the deadline passes — the money can only
 * go to the asker, so there is nothing to protect against. Offering it here
 * means a visitor who watched their job time out can undo it themselves rather
 * than leaving it stranded, which is how a demo budget quietly runs out while
 * the balance sits in a contract.
 *
 * Unauthenticated, and only ever for jobs this page created. Refused while the
 * deadline stands or once a verifier has taken it: somebody may be walking.
 */
demoRouter.post('/job/:id/refund', async (req, res) => {
  const job = await one<{
    chainJobId: string | null;
    fundChain: string;
    refundTx: string | null;
    expired: boolean;
    taken: boolean;
  }>(
    `SELECT q.chain_job_id AS "chainJobId", q.fund_chain AS "fundChain", q.refund_tx AS "refundTx",
            (q.dispatched_at + (q.deadline_minutes || ' minutes')::interval) < now() AS expired,
            EXISTS (SELECT 1 FROM tasks t WHERE t.question_id = q.id) AS taken
       FROM questions q
       JOIN api_keys k ON k.id = q.asked_by_key AND k.name = 'demo'
      WHERE q.id = $1`,
    [req.params.id],
  );

  if (!job) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (job.refundTx) {
    res.json({ ok: true, already: true, txHash: job.refundTx });
    return;
  }
  if (!job.chainJobId) {
    res.status(409).json({ error: 'not_on_chain', detail: 'Nothing was locked for this job.' });
    return;
  }
  if (job.taken) {
    res.status(409).json({ error: 'taken', detail: 'Somebody took this job. The money is theirs to claim.' });
    return;
  }
  if (!job.expired) {
    res.status(409).json({ error: 'not_expired', detail: 'The clock is still running on this one.' });
    return;
  }

  try {
    const result = await relayRefund(
      job.chainJobId as `0x${string}`,
      job.fundChain === 'polygon' ? 'polygon' : 'base',
    );
    await query(
      `UPDATE questions SET refund_tx = $2, closed_at = COALESCE(closed_at, now()) WHERE id = $1`,
      [req.params.id, result.txHash],
    );
    res.json({ ok: true, txHash: result.txHash });
  } catch (error) {
    /**
     * The contract has the last word on when a deadline passed.
     *
     * Its deadline is set at funding time and ours is derived from
     * dispatched_at, so the two can disagree — by seconds normally, by more if
     * a row was ever touched. Reporting the contract's refusal verbatim is
     * better than translating it into our own version of the truth, since the
     * contract is the one holding the money.
     */
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('[demo] refund failed —', detail);
    res.status(502).json({ error: 'refund_failed', detail: detail.slice(0, 160) });
  }
});

/**
 * Paying the verifier, from the terminal.
 *
 * The sweep accepts an unqueried answer after fifteen minutes, which is there
 * so nobody who walked somewhere is left waiting on a program that stopped
 * calling. It is not a substitute for this: somebody watching their own job
 * come back should not have to wait a quarter of an hour to pay for it, and
 * until now the terminal could start a job and refund a dead one but could not
 * finish a live one.
 *
 * Unauthenticated, and only ever for jobs this page created — the same
 * ownership check the refund uses, for the same reason.
 */
demoRouter.post('/job/:id/accept', async (req, res) => {
  const mine = await one<{ id: string }>(
    `SELECT q.id
       FROM questions q
       JOIN api_keys k ON k.id = q.asked_by_key AND k.name = 'demo'
      WHERE q.id = $1`,
    [req.params.id],
  );
  if (!mine) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const result = await acceptAnswer(String(req.params.id), 'Answer accepted from the terminal');
  if (!result.ok) {
    res.status(result.error === 'not_found' ? 404 : 409).json(result);
    return;
  }
  if (result.already) {
    res.json({ ok: true, already: true });
    return;
  }

  res.json({
    ok: true,
    verifier: result.verifier,
    paidNgn: result.paidKobo / 100,
    feeNgn: result.feeKobo / 100,
    chain: result.released.ok
      ? { released: true, txHash: result.released.txHash }
      : { released: false, why: result.released.why },
  });
});

/**
 * Whether anybody has been yet.
 *
 * Unauthenticated, and only ever about jobs this page created — a visitor
 * should be able to watch their own job without an account, and should not be
 * able to read anybody else's by changing the id.
 */
demoRouter.get('/job/:id', async (req, res) => {
  const row = await one<{
    question: string;
    place: string | null;
    status: string | null;
    answer: string | null;
    evidenceKeys: string[] | null;
    evidenceKind: string | null;
    distanceMetres: number | null;
    capturedAt: Date | null;
    verifier: string | null;
    expired: boolean;
    refundTx: string | null;
  }>(
    `SELECT q.body AS question, p.name AS place, t.status::text AS status,
            a.body AS answer, e.keys AS "evidenceKeys", e.kind::text AS "evidenceKind",
            e.distance_metres AS "distanceMetres", e.captured_at AS "capturedAt",
            v.username AS verifier,
            (q.dispatched_at + (q.deadline_minutes || ' minutes')::interval) < now() AS expired,
            q.refund_tx AS "refundTx"
       FROM questions q
       JOIN api_keys k      ON k.id = q.asked_by_key AND k.name = 'demo'
       LEFT JOIN places p   ON p.id = q.place_id
       LEFT JOIN tasks t    ON t.question_id = q.id
       LEFT JOIN profiles v ON v.user_id = t.verifier_id
       LEFT JOIN LATERAL (
         SELECT body FROM answers WHERE task_id = t.id ORDER BY submitted_at DESC LIMIT 1
       ) a ON TRUE
       ${LATEST_EVIDENCE}
      WHERE q.id = $1`,
    [req.params.id],
  );

  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const done = row.status === 'submitted' || row.status === 'confirmed';
  res.json({
    status: done ? 'answered' : row.status === 'accepted' ? 'in_progress' : 'waiting',
    question: row.question,
    place: row.place,
    answer: done ? row.answer : null,
    evidence: evidenceUrls(row.evidenceKeys),
    evidenceKind: row.evidenceKind,
    metresFromPlace: row.distanceMetres,
    capturedAt: row.capturedAt,
    verifier: row.verifier,
    /**
     * Answered and paid are not the same thing, and the page had no way to
     * tell them apart: both arrive as "answered", so a job already settled
     * looked exactly like one still owing somebody money.
     */
    paid: row.status === 'confirmed',
    proof: `/escrow/${req.params.id}/proof`,
    /**
     * Whether the money can be taken back, said here rather than left for the
     * page to work out from a deadline it was never sent.
     */
    refundable: !done && row.status === null && row.expired && !row.refundTx,
    refundTx: row.refundTx,
  });
});
