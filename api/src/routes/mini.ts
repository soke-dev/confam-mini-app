import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import { one } from '../db.js';
import { mintSession, readSession, type MiniClaims } from '../miniSession.js';

export const miniRouter: Router = Router();

/**
 * The web app.
 *
 * Confam has been a phone app and an agent API. This is the third door: a web
 * page that runs inside somebody else's wallet on a phone, and inside an
 * ordinary browser on a desktop, with the same code doing both.
 *
 * That works because the two look identical from here. A wallet host injects
 * an EIP-1193 provider at window.ethereum; a desktop extension announces one
 * over EIP-6963. Different discovery, same object afterwards — so there is one
 * sign-in, not two, and the desktop path is not a port of the mobile one.
 *
 * Sign-in is a signature over a sentence. No email, no password, nothing to
 * reset. The wallet is already the thing that will hold the money, so making
 * it also the identity removes a step rather than adding one.
 *
 * Routes only. The mini app itself is the Expo build, hosted separately and
 * talking to these — there is no page served from here, because two
 * implementations of one screen is one too many.
 */

/* ── Sign in ──────────────────────────────────────────────────────────── */

/**
 * Issued nonces, so a signature cannot be replayed.
 *
 * In memory, which means a restart invalidates every outstanding challenge.
 * That is a ten-minute window and the recovery is to press the button again,
 * so it does not earn a table.
 */
const CHALLENGES = new Map<string, { nonce: string; expires: number }>();
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function challengeFor(address: string): string {
  const now = Date.now();
  for (const [k, v] of CHALLENGES) if (v.expires < now) CHALLENGES.delete(k);

  const nonce = randomBytes(16).toString('hex');
  CHALLENGES.set(address.toLowerCase(), { nonce, expires: now + CHALLENGE_TTL_MS });
  return nonce;
}

/**
 * What gets signed.
 *
 * A wallet shows this text and nothing else, so it has to carry its own
 * explanation: somebody who does not know what they are approving should be
 * able to read the prompt and find out. It names this service, this address
 * and a nonce used once, so a signature collected somewhere else cannot be
 * presented here.
 */
function messageFor(address: string, nonce: string): string {
  return [
    'Confam — sign in',
    '',
    'Sign this to sign in to Confam.',
    'This does not move any funds and costs no gas.',
    '',
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

const isAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

miniRouter.post('/challenge', (req, res) => {
  const address = String((req.body as { address?: unknown }).address ?? '').trim();
  if (!isAddress(address)) {
    res.status(400).json({ error: 'bad_address' });
    return;
  }
  const nonce = challengeFor(address);
  res.json({ address, nonce, message: messageFor(address, nonce) });
});

miniRouter.post('/session', async (req, res) => {
  const body = req.body as { address?: unknown; signature?: unknown };
  const address = String(body.address ?? '').trim();
  const signature = String(body.signature ?? '').trim();

  if (!isAddress(address) || !signature.startsWith('0x')) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  const issued = CHALLENGES.get(address.toLowerCase());
  if (!issued || issued.expires < Date.now()) {
    res.status(400).json({ error: 'no_challenge', detail: 'Ask for a challenge first.' });
    return;
  }

  const ok = await verifyMessage({
    address: address as `0x${string}`,
    message: messageFor(address, issued.nonce),
    signature: signature as `0x${string}`,
  }).catch(() => false);

  if (!ok) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }

  // Spent whether or not the rest succeeds, so one signature is one attempt.
  CHALLENGES.delete(address.toLowerCase());

  /**
   * The wallet is the account.
   *
   * Found before created, and deliberately the same lookup the agent key route
   * does: somebody who already has a Confam account at this address signs into
   * that account rather than quietly becoming a second person with an empty
   * history. Lower-cased because the column insists —
   * wallet_address ~ '^0x[0-9a-f]{40}$' — while every wallet hands back a
   * checksummed, mixed-case string.
   */
  const stored = address.toLowerCase();

  /*
   * Caught, because Express 4 does not await a handler: an unhandled rejection
   * here would not fail the request, it would end the process.
   */
  try {
    const existing = await one<{ id: string }>(
      `SELECT id FROM users WHERE wallet_address = $1`,
      [stored],
    );

    const userId =
      existing?.id ??
      (
        await one<{ id: string }>(
          `INSERT INTO users (wallet_address) VALUES ($1) RETURNING id`,
          [stored],
        )
      )?.id;

    if (!userId) {
      res.status(500).json({ error: 'could_not_create' });
      return;
    }

    /**
     * A profile, so this person has a name.
     *
     * Privy sign-in creates one and the rest of the app assumes it: a job on
     * the board shows the asker's username, and a row joined against a missing
     * profile shows a blank where somebody should be. The name is the address,
     * shortened — it is what they are already known by here, and it needs no
     * second sign-up step to collect.
     *
     * DO NOTHING on conflict, because signing in again must not rename
     * somebody who has since chosen their own.
     */
    await one(
      `INSERT INTO profiles (user_id, username)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [userId, `${stored.slice(0, 6)}${stored.slice(-4)}`],
    );

    const { token, expires } = mintSession(userId, stored);
    res.json({
      token,
      expires,
      // Echoed in the caller's casing, which is what they will show and compare.
      address,
      isNew: !existing,
    });
  } catch (err) {
    console.error('[mini] sign-in failed', err);
    res.status(500).json({ error: 'sign_in_failed' });
  }
});

/* ── Authenticated surface ────────────────────────────────────────────── */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mini?: MiniClaims;
    }
  }
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const claims = token ? readSession(token) : null;

  if (!claims) {
    res.status(401).json({ error: 'invalid_session' });
    return;
  }

  req.mini = claims;
  next();
}

miniRouter.get('/me', requireSession, async (req, res) => {
  const claims = req.mini!;
  try {
    const row = await one<{ id: string; username: string | null; display_name: string | null }>(
      `SELECT u.id, p.username, p.display_name
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [claims.userId],
    );

    if (!row) {
      // The token is valid but the account behind it is gone. Say so as 401,
      // so the client signs out rather than retrying against nothing.
      res.status(401).json({ error: 'no_account' });
      return;
    }

    res.json({
      address: claims.address,
      username: row.username ?? null,
      displayName: row.display_name ?? null,
      expires: claims.expires,
    });
  } catch (err) {
    console.error('[mini] /me failed', err);
    res.status(500).json({ error: 'lookup_failed' });
  }
});
