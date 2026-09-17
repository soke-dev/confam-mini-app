import type { NextFunction, Request, Response } from 'express';
import { PrivyClient } from '@privy-io/node';
import { config, hasPrivy } from './config.js';
import { one } from './db.js';
import { readSession } from './miniSession.js';

/**
 * Who the caller is, established by Privy rather than by this server.
 *
 * The client authenticates with Privy directly and receives a short-lived
 * access token. It sends that token here; this file verifies the signature
 * against Privy's public verification key and trusts nothing else about the
 * request. No password, no session table, no reset flow — none of which we
 * would want to be responsible for storing.
 */

let client: PrivyClient | null = null;

function privy(): PrivyClient {
  if (!client) {
    if (!hasPrivy()) {
      throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET must both be set');
    }
    client = new PrivyClient({
      appId: config.privy.appId,
      appSecret: config.privy.appSecret,
    });
  }
  return client;
}

export type AuthedUser = {
  id: string;
  privyDid: string;
  email: string | null;
  walletAddress: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/**
 * Verifies the bearer token and resolves it to a row in `users`.
 *
 * Verification is cryptographic and local — Privy signs the token with a key
 * whose public half is fetched once and cached, so this does not make a
 * network call to Privy on every request. An expired or forged token fails
 * here, before any query runs.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }

  /**
   * The web app signs in with a wallet signature rather than with Privy, and
   * gets one of our own tokens back. Rather than give it a parallel set of
   * routes, it presents that token here and every existing route works.
   *
   * The two are told apart by shape, not by trying one and falling back to the
   * other: ours begin "v1.", a Privy JWT begins with base64 of "{". Guessing
   * would mean a Privy outage looked like a forged token, and a malformed
   * token would cost a signature verification before being rejected.
   */
  if (token.startsWith('v1.')) {
    const user = await fromWalletSession(token);
    if (!user) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    req.user = user;
    next();
    return;
  }

  let claims: { user_id: string; app_id: string };
  try {
    claims = await privy().utils().auth().verifyAccessToken(token);
    // Defence in depth: a validly-signed token issued for a different Privy
    // app must not authenticate anyone here.
    if (claims.app_id !== config.privy.appId) throw new Error('wrong app');
  } catch {
    // Deliberately does not say which — an attacker learns nothing from
    // knowing whether a token was expired or simply invalid.
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const user = await upsertFromPrivy(claims.user_id);
  if (!user) {
    res.status(401).json({ error: 'unknown_user' });
    return;
  }

  req.user = user;
  next();
}

/**
 * Resolves one of our own wallet sessions to the same user shape Privy yields.
 *
 * The session is verified by its signature alone — no database round trip is
 * needed to know it is ours — but the row is still loaded, because a token
 * outliving the account it names must not authenticate anybody. Returning null
 * for a deleted user is the difference between a stale token being useless and
 * it being a skeleton key.
 */
async function fromWalletSession(token: string): Promise<AuthedUser | null> {
  const claims = readSession(token);
  if (!claims) return null;

  const user = await one<AuthedUser>(
    `SELECT id, privy_did AS "privyDid", email, wallet_address AS "walletAddress"
       FROM users WHERE id = $1`,
    [claims.userId],
  );
  if (!user) return null;

  /*
   * The address in the token must still be the address on the row. They can
   * only diverge if the account was re-keyed, and if that happened the old
   * signature should stop opening the door.
   */
  if ((user.walletAddress ?? '').toLowerCase() !== claims.address) return null;

  return user;
}

/**
 * Finds or creates the local row for a Privy DID.
 *
 * The DID is the key, not the email. Someone who changes their email address
 * in Privy is still the same person, still owns the same wallet, and must keep
 * their job history and their money — keying on email would silently split
 * them into two accounts and strand the balance on the old one.
 *
 * The insert is idempotent: two requests arriving together for a new user both
 * resolve to the same row rather than racing to create two.
 */
export async function upsertFromPrivy(privyDid: string): Promise<AuthedUser | null> {
  const existing = await one<AuthedUser>(
    `SELECT id, privy_did AS "privyDid", email, wallet_address AS "walletAddress"
       FROM users WHERE privy_did = $1`,
    [privyDid],
  );

  // Fast path: nothing left to learn, so no call to Privy.
  if (existing && existing.email && existing.walletAddress) return existing;

  /**
   * Anything still missing is worth asking about on every sign-in until it
   * arrives — not only when the row is created.
   *
   * Privy provisions the embedded wallet asynchronously *after* the login that
   * triggers it, so the first /auth/me almost always lands before the address
   * exists. Fetching only at creation time would mean that address is never
   * recorded at all: the row would be complete enough to take the fast path
   * forever, holding a null wallet for a user who has one. The same applies
   * after a transient Privy outage.
   */
  const linked = await fetchLinkedAccounts(privyDid);

  if (existing) {
    // COALESCE keeps whatever is already stored: this fills gaps, and must
    // never overwrite a known value with a null from a failed lookup.
    return await one<AuthedUser>(
      `UPDATE users
          SET email             = COALESCE(email, $2),
              wallet_address    = COALESCE(wallet_address, $3),
              wallet_created_at = CASE
                WHEN wallet_address IS NULL AND $3::text IS NOT NULL THEN now()
                ELSE wallet_created_at
              END
        WHERE id = $1
        RETURNING id, privy_did AS "privyDid", email, wallet_address AS "walletAddress"`,
      [existing.id, linked.email, linked.wallet],
    );
  }

  const created = await one<AuthedUser>(
    `INSERT INTO users (privy_did, email, wallet_address, wallet_created_at)
     VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (privy_did) DO UPDATE
       SET email          = COALESCE(users.email, EXCLUDED.email),
           wallet_address = COALESCE(users.wallet_address, EXCLUDED.wallet_address)
     RETURNING id, privy_did AS "privyDid", email, wallet_address AS "walletAddress"`,
    [privyDid, linked.email, linked.wallet],
  );

  if (created) {
    await one(
      `INSERT INTO profiles (user_id, username)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [created.id, suggestUsername(linked.email)],
    );
  }

  return created;
}

/**
 * What Privy knows about this account: the email they logged in with and the
 * embedded wallet, if it exists yet.
 *
 * Returns nulls rather than throwing. A Privy outage must not stop someone
 * signing in with a token that already verified cryptographically — the
 * missing fields are picked up on the next request instead.
 */
async function fetchLinkedAccounts(
  privyDid: string,
): Promise<{ email: string | null; wallet: string | null }> {
  let email: string | null = null;
  let wallet: string | null = null;

  try {
    // `users().get()` resolves an identity token; fetching by DID is `_get`.
    const account = await privy().users()._get(privyDid);
    for (const linked of account.linked_accounts ?? []) {
      if (linked.type === 'email' && 'address' in linked) {
        email = String(linked.address).toLowerCase();
      }
      // Only the wallet Privy created for us. An external wallet the person
      // connected is not the one this app pays out to.
      if (linked.type === 'wallet' && 'address' in linked) {
        const isEmbedded =
          !('wallet_client_type' in linked) || linked.wallet_client_type === 'privy';
        if (isEmbedded) wallet = String(linked.address).toLowerCase();
      }
    }
  } catch {
    // A deleted Privy user 404s here. The local row is left as it is rather
    // than being wiped — the job history and balance attached to it are real
    // regardless of what happened upstream.
  }

  return { email, wallet };
}

/**
 * A starting handle, suggested from the email local part.
 *
 * Suggested, never asserted: the welcome sheet shows it as an editable field.
 * Returns null rather than inventing something when there is no email, because
 * a blank field a person fills in is better than a random one they have to
 * notice and correct.
 */
function suggestUsername(email: string | null): string | null {
  if (!email) return null;
  const cleaned = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return cleaned.length >= 3 ? cleaned.slice(0, 20) : null;
}

/** Same as `authenticate`, but lets anonymous callers through. */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.headers.authorization) {
    next();
    return;
  }
  await authenticate(req, res, next);
}
