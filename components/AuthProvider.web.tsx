import React from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { PRIVY_APP_ID, WALLET_MODE, privyConfigured } from '@/utils/privyShared';

/**
 * The browser provider. No client ID here — that is a native-only concept.
 *
 * See AuthProvider.tsx for the device version and for why an unconfigured
 * build renders its children rather than throwing.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  /**
   * A wallet build mounts no Privy at all.
   *
   * Not merely unnecessary — actively wrong. PrivyProvider opens a session on
   * mount and would sit underneath a person who has signed in with a wallet,
   * holding a second, empty identity and reaching for storage it has no
   * business touching. Leaving it out also leaves its SDK unreferenced, which
   * is most of what the mini app would otherwise be downloading.
   */
  if (WALLET_MODE) return <>{children}</>;

  if (!privyConfigured) return <>{children}</>;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email'],
        embeddedWallets: {
          // Anyone who signs in gets a wallet, without a second prompt.
          ethereum: { createOnLogin: 'users-without-wallets' },
          /**
           * Suppresses Privy's own signing modal so our confirmation screen is
           * the only one. Ignored while "enforce wallet UIs" is on in the
           * Privy dashboard — that setting wins, and the result is two
           * confirmations in a row.
           */
          showWalletUIs: false,
        },
        defaultChain: base,
        supportedChains: [base],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
