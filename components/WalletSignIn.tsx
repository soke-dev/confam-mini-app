import React from 'react';

/**
 * The device stub. Metro picks WalletSignIn.web.tsx in a browser.
 *
 * Wallet sign-in belongs to the mini app, which is a web build by definition:
 * it exists because a wallet host has injected a provider into the page, and
 * nothing does that on iOS or Android. The stub exists so the sign-in screen
 * can import the component unconditionally — a conditional import would have
 * to be resolvable on every platform anyway, and this is the cheaper honesty.
 *
 * It renders nothing, and is never reached: WALLET_MODE is false in every
 * device build, so the screen does not ask for it.
 */
export function WalletSignIn(_props: { onSignedIn?: () => void }) {
  return null;
}
