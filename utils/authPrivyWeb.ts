import { useCallback, useMemo, useState } from 'react';
import {
  usePrivy as usePrivyWeb,
  useLoginWithEmail as useLoginWithEmailWeb,
  useCreateWallet,
  useSignTypedData,
  useWallets,
} from '@privy-io/react-auth';
import {
  readableAuthError,
  type AuthState,
  type AuthUser,
  type EmailLogin,
  type EmailLoginState,
  type EnsureWallet,
  type SignTypedData,
} from './privyShared';

/**
 * The Privy half of the browser auth split, used by the app and the admin
 * desk. privy.web.ts chooses between this and the wallet half.
 *
 * `@privy-io/react-auth` is the only Privy SDK that runs here — the Expo one
 * needs secure-store and passkey native modules that do not exist in a
 * browser. See privy.ts for why the two are kept behind one interface.
 */

/** Maps the web SDK's flow status onto the shared vocabulary. */
function mapState(status: string | undefined): EmailLoginState {
  switch (status) {
    case 'sending-code':
      return 'sending';
    case 'awaiting-code-input':
      return 'awaiting-code';
    case 'submitting-code':
      return 'submitting';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'initial';
  }
}

export function useAuth(): AuthState & {
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
} {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivyWeb();
  const { wallets } = useWallets();

  const mapped = useMemo<AuthUser | null>(() => {
    if (!authenticated || !user) return null;

    // The embedded wallet is the one Privy created, not a browser extension
    // the person happens to have installed. Only ours is on Base and only
    // ours can be signed with programmatically.
    const embedded = wallets.find((w) => w.walletClientType === 'privy');

    return {
      did: user.id,
      email: user.email?.address ?? null,
      walletAddress: embedded?.address?.toLowerCase() ?? null,
    };
  }, [authenticated, user, wallets]);

  return {
    ready,
    user: mapped,
    signOut: logout,
    getToken: getAccessToken,
  };
}

export function useEmailLogin(): EmailLogin {
  const { sendCode, loginWithCode, state } = useLoginWithEmailWeb();
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (email: string) => {
      setError(null);
      try {
        await sendCode({ email });
      } catch (cause) {
        setError(readableAuthError(cause));
        throw cause;
      }
    },
    [sendCode],
  );

  const submit = useCallback(
    async (code: string) => {
      setError(null);
      try {
        await loginWithCode({ code });
      } catch (cause) {
        setError(readableAuthError(cause));
        throw cause;
      }
    },
    [loginWithCode],
  );

  return {
    sendCode: send,
    loginWithCode: submit,
    state: mapState((state as { status?: string } | undefined)?.status),
    error,
  };
}

export function useEnsureWallet(): EnsureWallet {
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();

  return useCallback(async () => {
    // createWallet throws if one already exists, so this is a guard, not an
    // optimisation.
    if (wallets.some((w) => w.walletClientType === 'privy')) return;
    await createWallet();
  }, [createWallet, wallets]);
}

export function useSignAuthorization(): SignTypedData {
  const { signTypedData } = useSignTypedData();

  return useCallback(
    async (typedData) => {
      const { signature } = await signTypedData(
        typedData as Parameters<typeof signTypedData>[0],
      );
      return signature;
    },
    [signTypedData],
  );
}
