import 'dotenv/config';

/**
 * Accepts a private key with or without the 0x prefix.
 *
 * Exporters disagree: some hand back 64 bare hex characters, others prefix
 * them. Both are the same key, and rejecting one of them produces a
 * "withdrawals unavailable" message that gives no hint the only problem is two
 * missing characters.
 */
function normaliseKey(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return '';
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Every threshold is tunable from the environment, because the defaults below
 * are educated starting points rather than measured ones. They were chosen
 * from how the metrics behave in general, not from a corpus of real Lagos
 * street photos. Expect to move them once there is a week of real submissions
 * to look at — that is why none of them are hard-coded at the call site.
 */
export const config = {
  port: num('PORT', 8080),
  databaseUrl: process.env.DATABASE_URL ?? '',

  /** Where uploads land. See storage.ts — the disk driver is dev-only. */
  storageDriver: (process.env.STORAGE_DRIVER ?? 'disk') as 'disk' | 'volume' | 'object',

  agents: {
    /**
     * One switch for the whole agent surface. Anything added for agents hangs
     * off this, so turning it off is a decision that can be made in one place
     * by somebody who does not remember what was built.
     */
    enabled: (process.env.AGENTS_ENABLED ?? '').toLowerCase() === 'true',
    /** What an agent pays when an existing answer is reused instead of a trip. */
    cachedFeeKobo: num('AGENT_CACHED_FEE_KOBO', 5_000),
    /**
     * How old a verified answer can be before it is never reused.
     *
     * A day. Above the model rather than instead of it: within the window the
     * judgment decides, because a fuel queue goes stale in an hour and roadworks
     * do not, and past it nothing is offered as the current state of a place
     * however good it looks.
     */
    maxAgeMinutes: num('AGENT_MAX_AGE_MINUTES', 1_440),

    /**
     * The key the public demo posts with, and what it may spend.
     *
     * A job posted from a page anybody can open is a real job: money leaves a
     * real balance and somebody may walk somewhere for it. So the demo spends
     * from one account against a ceiling, and says so when the ceiling is
     * reached rather than failing in a way that looks like a bug.
     *
     * Unset means the demo cannot post at all, which is the right default for
     * a server nobody has given a budget to.
     */
    demoKey: process.env.AGENT_DEMO_KEY ?? '',
    demoBudgetKobo: num('AGENT_DEMO_BUDGET_KOBO', 500_000),
    /**
     * ₦150 a job, and never more.
     *
     * The app's own MIN_BOUNTY, and a hard ceiling rather than a default: this
     * is spent by anybody who opens a public page, so the only safe amount is
     * the smallest one that still buys a real trip. A configuration mistake
     * should not be able to raise it, so the environment can lower this and
     * cannot lift it.
     */
    demoBountyKobo: Math.min(num('AGENT_DEMO_BOUNTY_KOBO', 15_000), 15_000),
  },

  /**
   * Where the landing page sends people to install the app.
   *
   * Unset is a real state, not a misconfiguration: a build takes half an hour
   * and a TestFlight review takes longer, so the page says "coming soon"
   * rather than offering a link to nothing.
   */
  links: {
    apk: process.env.ANDROID_APK_URL ?? '',
    testflight: process.env.IOS_TESTFLIGHT_URL ?? '',
    support: process.env.SUPPORT_EMAIL ?? 'help@confam.xyz',
    /*
     * Where people go to check we are real. Each renders only when it is set,
     * so an unset one leaves no dead link on the page rather than pointing at
     * an empty profile.
     */
    x: process.env.X_URL ?? '',
    github: process.env.GITHUB_URL ?? '',
    telegram: process.env.TELEGRAM_URL ?? '',
  },
  /**
   * The address the pages should call themselves, when something sits in
   * front of this server. Unset in development, where the request is honest.
   */
  publicOrigin: (process.env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, ''),

  storageDir: process.env.STORAGE_DIR ?? '.uploads',

  /**
   * Privy. The app ID is public and also ships in the client; the secret is
   * server-only and must never reach the bundle — anything prefixed
   * EXPO_PUBLIC_ is inlined into the app and readable by anyone who installs
   * it.
   */
  privy: {
    appId: process.env.PRIVY_APP_ID ?? '',
    appSecret: process.env.PRIVY_APP_SECRET ?? '',
  },

  /**
   * The review desk's shared password, stored only as a scrypt hash. The
   * plaintext exists nowhere on the server — see adminAuth.ts.
   */
  admin: { passwordHash: process.env.ADMIN_PASSWORD_HASH ?? '' },

  /**
   * Polygon, where the mini app's money is.
   *
   * Separate from `chain` rather than folded into it, because it is not this
   * server's chain: the escrow is on Base and settlement happens there. This
   * exists because the mini app runs inside a wallet host that offers Polygon
   * and not Base, so the balance somebody sees inside Nimiq Pay has to be the
   * USDT they are actually holding. Reading it from Base and calling it their
   * balance would be answering a different question to the one being asked.
   */
  polygon: {
    /*
     * publicnode, not polygon-rpc.com. The latter is the address everybody
     * reaches for first and it now answers every call with "API key disabled,
     * tenant disabled" — a 401 dressed as JSON, which surfaces here as a
     * balance that cannot be read rather than as anything resembling a
     * configuration error. Checked before it was chosen; 1rpc.io/matic and
     * polygon.drpc.org also answer, if this one stops.
     */
    rpcUrl: process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com',
    /** USDT on Polygon. Six decimals, like USDC — not the eighteen most use. */
    usdt: (
      process.env.POLYGON_USDT_ADDRESS ?? '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
    ).toLowerCase(),
    chainId: num('POLYGON_CHAIN_ID', 137),
    /**
     * AskEscrow on Polygon. Empty until it is deployed, and empty is a real
     * state rather than a misconfiguration: the mini app reads its balance
     * from Polygon whether or not anything can be funded there yet.
     */
    escrowAddress: (process.env.POLYGON_ESCROW_ADDRESS ?? '').toLowerCase(),
  },

  /**
   * Base mainnet. The defaults are the public endpoint and the canonical USDC
   * contract, both overridable — the public RPC rate-limits, so anything with
   * real traffic wants an Alchemy or QuickNode URL here.
   */
  chain: {
    rpcUrl: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    /**
     * A second endpoint, for log scans only.
     *
     * The two jobs want opposite things from a provider and no free endpoint
     * does both. Alchemy reports nonces correctly, which the public Base RPC
     * does not — it served a pending nonce below its own latest and rejected
     * every relayed transaction. But Alchemy's free tier caps eth_getLogs at a
     * *ten block* range, and a deposit scan covers tens of thousands.
     *
     * So transactions go to the accurate endpoint and log scans to the
     * permissive one. Defaults to rpcUrl, which is right for any paid provider
     * where one endpoint can do both.
     */
    logsRpcUrl:
      process.env.BASE_LOGS_RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    usdc: (process.env.USDC_ADDRESS ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913').toLowerCase(),
    chainId: num('BASE_CHAIN_ID', 8453),
    /** How long a balance read is reused. Base blocks are about 2s. */
    cacheMs: num('BALANCE_CACHE_MS', 5_000),
    /**
     * Base's public RPC refuses an eth_getLogs range over 10,000 blocks, so
     * scans are chunked below it. A paid endpoint usually allows far more.
     */
    logChunk: num('LOG_CHUNK_BLOCKS', 9_500),
    /**
     * How far back a first scan looks: ~28 hours at 2s blocks. Bounded because
     * a new wallet cannot have older deposits, and scanning all of Base to
     * prove it would be thousands of requests.
     */
    firstScanBlocks: num('FIRST_SCAN_BLOCKS', 50_000),
    /** Chunks per sync, so one request cannot run for minutes. */
    maxChunksPerSync: num('MAX_CHUNKS_PER_SYNC', 8),

    /**
     * The account that pays gas so nobody else has to.
     *
     * Withdrawals use EIP-3009: the person signs an authorisation off-chain,
     * costing them nothing and requiring no ETH, and this key submits it and
     * pays. It therefore needs a small ETH balance on Base and no USDC — it
     * never holds anyone's money, it only relays.
     *
     * Server-side only. It must never be prefixed EXPO_PUBLIC_, which would
     * inline it into the app bundle for anyone to read.
     */
    gasWalletKey: normaliseKey(process.env.GAS_WALLET_PRIVATE_KEY),

    /** Refuse to relay below this, since a stuck relayer strands withdrawals. */
    minGasWalletEth: num('MIN_GAS_WALLET_ETH', 0.0002),

    /**
     * The wallet an agent pays from.
     *
     * Distinct from the gas wallet, which relays and never custodies: this one
     * holds USDC and spends it. Separate keys because they fail differently —
     * an empty gas wallet stops withdrawals, an empty agent wallet stops
     * agents, and one key doing both makes either failure look like the other.
     *
     * Server-side only. Never prefix it EXPO_PUBLIC_.
     */
    agentWalletKey: normaliseKey(process.env.AGENT_WALLET_PRIVATE_KEY ?? ''),

    /**
     * The account the contract accepts rulings from.
     *
     * Its own key, because resolve() is onlyArbiter and neither the relayer
     * nor the agent wallet is it. Unset means the desk can still record a
     * decision and will say plainly that the escrow was not moved — which is
     * the honest version of what it was doing silently before.
     *
     * Needs a little ETH on Base: it sends the transaction itself.
     */
    arbiterKey: normaliseKey(process.env.ARBITER_PRIVATE_KEY ?? ''),

    /**
     * The AskEscrow proxy. The proxy address, never the implementation —
     * the proxy holds the money and survives every upgrade, while the
     * implementation holds only code and would be empty.
     */
    escrowAddress: (process.env.ESCROW_ADDRESS ?? '').toLowerCase(),
  },

  /**
   * Naira conversion. The default provider is free and needs no key; rates
   * move slowly enough that an hour of cache costs nothing in accuracy.
   */
  rates: {
    url: process.env.FX_RATE_URL ?? 'https://open.er-api.com/v6/latest/USD',
    cacheMs: num('FX_CACHE_MS', 60 * 60 * 1000),
    /**
     * Used only when the live rate cannot be had at all.
     *
     * Refusing to price a job sounds cautious and is not: it leaves the job on
     * the board with no escrow behind it, so somebody can see it and walk for
     * money that was never locked. A rate a few percent stale is a far smaller
     * error than that, and the one actually used is recorded on the row either
     * way.
     */
    fallbackNgnPerUsd: num('FX_FALLBACK_NGN_PER_USD', 1550),
  },

  /**
   * The vision provider's key. Named for the job, not the vendor — this has
   * been Anthropic and is now OpenAI, and the rest of the app never cared.
   */
  visionKey: process.env.OPENAI_API_KEY ?? '',
  /** Vision model for the relevance check. */
  visionModel: process.env.VISION_MODEL ?? 'gpt-5',

  media: {
    maxBytes: num('MAX_UPLOAD_BYTES', 40 * 1024 * 1024),
    maxPhotos: num('MAX_PHOTOS', 5),
    maxVideoSeconds: num('MAX_VIDEO_SECONDS', 30),
    /** Below this a clip is too short to show anything. */
    minVideoSeconds: num('MIN_VIDEO_SECONDS', 2),
  },

  /**
   * Laplacian variance, measured on a 640px-wide greyscale copy so the number
   * means the same thing regardless of what the camera produced.
   *
   * Higher is sharper. A crisp photo lands in the hundreds; a smeared one in
   * the low tens. The gap between `retake` and `warn` is deliberately wide —
   * anything in between is judged by a person, not by this number.
   */
  sharpness: {
    retakeBelow: num('SHARPNESS_RETAKE_BELOW', 40),
    warnBelow: num('SHARPNESS_WARN_BELOW', 90),
  },

  /** Mean luma, 0–255, on the same greyscale copy. */
  exposure: {
    darkRetakeBelow: num('EXPOSURE_DARK_RETAKE_BELOW', 22),
    darkWarnBelow: num('EXPOSURE_DARK_WARN_BELOW', 45),
    brightWarnAbove: num('EXPOSURE_BRIGHT_WARN_ABOVE', 225),
    /** Fraction of pixels pinned at pure black or pure white. */
    clippedWarnAbove: num('EXPOSURE_CLIPPED_WARN_ABOVE', 0.45),
  },

  /**
   * How far the phone may be from the pin before it is worth mentioning.
   *
   * Never a rejection. Consumer GPS is routinely 20–50m out, worse between tall
   * buildings, and a market or a mall is far larger than the single point that
   * represents it. This produces a line of text for the asker, nothing more.
   */
  geo: {
    nearMetres: num('GEO_NEAR_METRES', 150),
    farMetres: num('GEO_FAR_METRES', 600),
  },

  /** Frames sampled from a clip for the sharpness and relevance checks. */
  video: { framesSampled: num('VIDEO_FRAMES_SAMPLED', 3) },

  /** Retakes allowed before the job is handed back to the pool. */
  maxAttempts: num('MAX_SUBMISSION_ATTEMPTS', 3),
} as const;

export const hasDatabase = () => config.databaseUrl.length > 0;
/**
 * Whether this server answers to programs as well as to people.
 *
 * Off by default, and off means gone: the /agent routes 404, keys cannot be
 * minted or used, and the app behaves exactly as it did before any of it
 * existed. Built that way on purpose — the agent surface is a bet, and a bet
 * you cannot withdraw from is a liability rather than an experiment.
 */
export const hasAgents = () => config.agents.enabled;
export const hasPrivy = () =>
  config.privy.appId.length > 0 && config.privy.appSecret.length > 0;
export const hasVision = () => config.visionKey.length > 0;
export const hasAdmin = () => config.admin.passwordHash.length > 0;
export const hasEscrow = () => /^0x[0-9a-f]{40}$/.test(config.chain.escrowAddress);
export const hasGasWallet = () => /^0x[0-9a-fA-F]{64}$/.test(config.chain.gasWalletKey);
