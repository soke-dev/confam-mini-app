/**
 * Drives the web app's sign-in against a running server, including the ways it
 * is supposed to refuse.
 *
 * The happy path is the least interesting third of this. Sign-in is the only
 * place on this server where a signature alone decides who somebody is, so the
 * things worth a script are the refusals: a challenge cannot be spent twice, a
 * signature from another key is not accepted for an address, and a token with
 * one byte changed does not authenticate anyone. Those are easy to break
 * without noticing, because breaking them makes nothing fail — it makes more
 * things succeed.
 *
 *   npm run check:signin              against localhost:8080
 *   CHECK_BASE=... npm run check:signin
 */
import { privateKeyToAccount } from 'viem/accounts';

const BASE = (process.env.CHECK_BASE ?? 'http://localhost:8080').replace(/\/+$/, '');

/*
 * This writes: a successful sign-in creates a user row for the test address.
 * That is harmless on a laptop and not something to do to the real database by
 * fat-fingering an environment variable, so it has to be asked for explicitly.
 */
const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(BASE);
if (!local && process.env.CHECK_ALLOW_REMOTE !== 'yes') {
  console.error(
    `check-signin: ${BASE} is not local, and signing in creates a user row.\n` +
      'Set CHECK_ALLOW_REMOTE=yes if that is really what you want.',
  );
  process.exit(1);
}

/* Both are published test keys from Anvil. They have never held anything. */
const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const impostor = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

/* The page itself, and that it carries the discovery the desktop path needs. */
const page = await fetch(BASE + '/mini');
const html = await page.text();
check(
  'GET /mini serves the page',
  page.status === 200 && html.includes('eip6963:requestProvider'),
  `${page.status}, ${html.length} bytes`,
);

const challenge = await post('/mini/challenge', { address: account.address });
check(
  'a challenge is issued',
  challenge.status === 200 && !!challenge.body?.message,
  challenge.body?.nonce,
);

const signature = await account.signMessage({ message: challenge.body.message });
const session = await post('/mini/session', { address: account.address, signature });
check(
  'a good signature is accepted',
  session.status === 200 && !!session.body?.token,
  session.body?.token ? session.body.token.slice(0, 20) + '...' : JSON.stringify(session.body),
);

const token = session.body?.token;
const me = await fetch(BASE + '/mini/me', { headers: { authorization: `Bearer ${token}` } });
const whoami = await me.json().catch(() => null);
check(
  'the session names the right account',
  me.status === 200 && whoami?.address === account.address.toLowerCase(),
  JSON.stringify(whoami),
);

/* ── and now the refusals ─────────────────────────────────────────────── */

const replay = await post('/mini/session', { address: account.address, signature });
check('a spent challenge is refused', replay.status === 400, JSON.stringify(replay.body));

const second = await post('/mini/challenge', { address: account.address });
const forged = await impostor.signMessage({ message: second.body.message });
const refused = await post('/mini/session', { address: account.address, signature: forged });
check(
  'a signature from another key is refused',
  refused.status === 401,
  JSON.stringify(refused.body),
);

const [version, payload, mac] = String(token).split('.');
const tampered = `${version}.${payload}.${mac.slice(0, -2)}AA`;
const bad = await fetch(BASE + '/mini/me', { headers: { authorization: `Bearer ${tampered}` } });
check('a tampered token is refused', bad.status === 401, String(bad.status));

const none = await fetch(BASE + '/mini/me');
check('no token is refused', none.status === 401, String(none.status));

/* ── and that the session is a real credential everywhere ─────────────── */

/*
 * The point of minting our own token was to avoid a second API. If these stop
 * accepting it, the web app has quietly become a separate product with its own
 * half-built copy of every route — so this is the claim most worth a check.
 */
const shared = ['/questions/nearby', '/questions/mine', '/questions/taken', '/auth/me'];
for (const path of shared) {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
  check(`a wallet session opens ${path}`, res.status === 200, String(res.status));
}

const counterfeit = await fetch(BASE + '/questions/nearby', {
  headers: { authorization: 'Bearer v1.forged.nope' },
});
check('a forged session opens nothing', counterfeit.status === 401, String(counterfeit.status));

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
