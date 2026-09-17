import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sessions for the web app, held in a signed token rather than a table.
 *
 * Everywhere else on this server a caller proves who they are with a Privy
 * access token, and Privy verifies it. The web app has no Privy: it runs
 * inside somebody else's wallet, where the only credential anybody carries is
 * the wallet itself. So it signs a sentence, and gets one of these back.
 *
 * Stateless on purpose. A sessions table would need a sweep, an index and a
 * migration, and would still be doing what an HMAC does in four lines. The
 * cost of that choice is that a token cannot be revoked before it expires,
 * which is why the lifetime is days rather than months.
 *
 * The token says who, not what they may spend. Every route that moves money
 * still checks the balance and the limits it always checked — this only
 * answers "which account is calling".
 */

/**
 * Signing key.
 *
 * Unset, it is random and this process alone can verify what it issued. That
 * is fine on a laptop and quietly wrong in production: a restart signs
 * everybody out, and two instances behind a load balancer each reject the
 * other's tokens. Hence the warning, which names the consequence rather than
 * just the variable, because "MINI_SESSION_SECRET is not set" tells somebody
 * reading logs nothing about what will happen to them.
 */
const SECRET: Buffer = (() => {
  const given = process.env.MINI_SESSION_SECRET ?? '';
  if (given.length >= 16) return Buffer.from(given, 'utf8');

  if (given.length > 0) {
    console.warn('[mini] MINI_SESSION_SECRET is too short to be a secret; ignoring it');
  }
  console.warn(
    '[mini] no MINI_SESSION_SECRET: signing sessions with a key made up at boot. ' +
      'Every restart signs everybody out, and a second instance will reject this one tokens.',
  );
  return randomBytes(32);
})();

/** Long enough not to be a nuisance, short enough that revocation-by-expiry means something. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MiniClaims = {
  /** The Confam user this wallet is. */
  userId: string;
  /** Lower-cased, as the database stores it. */
  address: string;
  /** Milliseconds since the epoch. */
  expires: number;
};

/** base64url, without the padding that makes tokens awkward to pass around. */
function b64(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(body: string): string {
  return b64(createHmac('sha256', SECRET).update(body).digest());
}

export function mintSession(userId: string, address: string): { token: string; expires: number } {
  const expires = Date.now() + TTL_MS;
  const body = b64(
    Buffer.from(JSON.stringify({ u: userId, a: address.toLowerCase(), e: expires }), 'utf8'),
  );
  return { token: `v1.${body}.${sign(body)}`, expires };
}

/**
 * Null for anything that is not a live token this server issued.
 *
 * Deliberately does not distinguish expired from forged from malformed. A
 * caller learns only that it did not work, which is all an honest one needs.
 */
export function readSession(token: string): MiniClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  const [, body, mac] = parts as [string, string, string];

  const expected = Buffer.from(sign(body), 'utf8');
  const given = Buffer.from(mac, 'utf8');
  // Length first: timingSafeEqual throws on a mismatch rather than returning false.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const claims = JSON.parse(unb64(body).toString('utf8')) as {
      u?: unknown;
      a?: unknown;
      e?: unknown;
    };

    const userId = String(claims.u ?? '');
    const address = String(claims.a ?? '');
    const expires = Number(claims.e ?? 0);

    if (!userId || !/^0x[0-9a-f]{40}$/.test(address)) return null;
    if (!Number.isFinite(expires) || expires < Date.now()) return null;

    return { userId, address, expires };
  } catch {
    return null;
  }
}
