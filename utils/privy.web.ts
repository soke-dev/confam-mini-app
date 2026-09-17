import { WALLET_MODE } from './privyShared';
import * as privy from './authPrivyWeb';
import * as wallet from './authWallet';

export * from './privyShared';

/**
 * The browser half of the auth split, and the choice between its two halves.
 *
 * Metro picks this file on web. It picks between Privy and a wallet: the app
 * and the admin desk sign in with an email code and get an embedded wallet,
 * while the mini app signs in with a signature from the wallet the host
 * already provided.
 *
 * The choice is made once, here, at module load. It is not made inside the
 * hooks, because a hook that called a different implementation depending on a
 * condition would be calling a different number of hooks between renders,
 * which React forbids outright. Binding the names once means each of these is
 * a fixed function for the life of the bundle, and every screen above goes on
 * importing `useAuth` without knowing which one it got.
 *
 * WALLET_MODE is a build-time constant, so the branch is decided before this
 * ever runs.
 */

export const useAuth = WALLET_MODE ? wallet.useAuth : privy.useAuth;
export const useEmailLogin = WALLET_MODE ? wallet.useEmailLogin : privy.useEmailLogin;
export const useEnsureWallet = WALLET_MODE ? wallet.useEnsureWallet : privy.useEnsureWallet;
export const useSignAuthorization = WALLET_MODE
  ? wallet.useSignAuthorization
  : privy.useSignAuthorization;

/**
 * Wallet-only, and exported unconditionally so the sign-in screen can import
 * it without a conditional import. In Privy builds these are never called —
 * the screen checks WALLET_MODE before it reaches for them.
 */
export const useWalletChoices = wallet.useWalletChoices;
export const connectWallet = wallet.connect;
export const signInWithWallet = wallet.signIn;
export const inNimiqPay = wallet.inNimiqPay;
export type { FoundWallet } from './authWallet';
