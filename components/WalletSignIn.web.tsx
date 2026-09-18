import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { font, text } from '@/constants/type';
/*
 * Straight from the wallet module rather than through the privy.web selector.
 * This file is a .web.tsx, so it is only ever bundled where authWallet can
 * run, and the indirection would buy nothing — TypeScript resolves
 * '@/utils/privy' to the native half when it checks, which is exactly where
 * these names do not exist.
 */
import {
  connectAndSignIn,
  signIn as signInWithWallet,
  useWalletChoices,
  type FoundWallet,
} from '@/utils/authWallet';

/**
 * Signing in with the wallet the person already has.
 *
 * Replaces the email panel in the mini app. Inside Nimiq Pay there is nothing
 * to type: the host has put a wallet in front of us, so the whole flow is one
 * tap to connect and one signature to prove the address.
 *
 * Only Nimiq Pay is offered. Discovery still finds browser extensions, and
 * they are deliberately not listed — this runs as a mini app, the money is
 * USDT on Polygon, and a MetaMask row would invite somebody to sign in with an
 * account the rest of the flow was never opened for.
 *
 * Deliberately built from the same pieces as the rest of the app — 2px rules,
 * square corners, uppercase labels, one signal colour — rather than as a
 * wallet-kit modal dropped into the middle of it. Somebody arriving here has
 * not left Confam.
 */
export function WalletSignIn({ onSignedIn }: { onSignedIn?: () => void }) {
  const colors = useColors();
  const { wallets, ready, connected, address } = useWalletChoices();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * What went wrong, in words.
   *
   * 4001 is somebody closing the wallet prompt, which is not an error worth
   * showing in red — they know what they did. Everything else keeps the
   * wallet's own message, because a bare "Request failed" helps nobody.
   */
  const explain = (cause: unknown): string => {
    const code = (cause as { code?: number } | null)?.code;
    if (code === 4001) return 'Cancelled in the wallet.';
    if (cause instanceof Error && cause.message) return cause.message;
    return 'That did not work. Try again.';
  };

  /**
   * One tap: connect, then sign.
   *
   * There used to be a screen in between whose only job was to hold a button
   * saying "now sign in", which is not a decision anybody was making — they
   * had already chosen the wallet. The two wallet prompts remain, because
   * asking for an account and asking for a signature are separate calls, but
   * inside Nimiq Pay the first usually resolves without asking at all.
   *
   * When the signature fails the connection survives, and the screen falls
   * through to the panel below offering just that half again.
   */
  const pick = useCallback(
    async (entry: FoundWallet) => {
      setBusy(true);
      setError(null);
      try {
        await connectAndSignIn(entry);
        onSignedIn?.();
      } catch (cause) {
        setError(explain(cause));
      } finally {
        setBusy(false);
      }
    },
    [onSignedIn],
  );

  const prove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithWallet();
      onSignedIn?.();
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
    }
  }, [onSignedIn]);

  /**
   * Nimiq Pay, and nothing else offered.
   *
   * Discovery still finds whatever else a browser has installed, and this
   * deliberately does not list it. Confam runs here as a mini app: the wallet
   * is the one the host provides, the money is USDT on Polygon, and a row
   * offering MetaMask is an invitation to sign in with an account that will
   * then be asked to switch chains and fund a bounty it was never opened for.
   *
   * On a desktop the row below says where to go instead, rather than leaving
   * an empty panel that reads as "unsupported".
   */
  const nimiq = wallets.find((w) => w.rdns === 'com.nimiq.pay');

  /* Connected but not yet proven: one button, and what it will sign as. */
  if (connected && address) {
    return (
      <View style={styles.wrap}>
        <Text style={[text.label, { color: colors.faintForeground }]}>SIGN IN</Text>

        <View style={[styles.summary, { borderColor: colors.border }]}>
          <Text style={[text.bodySmall, { color: colors.mutedForeground }]}>
            {connected.name}
          </Text>
          <Text style={[styles.address, { color: colors.foreground }]} numberOfLines={1}>
            {address}
          </Text>
        </View>

        {error ? <Problem colour={colors.danger} message={error} /> : null}

        <Pressable
          onPress={prove}
          disabled={busy}
          style={({ pressed }) => [
            styles.primary,
            {
              backgroundColor: colors.accent,
              borderColor: colors.accent,
              opacity: busy ? 0.55 : pressed ? 0.85 : 1,
            },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.accentForeground} />
          ) : (
            <Text style={[text.action, { color: colors.accentForeground }]}>
              SIGN IN WITH THIS WALLET
            </Text>
          )}
        </Pressable>

        <Text style={[text.bodySmall, styles.note, { color: colors.faintForeground }]}>
          One signature left. It moves no funds and costs no gas.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={[text.label, { color: colors.faintForeground }]}>CONNECT</Text>

      {error ? <Problem colour={colors.danger} message={error} /> : null}

      {/*
        * Nimiq Pay, whether or not it is here. Mini apps run inside the Nimiq
        * Pay app, so on a desktop there is nothing to find and no amount of
        * looking will conjure one. Leaving the row out would be accurate and
        * useless: the screen would simply not mention the wallet it was built
        * for, and somebody looking for it would conclude it was unsupported.
        */}
      {nimiq ? (
        <WalletRow wallet={nimiq} detail="This app is running inside it" onPress={pick} busy={busy} />
      ) : (
        <View style={[styles.row, styles.absent, { borderColor: colors.borderStrong }]}>
          <View style={[styles.mark, { backgroundColor: colors.sunken }]}>
            <Ionicons name="phone-portrait-outline" size={16} color={colors.faintForeground} />
          </View>
          <View style={styles.rowLabel}>
            <Text style={[styles.rowName, { color: colors.mutedForeground }]}>Nimiq Pay</Text>
            <Text style={[text.bodySmall, { color: colors.faintForeground }]}>
              A phone app. Open this page inside it to use it.
            </Text>
          </View>
        </View>
      )}

      {!ready && !nimiq ? (
        <Text style={[text.bodySmall, styles.note, { color: colors.faintForeground }]}>
          Looking for your wallet...
        </Text>
      ) : null}
    </View>
  );
}

function Problem({ colour, message }: { colour: string; message: string }) {
  return (
    <View style={[styles.problem, { borderColor: colour }]}>
      <Ionicons name="alert-circle" size={16} color={colour} />
      <Text style={[text.bodySmall, { color: colour, flex: 1 }]}>{message}</Text>
    </View>
  );
}

function WalletRow({
  wallet,
  detail,
  onPress,
  busy,
}: {
  wallet: FoundWallet;
  detail: string;
  onPress: (entry: FoundWallet) => void;
  busy: boolean;
}) {
  const colors = useColors();

  return (
    <Pressable
      onPress={() => onPress(wallet)}
      disabled={busy}
      style={({ pressed }) => [
        styles.row,
        {
          borderColor: colors.borderStrong,
          backgroundColor: colors.sunken,
          opacity: busy ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {wallet.icon ? (
        <Image source={{ uri: wallet.icon }} style={styles.mark} />
      ) : (
        <View style={[styles.mark, { backgroundColor: colors.border }]}>
          <Text style={{ color: colors.mutedForeground, fontFamily: font.sansBold, fontSize: 13 }}>
            {wallet.name.slice(0, 1).toUpperCase()}
          </Text>
        </View>
      )}

      <View style={styles.rowLabel}>
        <Text style={[styles.rowName, { color: colors.foreground }]}>{wallet.name}</Text>
        <Text style={[text.bodySmall, { color: colors.faintForeground }]} numberOfLines={1}>
          {detail}
        </Text>
      </View>

      <Ionicons name="chevron-forward" size={16} color={colors.faintForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 2,
    borderRadius: 2,
    padding: 11,
  },
  absent: { borderStyle: 'dashed', backgroundColor: 'transparent' },
  mark: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, minWidth: 0 },
  rowName: { fontFamily: font.sansBold, fontSize: 15 },
  summary: { borderWidth: 2, borderRadius: 2, padding: 12, gap: 3 },
  address: { fontFamily: font.mono, fontSize: 13 },
  primary: {
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  problem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    padding: 11,
  },
  note: { marginTop: 2 },
});
