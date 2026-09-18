import cors from 'cors';
import express from 'express';
import { config, hasAdmin, hasAgents, hasDatabase, hasGasWallet, hasPrivy, hasVision } from './config.js';
import { query } from './db.js';
import { evidenceRouter } from './routes/evidence.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { identityRouter } from './routes/identity.js';
import { withdrawRouter } from './routes/withdraw.js';
import { questionsRouter } from './routes/questions.js';
import { agentRouter } from './routes/agent.js';
import { demoRouter } from './routes/demo.js';
import { landingPage } from './landingPage.js';
import { findDoc, legalPage } from './legalPage.js';
import { tidyRouter } from './routes/tidy.js';
import { pushRouter } from './routes/push.js';
import { escrowRouter } from './routes/escrow.js';
import { miniRouter } from './routes/mini.js';
import { storageIsEphemeral, storageIsLocal } from './storage.js';
import { agentAddress, hasAgentWallet } from './agentWallet.js';
import { startAgentSettlement } from './agentSettle.js';
import { keccak256, verifyMessage } from 'viem';
import { startAbandonedSweep } from './closeAbandoned.js';
import { attachRealtime, realtimeStatus } from './realtime.js';
import { chainStatus } from './chain.js';
import { relayerStatus } from './relayer.js';
import { originOf } from './origin.js';

const app = express();

/**
 * No ETags, and nothing cached.
 *
 * Express adds an ETag to every JSON response. The browser then sends
 * If-None-Match on the next request and gets a 304 with an empty body — which
 * for an API means the client has a successful-looking response containing no
 * data. That is exactly what happened to /auth/me: writes returned 200 and
 * every read came back 304, so the app could save a username and then never
 * read it back.
 *
 * Caching is wrong here regardless of the parsing problem. These responses are
 * scoped to whoever holds the bearer token, and a cache keyed only on the URL
 * cannot tell two people apart.
 */
app.set('etag', false);
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/*
   * Railway terminates TLS and forwards plain HTTP. Without this, req.protocol
   * is "http", which put an insecure scheme on every link the landing page
   * wrote about itself, and req.ip is the proxy rather than the caller.
   *
   * One hop, not `true`. There is exactly one proxy in front of this, and the
   * difference matters: `true` makes Express believe the leftmost entry in
   * X-Forwarded-For, which is a header the client writes. The admin desk locks
   * an IP out after five wrong passwords, so a forgeable req.ip is a lockout
   * that never fires — rotate the header, get five fresh attempts, forever.
   * Counting one hop takes the address Railway's edge saw, which a caller
   * cannot reach past.
   */
  app.set('trust proxy', 1);
  app.use(cors());
app.use(express.json({ limit: '1mb' }));

/**
 * One line per request log.
 *
 * Not decoration: the app and the API are separate processes, so when the
 * client reports "nothing saved" the first question is always whether the
 * request arrived at all. Without this, a request that never left the browser
 * and one that was rejected look exactly the same from here.
 */
app.use((req, res, next) => {
  const started = Date.now();

  /**
   * The escrow relays are logged on arrival as well as on completion.
   *
   * Everything else is logged when the response finishes, which is the right
   * default and cannot answer the one question these raise. A relay that never
   * appears might have been sent and abandoned, or never sent at all, and from
   * a finish-only log those are the same silence. Funding has now failed
   * several times with a quote logged and no relay after it, and knowing which
   * of the two it is decides whether to look at the phone or at this server.
   */
  if (req.method === 'POST' && /^\/escrow\/[^/]+\/(fund|claim|release|dispute)$/.test(req.path)) {
    console.log(`ARRIVED ${req.path}`);
    res.on('close', () => {
      if (!res.writableEnded) console.log(`ABANDONED ${req.path} after ${Date.now() - started}ms`);
    });
  }

  res.on('finish', () => {
    const flag = res.statusCode >= 400 ? ' <-- FAILED' : '';
    console.log(
      `${req.method.padEnd(6)} ${req.originalUrl.padEnd(28)} ${res.statusCode} ` +
        `${Date.now() - started}ms${flag}`,
    );
  });
  next();
});

/**
 * Reports what is actually wired up rather than a bare "ok".
 *
 * Every optional dependency here degrades quietly by design — a missing
 * ANTHROPIC_API_KEY skips the relevance check, a missing DATABASE_URL runs the
 * gate without recording it — and quiet degradation is exactly the kind of
 * thing that goes unnoticed in a deployed service until someone asks why
 * nothing was ever checked. This endpoint makes it visible in one request.
 */
app.get('/health', async (_req, res) => {
  let database: 'connected' | 'unreachable' | 'not_configured' = 'not_configured';
  if (hasDatabase()) {
    try {
      await query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'unreachable';
    }
  }

  res.json({
    ok: true,
    database,
    realtime: realtimeStatus(),
    chain: await chainStatus(),
    relayer: await relayerStatus(),
    auth: hasPrivy() ? 'privy' : 'not_configured',
    admin: hasAdmin() ? 'password_set' : 'not_configured',
    vision: hasVision() ? 'configured' : 'not_configured',
    agents: hasAgents()
      ? { enabled: true, wallet: agentAddress(), fundsOnChain: hasAgentWallet() }
      : { enabled: false },
    storage: storageIsEphemeral
      ? 'disk (development only — files are lost on deploy)'
      : config.storageDriver,
    thresholds: {
      sharpness: config.sharpness,
      exposure: config.exposure,
      geo: config.geo,
      maxAttempts: config.maxAttempts,
    },
  });
});

app.use('/auth', authRouter);
app.use('/admin', adminRouter);
app.use('/identity', identityRouter);
app.use('/tidy', tidyRouter);
app.use('/push', pushRouter);
app.use('/withdraw', withdrawRouter);
app.use('/questions', questionsRouter);
// Programs, not phones. The router 404s wholesale when AGENTS_ENABLED is off.
app.use('/agent', agentRouter);
/**
 * The one surface reachable with no credential at all. Spends from a capped
 * budget, because a job posted from a public page is a real job.
 *
 * Mounted twice on purpose. /confamagent is the name; /demo is where it has
 * been linked from since it existed, including from inside a shipped app, and
 * breaking those links to rename a route would be a poor trade.
 */
app.use('/confamagent', demoRouter);
app.use('/demo', demoRouter);
/**
 * The web app: a mini app inside a wallet on a phone, an ordinary web app in a
 * browser on a desktop, one page doing both. Signs in with a wallet signature
 * rather than Privy, because inside somebody else's wallet that is the only
 * credential anybody is carrying.
 */
app.use('/mini', miniRouter);
app.use('/escrow', escrowRouter);
app.use('/evidence', evidenceRouter);

/**
 * Serving the evidence this process is holding.
 *
 * Mounted for a volume as well as a bare disk. It was gated on
 * `storageIsEphemeral`, which meant the moment the driver became persistent
 * the files stopped being reachable — a deployed server that stored evidence
 * correctly and then served 404 for every photo of it.
 */
if (storageIsLocal) {
  app.use('/media', express.static(config.storageDir));
}

/**
 * The website.
 *
 * On the API rather than a separate host because it needs to exist today and
 * has three jobs: somewhere to send people, somewhere the app stores can find
 * a privacy policy at a public URL, and somewhere the builds download from.
 *
 * Last, so nothing here can shadow a route that carries data.
 */

app.get('/', (req, res) => {
  res.type('html').send(landingPage(originOf(req)));
});

for (const [path, slug] of [
  ['/terms', 'terms'],
  ['/privacy', 'privacy'],
  ['/licences', 'open source'],
] as const) {
  app.get(path, (req, res) => {
    const doc = findDoc(slug);
    if (!doc) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.type('html').send(legalPage(doc, originOf(req)));
  });
}

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const server = app.listen(config.port, () => {
  console.log(`confam api on :${config.port}`);
  if (!hasDatabase()) console.log('  DATABASE_URL unset — checks run but nothing is recorded');
  if (!hasPrivy()) console.log('  PRIVY_APP_ID/SECRET unset — every request is unauthenticated');
  if (!hasAdmin()) console.log('  ADMIN_PASSWORD_HASH unset — the review desk is unreachable');
  if (!hasGasWallet()) console.log('  GAS_WALLET_PRIVATE_KEY unset — withdrawals are disabled');
  if (!hasVision()) console.log('  OPENAI_API_KEY unset — relevance check will be skipped');
  if (storageIsEphemeral) console.log('  disk storage — development only, files are lost on deploy');
  if (config.storageDriver === 'volume') console.log(`  volume storage at ${config.storageDir}`);

  /**
   * Verifiers whose asker was a program that never came back get paid anyway.
   *
   * An agent may poll once and never call accept, or be a key that no longer
   * exists. The evidence is in, the money is in escrow, and without this the
   * person who walked there waits for a decision nobody will make.
   */
  startAgentSettlement();
  startAbandonedSweep();
});

// Shares the HTTP server, so realtime needs no second port and no second
// Railway service — one deploy, one domain, one thing to keep alive.
attachRealtime(server);
