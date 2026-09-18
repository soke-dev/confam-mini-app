import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { API_BASE, setUnauthorizedHandler } from './api';
import {
  type AuthState,
  type AuthUser,
  type EmailLogin,
  type EnsureWallet,
  type SignTypedData,
} from './privyShared';

/**
 * Signing in with a wallet instead of with Privy.
 *
 * This exists so the mini app can be the app. Inside Nimiq Pay there is no
 * email round trip to run and no embedded wallet to create — the host has
 * already put a wallet in front of us, and it is the only credential anybody
 * there is carrying. Asking such a person for an email address and a six digit
 * code would be asking them to make a second account for the wallet they are
 * already holding.
 *
 * It implements the same interface as the Privy halves, deliberately and to
 * the letter. Every screen in this app reads `useAuth()` and every request
 * goes out with whatever `getToken()` returns, so satisfying that contract is
 * the whole of the work: nothing above this file knows which one it got, and
 * no screen had to be rewritten to run here.
 *
 * Browser only. Metro picks it through privy.web.ts, and it is chosen at build
 * time rather than sniffed at runtime, because the admin desk is also a
 * browser and may well have a wallet extension installed.
 */

/** The minimum of EIP-1193 this file needs. */
type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (payload: never) => void) => void;
};

export type FoundWallet = {
  name: string;
  /** Reverse-DNS id, where the wallet announced one. */
  rdns: string;
  /** A data: URI, or empty. Never a remote URL — see remember(). */
  icon: string;
  provider: Eip1193;
};

type Session = { token: string; expires: number; address: string };

const SESSION_KEY = 'confam.wallet.session';

/* ── A store, because this lives outside React ────────────────────────── */

/*
 * Restored at module load, not in an effect.
 *
 * Reading it inside useAuth's effect set the variable without telling the
 * store, so the first snapshot React took was the empty one and nothing ever
 * told it otherwise: a returning user was shown the sign-in screen despite
 * holding a perfectly good session. Doing it here means the very first
 * snapshot is already the truth.
 */
let session: Session | null = null;
let wallets: FoundWallet[] = [];
let connected: FoundWallet | null = null;
let address = '';
let ready = false;

const listeners = new Set<() => void>();

function emit(): void {
  /*
   * A new array each time. useSyncExternalStore compares snapshots by
   * identity, so mutating the existing one in place would change nothing it
   * can see and the wallet list would never appear.
   */
  wallets = wallets.slice();
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const browser = (): boolean => typeof window !== 'undefined';

/* ── Session ──────────────────────────────────────────────────────────── */

function readStored(): Session | null {
  if (!browser()) return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.token || !parsed.expires || !parsed.address) return null;
    if (parsed.expires < Date.now()) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed as Session;
  } catch {
    return null;
  }
}

session = readStored();

function store(next: Session | null): void {
  session = next;
  try {
    if (!browser()) return;
    if (next) window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* Private mode. The session still works for this page view. */
  }
  emit();
}

/* ── Discovery ────────────────────────────────────────────────────────── */

const seen = new Set<string>();

/** The only wallet this app talks to. */
const NIMIQ_PAY = 'com.nimiq.pay';

/**
 * Keeps the host's wallet, and leaves every other one alone.
 *
 * EIP-6963 is an Ethereum standard, but announcing on it has become how every
 * extension makes itself visible — so a browser with a normal spread installed
 * announces Cosmos, Solana, Polkadot and Hedera wallets alongside anything
 * that could work here.
 *
 * This used to call eth_chainId on each of them to find out which could sign.
 * It is a read, it needs no permission and it should prompt nobody, and some
 * wallets prompt anyway: Keplr opened its own window on a page that had not
 * offered it, was not going to offer it, and had no use for it. A wallet the
 * app will never ask to sign should not be touched at all, and asking it a
 * question is touching it.
 *
 * So nothing is probed. Confam runs as a mini app, the wallet is the one the
 * host provides, and every other announcement is noted and dropped. On a
 * desktop the list is simply empty, which is the truth there and is what the
 * sign-in screen already says.
 */
function remember(entry: FoundWallet): void {
  const key = entry.rdns || entry.name;
  if (seen.has(key)) return;
  seen.add(key);

  if (entry.rdns !== NIMIQ_PAY) return;

  wallets.push(entry);
  emit();
}

export function inNimiqPay(): boolean {
  return browser() && typeof (window as { nimiqPay?: unknown }).nimiqPay !== 'undefined';
}

let discovering = false;

function discover(): void {
  if (!browser() || discovering) return;
  discovering = true;

  window.addEventListener('eip6963:announceProvider', (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { info?: { name?: string; rdns?: string; icon?: string }; provider?: Eip1193 }
      | undefined;
    if (!detail?.provider) return;

    const icon = detail.info?.icon ?? '';
    remember({
      name: detail.info?.name ?? 'Wallet',
      rdns: detail.info?.rdns ?? '',
      /*
       * Only a data: image. This string comes from a browser extension, and a
       * remote icon URL would let one see every page load. Anything else is
       * dropped and the row draws initials instead.
       */
      icon: icon.startsWith('data:image/') ? icon : '',
      provider: detail.provider,
    });
  });

  window.dispatchEvent(new Event('eip6963:requestProvider'));

  setTimeout(() => {
    /*
     * The single-slot provider, once announcements have had a tick to arrive,
     * and kept only when this really is the host. Nimiq
     * Pay injects at window.ethereum and announces nothing over EIP-6963, so
     * without this there would be no wallet inside the app at all — and
     * outside it, window.ethereum is somebody's extension, which remember()
     * drops for the reasons above.
     */
    const injected = (window as { ethereum?: Eip1193 }).ethereum;
    if (injected && inNimiqPay() && !wallets.some((w) => w.provider === injected)) {
      remember({ name: 'Nimiq Pay', rdns: NIMIQ_PAY, icon: '', provider: injected });
    }

    ready = true;
    emit();
    void reconnect();
  }, 150);
}

/**
 * Re-attaches to the wallet a stored session names, without prompting.
 *
 * eth_accounts reports what is already authorised and raises no dialog, so
 * this is only ever a reconnection. Somebody returning to the app is put back
 * where they were rather than being asked to approve anything again.
 */
async function reconnect(): Promise<void> {
  const target = session?.address.toLowerCase() ?? null;

  /* Asked of every wallet at once, since none of them will prompt. */
  const answers = await Promise.all(
    wallets.map(async (entry) => {
      try {
        const accounts = (await entry.provider.request({ method: 'eth_accounts' })) as string[];
        return { entry, accounts: (accounts ?? []).map(String) };
      } catch {
        /* A wallet that will not answer is simply not the one. */
        return { entry, accounts: [] as string[] };
      }
    }),
  );

  const live = answers.filter((a) => a.accounts.length > 0);

  /* A stored session names an address, so take the wallet holding that one. */
  if (target) {
    const match = live.find((a) => a.accounts.some((x) => x.toLowerCase() === target));
    if (match) {
      connected = match.entry;
      address = match.accounts[0];
      listen(match.entry);
      emit();
      return;
    }
  }

  /**
   * No session, but a wallet that has already authorised an account.
   *
   * Worth adopting, because it turns signing in from two prompts into one:
   * the account is granted already, so all that is left is the signature.
   * Inside Nimiq Pay that is the normal case — the host grants the account by
   * being the host — and it is what makes the first run there a single
   * approval rather than two.
   *
   * Only when exactly one wallet answers. With several connected there is no
   * way to tell which one somebody means, and quietly choosing for them would
   * sign them in as an address they did not pick.
   */
  if (!connected && live.length === 1) {
    const only = live[0];
    connected = only.entry;
    address = only.accounts[0];
    listen(only.entry);
    emit();
  }
}

function listen(entry: FoundWallet): void {
  const provider = entry.provider as Eip1193 & { confamWatched?: boolean };
  if (!provider.on || provider.confamWatched) return;
  provider.confamWatched = true;

  provider.on('accountsChanged', ((accounts: string[]) => {
    const next = accounts?.[0] ?? '';
    /*
     * A different address is a different person. Keeping the session would
     * leave the app showing one account while the wallet signs as another,
     * which is the sort of mismatch that ends with money going somewhere
     * nobody chose.
     */
    switchedToPolygon = false;
    if (session && next.toLowerCase() !== session.address.toLowerCase()) store(null);
    address = next;
    if (!next) connected = null;
    emit();
  }) as (payload: never) => void);
}

/* ── Connecting and signing in ────────────────────────────────────────── */

export async function connect(entry: FoundWallet): Promise<void> {
  const accounts = (await entry.provider.request({ method: 'eth_requestAccounts' })) as string[];
  const found = accounts?.[0];
  if (!found) throw new Error('That wallet returned no account.');

  connected = entry;
  address = found;
  listen(entry);
  emit();
}

/**
 * Exchanges a signature for a session.
 *
 * The message is fetched rather than composed here: the server decides what it
 * will accept, including the nonce that stops a signature being replayed, so
 * composing it on this side would only create something to disagree about.
 */
export async function signIn(): Promise<void> {
  if (!connected || !address) throw new Error('Connect a wallet first.');

  const challenge = await fetch(`${API_BASE}/mini/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  }).then((r) => r.json() as Promise<{ message?: string }>);

  if (!challenge.message) throw new Error('The server would not issue a challenge.');

  /*
   * A plain string rather than hex. Both are legal and hex is the tidier
   * answer, but the string form is the one proven through Nimiq Pay's bridge
   * on a real device, and MetaMask has always taken either. Nothing is gained
   * by swapping something tested for something merely standard.
   */
  const signature = (await connected.provider.request({
    method: 'personal_sign',
    params: [challenge.message, address],
  })) as string;

  const result = await fetch(`${API_BASE}/mini/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, signature }),
  }).then((r) => r.json() as Promise<{ token?: string; expires?: number; detail?: string }>);

  if (!result.token || !result.expires) {
    throw new Error(result.detail ?? 'That signature was not accepted.');
  }

  store({ token: result.token, expires: result.expires, address });
}

/**
 * Connect and sign in, as one action.
 *
 * These are two calls to the wallet and cannot be made into one: asking for
 * accounts and asking for a signature are separate methods, and there is no
 * standard that fuses them. What was ours to remove is the tap in between —
 * connecting, then landing on a screen whose only purpose was to hold the
 * button that did the obvious next thing.
 *
 * Inside Nimiq Pay this usually shows a single prompt, because the host has
 * already granted the account and the connect resolves without asking. On a
 * desktop the first run shows two, then one thereafter.
 *
 * If the signature fails the connection is kept rather than torn down. That
 * leaves the screen able to offer the signature again on its own, instead of
 * making somebody approve the account a second time to retry the half that
 * actually failed.
 */
export async function connectAndSignIn(entry: FoundWallet): Promise<void> {
  if (connected !== entry || !address) await connect(entry);

  /*
   * On the right chain from the start, rather than at the first signature that
   * happens to care. Doing it here also means the balance read afterwards is
   * of the chain the money is actually on, instead of whichever one the host
   * happened to open with.
   *
   * Not fatal if it fails: signing in is proving who you are, and that works
   * on any chain. Whatever needs Polygon asks again when it needs it.
   */
  await ensurePolygon().catch(() => {});

  await signIn();
}

/* ── The hooks the app expects ────────────────────────────────────────── */

type Snapshot = { session: Session | null; wallets: FoundWallet[]; ready: boolean };

let snapshot: Snapshot = { session: null, wallets: [], ready: false };

function currentSnapshot(): Snapshot {
  /*
   * Rebuilt only when something actually changed. useSyncExternalStore calls
   * this on every render and throws if it keeps getting fresh objects, so the
   * identity has to be stable between real changes.
   */
  if (
    snapshot.session !== session ||
    snapshot.wallets !== wallets ||
    snapshot.ready !== ready
  ) {
    snapshot = { session, wallets, ready };
  }
  return snapshot;
}

const emptySnapshot: Snapshot = { session: null, wallets: [], ready: false };

function useStore(): Snapshot {
  return useSyncExternalStore(subscribe, currentSnapshot, () => emptySnapshot);
}

export function useAuth(): AuthState & {
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
} {
  const snap = useStore();

  useEffect(() => {
    discover();

    /**
     * A session the server has stopped honouring is not a session.
     *
     * It lapses on expiry, on the account being re-keyed, and on the signing
     * secret changing — which in development is every restart, because an
     * unset MINI_SESSION_SECRET means the key is invented at boot. Whatever
     * the cause, the person is holding a string that no longer opens
     * anything, and without this they find out through an "invalid_token"
     * error on whichever screen they happened to be using.
     *
     * Clearing it puts them back at sign-in, where the wallet is waiting.
     */
    setUnauthorizedHandler(() => {
      if (session) store(null);
    });

    return () => setUnauthorizedHandler(null);
  }, []);

  const user = useMemo<AuthUser | null>(() => {
    if (!snap.session) return null;
    return {
      /*
       * There is no Privy DID here, and inventing something that looks like
       * one would be worse than saying plainly what this is. The address is
       * already the stable key: it is what the server keys the account on.
       */
      did: `wallet:${snap.session.address}`,
      email: null,
      walletAddress: snap.session.address.toLowerCase(),
    };
  }, [snap.session]);

  const signOut = useCallback(async () => {
    store(null);
    connected = null;
    address = '';
  }, []);

  const getToken = useCallback(async () => session?.token ?? null, []);

  return { ready: snap.ready, user, signOut, getToken };
}

/** Everything that can sign, for the sign-in screen to offer. */
export function useWalletChoices(): {
  wallets: FoundWallet[];
  ready: boolean;
  connected: FoundWallet | null;
  address: string;
} {
  const snap = useStore();

  useEffect(() => {
    discover();
  }, []);

  return { wallets: snap.wallets, ready: snap.ready, connected, address };
}

/**
 * The email flow, which does not exist here.
 *
 * The interface requires it, so it is present and honest rather than absent
 * and crashing: anything that calls it is told, in the same `error` field
 * every other failure uses, that this build signs in with a wallet.
 */
export function useEmailLogin(): EmailLogin {
  const [error, setError] = useState<string | null>(null);

  const refuse = useCallback(async () => {
    setError('This app signs in with your wallet, not with an email address.');
    throw new Error('email login is not available in wallet mode');
  }, []);

  return { sendCode: refuse, loginWithCode: refuse, state: error ? 'error' : 'initial', error };
}

/**
 * Nothing to create. The wallet arrived with the person, which is the whole
 * difference between this and the embedded-wallet flow.
 */
export function useEnsureWallet(): EnsureWallet {
  return useCallback(async () => {}, []);
}

/**
 * Makes sure there is a wallet to sign with, asking for one if there is not.
 *
 * The silent reconnection on load uses eth_accounts, which reports what is
 * already authorised without prompting. That is the right call there — but it
 * is not a method Nimiq Pay's documentation lists as supported, and if it is
 * absent or answers with nothing then `connected` stays null while a perfectly
 * good session sits in storage.
 *
 * That is what "no prompt appeared" looks like from the inside: signing threw
 * before it ever reached the wallet, so there was nothing to approve and
 * nothing to cancel. The bounty could not be locked, and the wallet was never
 * even asked.
 *
 * eth_requestAccounts is documented and does prompt, so asking again here
 * costs a tap in the worst case and removes the dependency entirely. When a
 * session names an address, only a wallet holding that address will do —
 * signing as somebody else would produce a signature the escrow rejects.
 */
async function ensureConnected(): Promise<void> {
  if (connected && address) return;

  /*
   * Discovery is kicked off by useAuth's effect, which has almost certainly
   * run by the time anybody is signing something. Almost is not a good enough
   * reason to fail with "no wallet" when the real answer is "not yet", so if
   * the list is empty, ask and give the announcements a moment to arrive.
   */
  if (wallets.length === 0) {
    discover();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const target = session?.address.toLowerCase() ?? null;

  for (const entry of wallets) {
    try {
      const accounts = (await entry.provider.request({
        method: 'eth_requestAccounts',
      })) as string[];
      const first = (accounts ?? [])[0];
      if (!first) continue;
      if (target && !accounts.some((a) => String(a).toLowerCase() === target)) continue;

      connected = entry;
      address = first;
      listen(entry);
      emit();
      return;
    } catch {
      /* Refused or unreachable. Try the next one. */
    }
  }

  throw new Error(
    target
      ? 'Could not reach the wallet holding this account. Open this page in that wallet and try again.'
      : 'No wallet is connected.',
  );
}

/** Polygon, where the mini app's escrow and money are. */
const POLYGON_HEX = '0x89';

/**
 * Puts the wallet on Polygon before anything is signed against it.
 *
 * Nimiq Pay opens on Ethereum, and nothing in the app was moving it. That was
 * invisible for funding, because a permit is signed against the token's own
 * EIP-712 domain, which uses `salt` and carries no chainId for a wallet to
 * object to — so the bounty locked perfectly well while the wallet sat on the
 * wrong chain.
 *
 * Claiming and releasing are signed against the escrow's domain, which does
 * carry one. A wallet compares it to the chain it is connected to and refuses
 * outright: "provided chain id does not match the current active chain", with
 * no prompt, because there is nothing to show somebody about a signature it
 * will not request. The verifier's claim never reached the contract, the job
 * stayed Funded with nobody recorded to pay, and the asker's release then
 * failed against a job that had never been claimed.
 *
 * Idempotent and cheap: a wallet already on Polygon returns immediately
 * without troubling anyone.
 */
/**
 * Remembered for the session, because the host does not always admit to it.
 *
 * The cheap check is eth_chainId, which prompts nobody. It stopped being
 * enough: Nimiq Pay honours the switch for the request that follows, and then
 * goes on reporting the chain it opened with — so every signature saw the
 * wrong answer, asked again, and somebody approved the same switch four times
 * for one job.
 *
 * Cleared whenever the account changes, and cleared again by a signature that
 * fails on the chain, so a stale yes costs one retry rather than a dead end.
 */
let switchedToPolygon = false;

export function forgetChainSwitch(): void {
  switchedToPolygon = false;
}

async function ensurePolygon(): Promise<void> {
  if (!connected || switchedToPolygon) return;

  const current = (await connected.provider
    .request({ method: 'eth_chainId' })
    .catch(() => null)) as string | null;
  if (current === POLYGON_HEX) {
    switchedToPolygon = true;
    return;
  }

  try {
    await connected.provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: POLYGON_HEX }],
    });
  } catch (cause) {
    /*
     * 4902 is a wallet that has never heard of the chain, which is a thing to
     * fix rather than a failure to report: offer the details and try again.
     */
    if ((cause as { code?: number } | null)?.code !== 4902) throw cause;

    await connected.provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: POLYGON_HEX,
          chainName: 'Polygon',
          nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
          rpcUrls: ['https://polygon-rpc.com'],
          blockExplorerUrls: ['https://polygonscan.com'],
        },
      ],
    });
  }

  switchedToPolygon = true;
}

export function useSignAuthorization(): SignTypedData {
  return useCallback(async (typedData) => {
    await ensureConnected();
    if (!connected || !address) throw new Error('No wallet is connected.');
    await ensurePolygon();

    /*
     * Signed by the person's own wallet, so this raises a prompt they must
     * approve — unlike the embedded wallet, which signs on their behalf. That
     * is not a regression: it is what holding your own keys means.
     */
    const sign = () =>
      connected!.provider.request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify(typedData)],
      });

    try {
      return String(await sign());
    } catch (cause) {
      /*
       * A remembered switch that turned out to be stale. The wallet says so
       * plainly, so take it at its word, ask again and retry once — rather
       * than reporting a chain problem to somebody who already approved the
       * chain.
       */
      const message = (cause as { message?: string } | null)?.message ?? '';
      if (!/chain/i.test(message)) throw cause;

      switchedToPolygon = false;
      await ensurePolygon();
      return String(await sign());
    }
  }, []);
}
