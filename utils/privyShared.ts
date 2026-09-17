import { base } from 'viem/chains';

/**
 * The shared auth contract. No SDK imports live here.
 *
 * Privy ships separate SDKs for web and native and they do not share an API:
 * `@privy-io/react-auth` is a browser library that talks to window.crypto and
 * localStorage, while `@privy-io/expo` needs secure-store, passkeys and a
 * native extension module. Neither runs on the other's platform.
 *
 * Metro resolves `privy.web.ts` and `privy.native.ts` automatically by
 * platform, so screens import from here and never learn which one they got.
 * This file holds only the shared contract — importing either SDK here would
 * pull the wrong one into the wrong bundle.
 */

/** Embedded wallets are created on Base. Same chain both platforms. */
export const WALLET_CHAIN = base;
export const WALLET_CHAIN_NAME = 'base';

export const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? '';

/**
 * The native SDK additionally requires a Client ID, created per-platform in
 * the Privy dashboard under the app's "clients". The web SDK does not use one.
 */
export const PRIVY_CLIENT_ID = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? '';

export const privyConfigured = PRIVY_APP_ID.length > 0;

/**
 * Whether this build signs in with a wallet instead of with Privy.
 *
 * Set for the mini app, which runs inside a wallet host where there is no
 * email round trip worth running and no embedded wallet worth creating: the
 * host has already put a wallet in front of the person, and it is the only
 * credential they are carrying.
 *
 * Decided at build time rather than sniffed at runtime, and deliberately so.
 * The admin desk is also a browser build, and whoever opens it may well have a
 * wallet extension installed — detecting one and switching auth on that basis
 * would change how somebody signs in depending on what they happen to have
 * installed, which is not a decision the page should be making for them.
 */
export const WALLET_MODE = process.env.EXPO_PUBLIC_AUTH === 'wallet';

export type AuthUser = {
  /** Privy DID — stable across email changes. The key the API stores. */
  did: string;
  email: string | null;
  /** Embedded Base wallet, once provisioned. Null while it is being created. */
  walletAddress: string | null;
};

export type AuthState = {
  /** False until the SDK has restored any existing session from storage. */
  ready: boolean;
  user: AuthUser | null;
};

/**
 * The email one-time-code flow, as both SDKs express it.
 *
 * Two steps rather than one because that is what the user sees: type an
 * address, then type the six digits that arrive. `sendCode` may be called
 * again for a resend.
 */
export type EmailLogin = {
  sendCode: (email: string) => Promise<void>;
  loginWithCode: (code: string) => Promise<void>;
  /** 'initial' | 'sending' | 'awaiting-code' | 'submitting' | 'done' */
  state: EmailLoginState;
  error: string | null;
};

export type EmailLoginState =
  | 'initial'
  | 'sending'
  | 'awaiting-code'
  | 'submitting'
  | 'done'
  | 'error';

/**
 * Creates the embedded Base wallet if this account has none.
 *
 * Necessary because the dashboard's "automatically create embedded wallets on
 * login" only fires for logins through Privy's own modal — it explicitly does
 * not apply to whitelabel methods, and our email OTP screen is whitelabel. So
 * the setting can be switched on and still produce no wallet, which is exactly
 * what happened. Asking for one directly is the only reliable path.
 *
 * Safe to call repeatedly: both platforms check first and do nothing when a
 * wallet already exists, because creating a second one would strand funds in
 * whichever the app stopped reading.
 */
export type EnsureWallet = () => Promise<void>;

/** Turns either SDK's failure into something worth showing a person. */
export function readableAuthError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  const lower = raw.toLowerCase();

  if (lower.includes('invalid') && lower.includes('code')) {
    return 'That code is not right. Check it and try again.';
  }
  if (lower.includes('expired')) return 'That code has expired. Ask for a new one.';
  if (lower.includes('too many') || lower.includes('rate')) {
    return 'Too many tries. Wait a moment and try again.';
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Could not reach the network. Check your connection.';
  }
  return raw;
}

/**
 * Signs an EIP-712 payload with the embedded wallet.
 *
 * Withdrawals are gasless: the person signs an authorisation that names the
 * recipient and the amount, and the server relays it and pays the fee. Signing
 * costs nothing and needs no ETH, which is the whole point — an embedded
 * wallet holding only USDC could not otherwise move it.
 */
export type SignTypedData = (typedData: {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<string>;
