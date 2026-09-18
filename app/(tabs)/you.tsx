import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  InputAccessoryView,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import QRCode from 'react-native-qrcode-svg';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { font, text } from '@/constants/type';
import { useApp } from '@/contexts/AppContext';
import { useSignAuthorization } from '@/utils/privy';
import { apiFetch } from '@/utils/api';
import { useThemeMode, type ThemeMode } from '@/contexts/ThemeContext';
import { AddressScanner } from '@/components/AddressScanner';
import { SendingIndicator } from '@/components/SendingIndicator';
import { SheetKeyboardView } from '@/components/SheetKeyboardView';
import { BALANCE, SETTLEMENT } from '@/constants/chain';
import { WALLET_MODE } from '@/utils/privyShared';

/**
 * Ties the amount field to its Done bar.
 *
 * iOS gives decimal-pad no return key, so once the keypad is up there is no
 * key on it that puts it away — and the only thing behind this sheet is a
 * backdrop that closes the whole withdrawal. Android is unaffected: its
 * numeric keyboard carries its own dismiss.
 */
const AMOUNT_ACCESSORY_ID = 'withdraw-amount-accessory';

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'system', label: 'Auto', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Light', icon: 'sunny-outline' },
  { value: 'dark', label: 'Dark', icon: 'moon-outline' },
];

const SETTINGS: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  href: '/edit-profile' | '/alerts' | '/agent' | '/privacy' | '/help' | '/about';
}[] = [
  { icon: 'person-circle-outline', label: 'Edit profile', href: '/edit-profile' },
  { icon: 'notifications-outline', label: 'Alerts', href: '/alerts' },
  { icon: 'terminal-outline', label: 'Confam AI', href: '/agent' },
  { icon: 'lock-closed-outline', label: 'Privacy & security', href: '/privacy' },
  { icon: 'chatbubble-ellipses-outline', label: 'Get help', href: '/help' },
  { icon: 'information-circle-outline', label: 'About Confam', href: '/about' },
];

export default function YouScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    user,
    identity,
    walletHistory,
    usdcBalance,
    withdrawUsdc,
    signOut,
    answeredQuestions,
    completedJobs,
    profile,
    wallet,
    accountLoaded,
    jobsDone,
    questionsAsked,
    walletLoaded,
    refreshWallet,
    refreshBalance,
    ngnPerUsd,
    totalDepositedUsdc,
  } = useApp();
  const { mode, setMode } = useThemeMode();
  const topPad = Platform.OS === 'web' ? 22 : insets.top + 6;

  const [receiveOpen, setReceiveOpen] = useState(false);
  // Set when Share was tapped from inside the Receive sheet: the share is
  // owed once that sheet has finished dismissing. See handleShareAddress.
  const [shareOnDismiss, setShareOnDismiss] = useState(false);
  const [copied, setCopied] = useState(false);

  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [destination, setDestination] = useState<'wallet' | 'bank'>('wallet');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  /**
   * Three steps, because sending money should take a deliberate second tap.
   * The middle one restates the amount and the destination in full, since an
   * address is the one field nobody proof-reads and the one mistake that
   * cannot be undone.
   */
  const [withdrawStep, setWithdrawStep] = useState<'form' | 'confirm' | 'sent'>('form');
  const [receipt, setReceipt] = useState<{ txHash: string; usdc: number; to: string } | null>(
    null,
  );
  const signAuthorization = useSignAuthorization();

  // Settled earnings only. Pending money is not yours yet, and adding it to a
  // figure labelled "Earned" overstates what has actually been paid.
  /**
   * Keeps the balance current while this screen is open.
   *
   * Twelve seconds against Base's ~2s blocks means a transfer shows up within
   * about six blocks — fast enough to feel live for someone watching a top-up
   * land, slow enough not to hammer a public RPC. The interval is cleared on
   * unmount so a backgrounded app is not polling a chain nobody is looking at.
   */
  useEffect(() => {
    void refreshBalance();
    const timer = setInterval(() => void refreshBalance(), 12_000);
    return () => clearInterval(timer);
  }, [refreshBalance]);

  /**
   * Manual refresh.
   *
   * The poll already keeps this current, so this exists for the moment
   * somebody has just sent a transfer and wants to check now rather than wait
   * out the interval. The spinner is held for a beat even when the answer
   * comes back instantly from cache — a button that appears to do nothing
   * reads as broken, and gets pressed repeatedly.
   */
  const [refreshingBalance, setRefreshingBalance] = useState(false);

  /**
   * One continuous rotation while a read is in flight.
   *
   * Driven by a looped animation rather than a spinner component so the icon
   * itself turns — the same glyph in both states, which reads as "this is
   * working" rather than as the button being replaced by something else.
   */
  const spinValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!refreshingBalance) {
      spinValue.stopAnimation();
      spinValue.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spinValue, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [refreshingBalance, spinValue]);

  const spin = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  async function reloadBalance() {
    if (refreshingBalance) return;
    setRefreshingBalance(true);
    await Promise.all([
      refreshBalance(),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
    setRefreshingBalance(false);
  }

  const earnings = walletHistory.filter((a) => a.type === 'earning' && !a.pending);
  const totalEarned = earnings.reduce((s, a) => s + a.amount, 0);
  // Summed on the server in USDC. Adding up the naira column here would print
  // a naira figure behind a dollar sign, and move whenever the rate moved.

  const walletAddress = wallet?.address ?? null;

  /**
   * Blank until the server has answered, rather than a guess that reads as a
   * fact. `profile.username` is empty for the first moment after a refresh, so
   * falling back to the email here showed the wrong initials — "CO" from the
   * address — which then swapped to "SO" once the real username arrived.
   */
  const initials = accountLoaded
    ? (profile.username || profile.name || user?.email || 'U').slice(0, 2).toUpperCase()
    : '';
  const ninVerified = identity?.status === 'verified';
  const ninPending = identity?.status === 'pending';

  const withdrawAmountValue = Number.parseFloat(withdrawAmount) || 0;
  // A real EVM address, not the deliberately-invalid demo one we hand out.
  const addressValid = /^0x[a-fA-F0-9]{40}$/.test(toAddress.trim());
  const canWithdraw =
    destination === 'wallet' &&
    addressValid &&
    withdrawAmountValue > 0 &&
    // Unknown balance blocks the withdrawal rather than allowing it. Failing
    // closed is the only safe direction when the amount available is unread.
    usdcBalance !== null &&
    withdrawAmountValue <= usdcBalance;

  function handleWithdraw() {
    if (withdrawAmountValue <= 0) {
      setWithdrawError('Enter an amount to withdraw.');
      return;
    }
    if (usdcBalance === null) {
      setWithdrawError('Your balance could not be read just now. Try again in a moment.');
      return;
    }
    if (withdrawAmountValue > usdcBalance) {
      setWithdrawError(`You only have $${usdcBalance.toFixed(2)} available.`);
      return;
    }
    if (!addressValid) {
      setWithdrawError('That is not a valid wallet address.');
      return;
    }

    setWithdrawError(null);
    setWithdrawStep('confirm');
  }

  /**
   * Quote, sign, relay.
   *
   * Three steps because the middle one belongs to the person, not to us: the
   * server states the recipient and amount, they sign that exact statement,
   * and only then can it be broadcast. Building the payload client-side would
   * let the app sign something other than what it displayed.
   *
   * They pay no gas. The signature costs nothing to produce and the relayer
   * covers the fee, which is what makes an embedded wallet holding only USDC
   * able to move it at all.
   */
  /**
   * Opens the transaction on Base's block explorer.
   *
   * The hash is the only record of this that does not depend on us: someone
   * who does not trust the app can still verify the transfer happened, from a
   * source we do not control.
   */
  function openTx(txHash: string) {
    void Linking.openURL(SETTLEMENT.explorerTx(txHash));
  }

  function dismissWithdraw() {
    // Never mid-send: closing the sheet cannot cancel a broadcast, and
    // pretending otherwise would leave someone unsure whether it went.
    if (withdrawing) return;
    setWithdrawOpen(false);
    setWithdrawStep('form');
    setWithdrawAmount('');
    setToAddress('');
    setWithdrawError(null);
    setReceipt(null);
  }

  async function sendWithdrawal() {
    setWithdrawing(true);
    setWithdrawError(null);

    try {
      const quote = await apiFetch<{
        nonce: string;
        typedData: Parameters<typeof signAuthorization>[0];
      }>('/withdraw/quote', {
        method: 'POST',
        body: JSON.stringify({ to: toAddress.trim(), usdc: withdrawAmountValue }),
      });

      if (!quote.ok) {
        setWithdrawError(quote.detail);
        return;
      }

      const signature = await signAuthorization(quote.data.typedData);

      const sent = await apiFetch<{ txHash: string }>('/withdraw/submit', {
        method: 'POST',
        body: JSON.stringify({ nonce: quote.data.nonce, signature }),
      });

      if (!sent.ok) {
        setWithdrawError(sent.detail);
        return;
      }

      setReceipt({
        txHash: sent.data.txHash,
        usdc: withdrawAmountValue,
        to: toAddress.trim(),
      });
      setWithdrawStep('sent');
      // Both, because the money left the chain balance and the ledger gained
      // a row explaining where it went.
      await Promise.all([refreshBalance(), refreshWallet()]);
    } catch (cause) {
      // A declined signature lands here and is not an error worth alarming
      // anybody about.
      const message = cause instanceof Error ? cause.message : 'Something went wrong.';
      setWithdrawError(/reject|denied|cancel/i.test(message) ? null : message);
    } finally {
      setWithdrawing(false);
    }
  }

  async function handleCopyAddress() {
    if (!walletAddress) return;
    await Clipboard.setStringAsync(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  /**
   * Puts the address in front of whoever needs it.
   *
   * Kept separate from the button so it can be fired either immediately or
   * once the Receive sheet has finished getting out of the way.
   */
  async function doShareAddress() {
    if (!walletAddress) return;
    const message = `My Confam wallet (${SETTLEMENT.onChain}): ${walletAddress}`;
    try {
      if (Platform.OS === 'web') {
        // RN Web has no Share; the Web Share API exists only in some browsers,
        // so copying is the dependable fallback rather than a dead button.
        const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
        if (nav.share) await nav.share({ text: message });
        else await handleCopyAddress();
        return;
      }
      const result = await Share.share({ message });
      if (__DEV__) console.log('[share] resolved:', JSON.stringify(result));
    } catch (error) {
      /**
       * Dismissing the sheet resolves with `dismissedAction` rather than
       * throwing, and the browser reports the same as an AbortError. Anything
       * else here is a real failure, and swallowing those is what made this
       * button look dead rather than broken.
       */
      if ((error as { name?: string })?.name === 'AbortError') return;
      if (__DEV__) console.warn('[share] could not open the share sheet:', error);

      // The address is the whole point of the screen, so a share that will not
      // open must still leave it on the clipboard rather than nothing at all.
      await handleCopyAddress();
    }
  }

  /**
   * iOS will not present the share sheet while the Receive sheet is up.
   *
   * UIActivityViewController presents from the topmost view controller, and a
   * React Native Modal is one — already presenting. iOS declines, and since
   * the completion handler never fires, `Share.share` neither resolves nor
   * rejects. It hangs, which is why there was no sheet and nothing to catch.
   *
   * Waiting a fixed number of milliseconds for the dismissal was a guess, and
   * it was wrong. `onDismiss` is the actual signal that the presentation
   * context has been handed back, so the share is queued and fired from there.
   *
   * None of this applies to Android, where the chooser is an Intent and has no
   * presentation context to contend for — so it shares in place and the sheet
   * stays open behind it.
   */
  function handleShareAddress() {
    if (!walletAddress) return;

    if (Platform.OS !== 'ios' || !receiveOpen) {
      void doShareAddress();
      return;
    }

    setShareOnDismiss(true);
    setReceiveOpen(false);
  }

  /**
   * The backstop for the share owed to a sheet that has closed.
   *
   * `onDismiss` is the right signal and fires first when it fires at all — but
   * it is iOS-only and undocumented for transparent modals, so nothing should
   * depend on it alone. This runs after the render that set `receiveOpen`
   * false, which is the part the earlier fixed delay got wrong: awaiting
   * inside the handler started counting before React had re-rendered, so the
   * wait could elapse before the sheet began dismissing at all.
   *
   * Whichever path arrives first clears the flag, and the other then does
   * nothing.
   */
  useEffect(() => {
    if (!shareOnDismiss || receiveOpen) return;

    const timer = setTimeout(() => {
      setShareOnDismiss(false);
      void doShareAddress();
    }, 450);

    return () => clearTimeout(timer);
    // doShareAddress is redeclared every render and is not worth a ref here;
    // it only ever reads walletAddress, which cannot change mid-dismissal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareOnDismiss, receiveOpen]);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
      >
        {/* ── Identity ─────────────────────────────────────────────
            Verification belongs beside the name, not in a banner below it.
            A prompt only appears while it is still outstanding; once done it
            collapses to a badge and stops taking up room. */}
        <View style={styles.person}>
          {profile.avatarUri ? (
            <Image source={{ uri: profile.avatarUri }} style={styles.avatar} contentFit="cover" />
          ) : (
            /* While loading, a muted outline rather than a blank white block —
               an empty avatar reads as broken, not as pending. */
            <View
              style={[
                styles.avatar,
                styles.avatarFallback,
                {
                  backgroundColor: accountLoaded ? colors.foreground : colors.sunken,
                  borderWidth: accountLoaded ? 0 : 2,
                  borderColor: colors.border,
                },
              ]}
            >
              {accountLoaded ? (
                <Text style={[styles.initials, { color: colors.background }]}>{initials}</Text>
              ) : (
                <Ionicons name="person-outline" size={20} color={colors.faintForeground} />
              )}
            </View>
          )}

          <View style={{ flex: 1 }}>
            {/* The username leads, because it is the thing they chose and the
                thing other people see. A real name only appears once the ID
                check has returned one — never a guess from the email. */}
            <View style={styles.nameRow}>
              <Text style={[text.title, { color: colors.foreground }]} numberOfLines={1}>
                {!accountLoaded
                  ? ' '
                  : profile.username
                    ? `@${profile.username}`
                    : 'You'}
              </Text>
              {ninVerified && (
                <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
              )}
            </View>
            <Text style={[text.data, { color: colors.mutedForeground }]} numberOfLines={1}>
              {user?.email}
            </Text>
          </View>

          {/* Held back until the status is actually known — otherwise this
              offers "Verify" for a moment to people already verified or
              already waiting on a review. */}
          {accountLoaded && !ninVerified && (
            <Pressable
              onPress={() => !ninPending && router.push('/verify-identity')}
              disabled={ninPending}
              accessibilityRole="button"
              accessibilityLabel={ninPending ? 'Identity check in progress' : 'Verify your identity'}
              style={({ pressed }) => [
                styles.verifyChip,
                {
                  borderColor: ninPending ? colors.pending : colors.accent,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Ionicons
                name={ninPending ? 'time-outline' : 'shield-outline'}
                size={13}
                color={ninPending ? colors.pending : colors.accent}
              />
              <Text
                style={[
                  text.action,
                  { fontSize: 11, color: ninPending ? colors.pending : colors.accent },
                ]}
              >
                {ninPending ? 'Checking' : 'Verify'}
              </Text>
            </Pressable>
          )}
        </View>

        {/* ── Numbers ──────────────────────────────────────────────── */}
        <View style={[styles.numbers, { borderColor: colors.border }]}>
          {[
            // A dash while loading, rather than a zero that reads as a fact.
            { label: 'Earned', value: walletLoaded ? `₦${totalEarned.toLocaleString()}` : '—' },
            { label: 'Jobs done', value: walletLoaded ? String(jobsDone) : '—' },
            /*
             * "Topped up" counts money sent into the embedded wallet, which in
             * the mini app is always nothing: there is no embedded wallet to
             * send to. A stat permanently reading $0.00 is worse than no stat
             * — it looks like a broken sum rather than a category that does
             * not apply. Questions asked is the figure that means something
             * for somebody bringing their own wallet.
             */
            WALLET_MODE
              ? { label: 'Asked', value: walletLoaded ? String(questionsAsked) : '—' }
              : {
                  label: 'Topped up',
                  value: walletLoaded ? `$${totalDepositedUsdc.toFixed(2)}` : '—',
                },
          ].map((s, i) => (
            <View
              key={s.label}
              style={[
                styles.numberCell,
                i > 0 && { borderLeftWidth: 1, borderLeftColor: colors.border },
              ]}
            >
              <Text style={[text.amount, { color: colors.foreground, fontSize: 17 }]}>
                {s.value}
              </Text>
              <Text style={[text.data, { color: colors.faintForeground }]}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* ── Wallet ───────────────────────────────────────────────
            The card carries its own label, like the two record cards
            below it, so the heading is not a separate row. */}
        <View
          style={[
            styles.wallet,
            styles.walletTop,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <View style={styles.walletHead}>
            <Text style={[text.label, { color: colors.faintForeground, flex: 1 }]}>Wallet</Text>
            <View style={styles.walletMeta}>
              <Text style={[text.data, { color: colors.mutedForeground }]}>{BALANCE.token} · {BALANCE.chain}</Text>
              <Pressable
                onPress={reloadBalance}
                disabled={refreshingBalance}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Refresh balance"
                style={({ pressed }) => [styles.refreshBtn, { opacity: pressed ? 0.5 : 1 }]}
              >
                <Animated.View style={{ transform: [{ rotate: spin }] }}>
                  <Ionicons name="refresh" size={15} color={colors.foreground} />
                </Animated.View>
              </Pressable>
            </View>
          </View>

          {/* A dash while unread. Zero would be a statement about their money
              that we have not actually checked. */}
          <View style={styles.balanceRow}>
            <Text style={[text.amountLarge, { color: colors.foreground }]}>
              {/*
                * A dollar sign on Base, where it has always been, and the
                * token's name in the mini app. USDT is a dollar too, but
                * saying so where the money is USDT on Polygon and the escrow
                * is USDC on Base invites exactly the confusion this build
                * exists to avoid.
                */}
              {usdcBalance === null
                ? '—'
                : WALLET_MODE
                  ? `${usdcBalance.toFixed(2)} ${BALANCE.token}`
                  : `$${usdcBalance.toFixed(2)}`}
            </Text>
            {/* Only shown when a live rate arrived. No rate, no figure —
                rather than a stale constant that reads like a real one. */}
            {usdcBalance !== null && ngnPerUsd !== null && (
              <Text style={[text.data, { color: colors.mutedForeground }]}>
                ≈ ₦{Math.round(usdcBalance * ngnPerUsd).toLocaleString()}
              </Text>
            )}
          </View>

          {/*
            * Neither button belongs in the mini app.
            *
            * Both exist because of the embedded wallet: topping up means
            * sending money to an address this app created on somebody's
            * behalf, and withdrawing means moving it back out again. Somebody
            * signing with their own wallet has neither problem — the escrow
            * pays them directly, at the address they already hold the keys
            * for, and they add money to it wherever they normally would.
            *
            * Left in, "Top up" would tell them to send funds to their own
            * address on a chain their wallet is not even on, and "Withdraw"
            * would try to move money out of an embedded wallet that does not
            * exist. Both would fail, and the first would fail by losing
            * somebody's money.
            */}
          {WALLET_MODE ? (
            <Text style={[text.bodySmall, { color: colors.faintForeground, marginTop: 4 }]}>
              This is your own wallet. Bounties are paid straight into it, and you add money to
              it the same way you always do.
            </Text>
          ) : (
            <View style={styles.walletActions}>
              <Pressable
                onPress={() => setReceiveOpen(true)}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  styles.btnFill,
                  { backgroundColor: colors.foreground, opacity: pressed ? 0.88 : 1 },
                ]}
              >
                <Text style={[text.action, { color: colors.background }]}>Top up</Text>
              </Pressable>
              <Pressable
                onPress={() => setWithdrawOpen(true)}
                style={({ pressed }) => [
                  styles.outlineBtn,
                  styles.btnFill,
                  { borderColor: colors.borderStrong, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[text.action, { color: colors.foreground }]}>Withdraw</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* ── Records ──────────────────────────────────────────────
            Two doors to the same past, so they sit side by side and carry
            their own labels rather than each taking a full-width row. */}
        <View style={styles.records}>
          {[
            {
              key: 'activity',
              icon: 'receipt-outline' as const,
              label: 'Activity',
              detail: walletLoaded
                ? `${walletHistory.length} ${walletHistory.length === 1 ? 'entry' : 'entries'}`
                : '—',
              href: '/activity' as const,
            },
            {
              key: 'history',
              icon: 'time-outline' as const,
              label: 'History',
              detail: walletLoaded
                ? `${questionsAsked} asked · ${jobsDone} earned`
                : '—',
              href: '/history' as const,
            },
          ].map((card) => (
            <Pressable
              key={card.key}
              onPress={() => router.push(card.href)}
              style={({ pressed }) => [
                styles.recordCard,
                { borderColor: colors.borderStrong, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <View style={styles.recordTop}>
                <Ionicons name={card.icon} size={16} color={colors.foreground} />
                <Text style={[text.label, { color: colors.faintForeground, flex: 1 }]}>
                  {card.label}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={colors.mutedForeground} />
              </View>
              <Text style={[text.data, { color: colors.foreground }]} numberOfLines={1}>
                {card.detail}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* ── Settings ─────────────────────────────────────────────── */}
        <Text style={[text.label, styles.sectionLabel, { color: colors.faintForeground }]}>
          Settings
        </Text>
        <View>
          {SETTINGS.map((item) => (
            <Pressable
              key={item.label}
              onPress={() => router.push(item.href)}
              style={({ pressed }) => [
                styles.settingRow,
                { borderBottomColor: colors.border, opacity: pressed ? 0.6 : 1 },
              ]}
            >
              <Ionicons name={item.icon} size={17} color={colors.mutedForeground} />
              <Text style={[text.body, { color: colors.foreground, flex: 1 }]}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={15} color={colors.faintForeground} />
            </Pressable>
          ))}
        </View>

        {/* ── Appearance ───────────────────────────────────────────── */}
        <Text style={[text.label, styles.sectionLabel, { color: colors.faintForeground }]}>
          Appearance
        </Text>
        <View style={[styles.segmented, { borderColor: colors.borderStrong }]}>
          {THEME_OPTIONS.map((opt, i) => {
            const on = mode === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setMode(opt.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[
                  styles.segment,
                  i > 0 && { borderLeftWidth: 2, borderLeftColor: colors.borderStrong },
                  on && { backgroundColor: colors.foreground },
                ]}
              >
                <Ionicons
                  name={opt.icon}
                  size={15}
                  color={on ? colors.background : colors.mutedForeground}
                />
                <Text
                  style={[
                    text.action,
                    { fontSize: 12, color: on ? colors.background : colors.mutedForeground },
                  ]}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={[text.bodySmall, { color: colors.faintForeground, marginTop: 8 }]}>
          Auto follows your device. Confam is designed as a dark board, so Auto shows dark
          unless your device explicitly asks for light.
        </Text>

        <Pressable
          onPress={signOut}
          style={({ pressed }) => [
            styles.signOut,
            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[text.action, { color: colors.danger }]}>Sign out</Text>
        </Pressable>
      </ScrollView>


      {/* ── Withdraw ───────────────────────────────────────────────
          Two destinations, only one of them real. The locked one is shown
          rather than hidden so the roadmap is visible, but it cannot be
          selected and cannot be mistaken for working. */}
      <Modal
        visible={withdrawOpen}
        transparent
        animationType="slide"
        onRequestClose={dismissWithdraw}
        // Must match SheetKeyboardView's provider, or the keyboard insets are
        // measured against different bounds than the sheet is laid out in.
        statusBarTranslucent
        navigationBarTranslucent
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.overlay }]}
          onPress={dismissWithdraw}
        >
          {/*
           * The amount and address fields sit low in a sheet anchored to the
           * bottom of the screen, so the keypad opened straight over them.
           *
           * Same treatment as PlacePicker: lift the whole sheet rather than
           * scroll within it, because this one has no scroll view and its
           * content is short enough to clear the keyboard whole.
           */}
          <SheetKeyboardView style={styles.lift}>
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={[
                styles.sheet,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.borderStrong,
                  paddingBottom: (Platform.OS === 'web' ? 24 : insets.bottom) + 24,
                },
              ]}
            >
              <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
              {/*
               * The steps scroll; the sheet does not grow past the screen.
               *
               * Lifting the sheet clear of the keyboard is only half of it. On
               * a short screen the form is taller than what is left once the
               * keypad is up, and a sheet pinned to the bottom that cannot
               * shrink runs off the top instead — the balance and the address
               * field ended up behind the status bar.
               *
               * maxHeight caps it and this scroll view absorbs the difference,
               * so the part you are typing into stays reachable.
               */}
              <ScrollView
                style={styles.sheetScroll}
                contentContainerStyle={styles.sheetContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >

                {withdrawStep === 'form' && (
                  <>
                <Text style={[text.title, { color: colors.foreground }]}>Withdraw</Text>

                <View style={[styles.balanceBox, { borderColor: colors.border }]}>
                  <Text style={[text.label, { color: colors.faintForeground }]}>Available</Text>
                  <Text style={[text.amountLarge, { color: colors.foreground, fontSize: 30 }]}>
                    {usdcBalance === null ? '—' : `$${usdcBalance.toFixed(2)}`}
                  </Text>
                </View>

                {/* ── Where to ─────────────────────────────────────────── */}
                <Text style={[text.label, { color: colors.faintForeground, marginTop: 4 }]}>
                  Send to
                </Text>
                <View style={styles.destRow}>
                  <Pressable
                    onPress={() => setDestination('wallet')}
                    style={[
                      styles.dest,
                      {
                        borderColor: destination === 'wallet' ? colors.foreground : colors.border,
                        backgroundColor: destination === 'wallet' ? colors.sunken : 'transparent',
                      },
                    ]}
                  >
                    <View style={styles.destHead}>
                      <Ionicons name="wallet-outline" size={16} color={colors.foreground} />
                      <Text style={[text.subheading, { color: colors.foreground, flex: 1 }]}>
                        Crypto wallet
                      </Text>
                    </View>
                    <Text style={[text.data, { color: colors.faintForeground }]}>{SETTLEMENT.onChain}</Text>
                  </Pressable>

                  <View style={[styles.dest, styles.destLocked, { borderColor: colors.border }]}>
                    <View style={styles.destHead}>
                      <Ionicons name="lock-closed" size={16} color={colors.faintForeground} />
                      <Text style={[text.subheading, { color: colors.faintForeground, flex: 1 }]}>
                        Local bank
                      </Text>
                    </View>
                    <Text style={[text.data, { color: colors.pending }]}>Naira · coming soon</Text>
                  </View>
                </View>

                {/* ── How much ─────────────────────────────────────────── */}
                <View style={styles.amountHead}>
                  <Text style={[text.label, { color: colors.faintForeground, flex: 1 }]}>Amount</Text>
                  <Pressable onPress={() => setWithdrawAmount(String(usdcBalance))} hitSlop={8}>
                    <Text style={[text.action, { fontSize: 11, color: colors.accent }]}>Max</Text>
                  </Pressable>
                </View>

                <View style={[styles.amountField, { borderColor: colors.borderStrong }]}>
                  <Text style={[styles.amountPrefix, { color: colors.mutedForeground }]}>$</Text>
                  <TextInput
                    style={[styles.amountInput, { color: colors.foreground }]}
                    value={withdrawAmount}
                    onChangeText={(v) => setWithdrawAmount(v.replace(/[^0-9.]/g, '').slice(0, 10))}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor={colors.faintForeground}
                    inputAccessoryViewID={
                      Platform.OS === 'ios' ? AMOUNT_ACCESSORY_ID : undefined
                    }
                  />
                  <Text style={[text.data, { color: colors.faintForeground }]}>{SETTLEMENT.token}</Text>
                </View>

                {/* ── Where exactly ────────────────────────────────────── */}
                <Text style={[text.label, { color: colors.faintForeground, marginTop: 4 }]}>
                  Destination address
                </Text>
                <View style={styles.addressRow}>
                  <TextInput
                    style={[
                      styles.addressField,
                      {
                        color: colors.foreground,
                        backgroundColor: colors.surface,
                        borderColor:
                          toAddress.length === 0 || addressValid ? colors.border : colors.danger,
                      },
                    ]}
                    value={toAddress}
                    onChangeText={setToAddress}
                    placeholder="0x…"
                    placeholderTextColor={colors.faintForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {/*
                   * Forty hex characters is the one field nobody can proof-read,
                   * and retyping it by eye off another phone is how money goes to
                   * an address that does not exist.
                   *
                   * Native only: the sheet is reachable in a desktop browser,
                   * where there is usually no camera worth opening and pasting is
                   * easy anyway.
                   */}
                  {Platform.OS !== 'web' && (
                    <Pressable
                      onPress={() => {
                        setWithdrawError(null);
                        setScanOpen(true);
                      }}
                      hitSlop={6}
                      accessibilityLabel="Scan a wallet QR code"
                      style={({ pressed }) => [
                        styles.scanButton,
                        {
                          backgroundColor: colors.surface,
                          borderColor: colors.border,
                          opacity: pressed ? 0.6 : 1,
                        },
                      ]}
                    >
                      <Ionicons name="qr-code-outline" size={19} color={colors.accent} />
                    </Pressable>
                  )}
                </View>

                <Text
                  style={[
                    text.data,
                    { color: withdrawError ? colors.danger : colors.faintForeground, marginTop: 6 },
                  ]}
                >
                  {withdrawError ??
                    `${SETTLEMENT.chain} network only. Sending to an address on another chain loses the money.`}
                </Text>

                <Pressable
                  onPress={handleWithdraw}
                  disabled={!canWithdraw}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    {
                      backgroundColor: canWithdraw ? colors.primary : colors.sunken,
                      opacity: pressed ? 0.88 : 1,
                      paddingVertical: 16,
                      marginTop: 14,
                    },
                  ]}
                >
                  <Text
                    style={[
                      text.action,
                      { color: canWithdraw ? colors.primaryForeground : colors.faintForeground },
                    ]}
                  >
                    {withdrawAmountValue > 0
                      ? `Review $${withdrawAmountValue.toFixed(2)}`
                      : 'Review'}
                  </Text>
                </Pressable>
                  </>
                )}

                {withdrawStep === 'confirm' && (
                  <>
                    <Text style={[text.title, { color: colors.foreground }]}>Confirm</Text>
                    <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 4 }]}>
                      Check the address. A transfer cannot be reversed or recalled.
                    </Text>

                    <View style={[styles.balanceBox, { borderColor: colors.border }]}>
                      <Text style={[text.label, { color: colors.faintForeground }]}>Sending</Text>
                      <Text style={[text.amountLarge, { color: colors.foreground, fontSize: 30 }]}>
                        ${withdrawAmountValue.toFixed(2)}
                      </Text>
                      {ngnPerUsd !== null && (
                        <Text style={[text.data, { color: colors.mutedForeground }]}>
                          ≈ ₦{Math.round(withdrawAmountValue * ngnPerUsd).toLocaleString()}
                        </Text>
                      )}
                    </View>

                    <Text style={[text.label, { color: colors.faintForeground, marginTop: 16 }]}>
                      To this address
                    </Text>
                    {/* Shown in full and never truncated: the middle of an address
                        is exactly where a substitution would hide. */}
                    <View style={[styles.confirmAddress, { borderColor: colors.borderStrong }]}>
                      <Text style={[styles.address, { color: colors.foreground }]} selectable>
                        {toAddress.trim()}
                      </Text>
                    </View>

                    <View style={[styles.feeRow, { borderColor: colors.border }]}>
                      <Ionicons name="flash-outline" size={15} color={colors.primary} />
                      <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                        <Text style={{ color: colors.primary }}>No fee. </Text>
                        We pay the network cost, so the full amount arrives.
                      </Text>
                    </View>

                    {withdrawError && (
                      <Text style={[text.bodySmall, { color: colors.danger, marginTop: 12 }]}>
                        {withdrawError}
                      </Text>
                    )}

                    <Pressable
                      onPress={() => void sendWithdrawal()}
                      disabled={withdrawing}
                      style={({ pressed }) => [
                        styles.primaryBtn,
                        {
                          backgroundColor: colors.primary,
                          opacity: pressed || withdrawing ? 0.85 : 1,
                          paddingVertical: 16,
                          marginTop: 16,
                        },
                      ]}
                    >
                      {withdrawing ? (
                        <SendingIndicator label="Sending" color={colors.primaryForeground} />
                      ) : (
                        <Text style={[text.action, { color: colors.primaryForeground }]}>
                          {`Send $${withdrawAmountValue.toFixed(2)}`}
                        </Text>
                      )}
                    </Pressable>

                    <Pressable
                      onPress={() => !withdrawing && setWithdrawStep('form')}
                      disabled={withdrawing}
                      style={styles.backLink}
                    >
                      <Text style={[text.action, { color: colors.mutedForeground }]}>Back</Text>
                    </Pressable>
                  </>
                )}

                {withdrawStep === 'sent' && receipt && (
                  <>
                    <View style={styles.sentHead}>
                      <View style={[styles.sentBadge, { borderColor: colors.primary }]}>
                        <Ionicons name="checkmark" size={24} color={colors.primary} />
                      </View>
                      {/* Title and detail share one column so the detail hangs
                          off the title rather than off the badge. Nesting them
                          keeps that true without repeating the badge width as
                          a margin somewhere else. */}
                      <View style={styles.sentText}>
                        <Text style={[text.title, { color: colors.foreground }]}>Sent</Text>
                        <Text
                          style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 4 }]}
                        >
                          {`$${receipt.usdc.toFixed(2)} ${SETTLEMENT.token} is on its way. It usually
                          lands within seconds.`}
                        </Text>
                      </View>
                    </View>

                    <View style={[styles.receiptBox, { borderColor: colors.border }]}>
                      {[
                        { k: 'Amount', v: `$${receipt.usdc.toFixed(2)}` },
                        {
                          k: 'To',
                          v: `${receipt.to.slice(0, 10)}…${receipt.to.slice(-8)}`,
                        },
                        { k: 'Network', v: 'Base' },
                        { k: 'Fee', v: 'None — we covered it' },
                      ].map((row, i) => (
                        <View
                          key={row.k}
                          style={[
                            styles.receiptRow,
                            i > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
                          ]}
                        >
                          <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                            {row.k}
                          </Text>
                          <Text style={[text.data, { color: colors.foreground }]}>{row.v}</Text>
                        </View>
                      ))}
                    </View>

                    {/* The transaction hash is the only independent proof this
                        happened, so it is offered rather than merely mentioned. */}
                    <Pressable
                      onPress={() => openTx(receipt.txHash)}
                      style={({ pressed }) => [
                        styles.explorerBtn,
                        { borderColor: colors.borderStrong, opacity: pressed ? 0.8 : 1 },
                      ]}
                    >
                      <Ionicons name="open-outline" size={15} color={colors.foreground} />
                      <Text style={[text.action, { color: colors.foreground }]}>
                        {`View on ${SETTLEMENT.explorerName}`}
                      </Text>
                    </Pressable>

                    <Pressable
                      onPress={dismissWithdraw}
                      style={({ pressed }) => [
                        styles.primaryBtn,
                        {
                          backgroundColor: colors.foreground,
                          opacity: pressed ? 0.88 : 1,
                          paddingVertical: 16,
                          marginTop: 10,
                        },
                      ]}
                    >
                      <Text style={[text.action, { color: colors.background }]}>Done</Text>
                    </Pressable>
                  </>
                )}

              </ScrollView>

              {/* Sits outside the scroll view because iOS hosts it over the
                  keyboard rather than in the layout, and only on iOS because
                  Android has no such view and would render it inline. */}
              {Platform.OS === 'ios' && (
                <InputAccessoryView nativeID={AMOUNT_ACCESSORY_ID}>
                  <View
                    style={[
                      styles.accessoryBar,
                      { backgroundColor: colors.surface, borderTopColor: colors.border },
                    ]}
                  >
                    <Pressable onPress={() => Keyboard.dismiss()} hitSlop={10}>
                      <Text style={[text.action, { color: colors.accent }]}>Done</Text>
                    </Pressable>
                  </View>
                </InputAccessoryView>
              )}
            </Pressable>
          </SheetKeyboardView>
        </Pressable>

        {/*
         * Nested inside the withdrawal sheet rather than beside it, so it
         * unmounts with the sheet — and so a dismissed withdrawal can never
         * leave a camera running behind it.
         */}
        <AddressScanner
          visible={scanOpen}
          onClose={() => setScanOpen(false)}
          onScan={(address) => {
            setToAddress(address);
            setWithdrawError(null);
          }}
        />
      </Modal>

      {/* ── Receive ────────────────────────────────────────────────
          A self-custody wallet is topped up by being sent funds, so there is
          no amount to choose here — only an address to hand over. */}
      <Modal
        visible={receiveOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setReceiveOpen(false)}
        // Fires once the sheet is fully gone and iOS has the presentation
        // context back — the only safe moment to open the share sheet.
        onDismiss={() => {
          if (__DEV__) console.log('[share] modal onDismiss fired');
          if (!shareOnDismiss) return;
          setShareOnDismiss(false);
          void doShareAddress();
        }}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.overlay }]}
          onPress={() => setReceiveOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={[
              styles.sheet,
              {
                backgroundColor: colors.background,
                borderColor: colors.borderStrong,
                paddingBottom: (Platform.OS === 'web' ? 24 : insets.bottom) + 24,
              },
            ]}
          >
            <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
            <Text style={[text.title, { color: colors.foreground }]}>Add money</Text>
            <Text style={[text.bodySmall, { color: colors.mutedForeground }]}>
              {`Send ${SETTLEMENT.token} to this address and it lands in your wallet.`}
            </Text>

            {/* No wallet, no QR. A scannable code is an instruction to send
                money, so one is only ever drawn from a real address. */}
            {walletAddress ? (
              <>
                <View style={[styles.qrFrame, { backgroundColor: '#FFFFFF' }]}>
                  <QRCode
                    value={walletAddress}
                    size={168}
                    backgroundColor="#FFFFFF"
                    color="#000000"
                  />
                </View>

                <View style={[styles.addressBox, { borderColor: colors.border }]}>
                  <Text style={[text.label, { color: colors.faintForeground }]}>
                    Your address · Base
                  </Text>
                  <Text style={[styles.address, { color: colors.foreground }]} selectable>
                    {walletAddress}
                  </Text>
                </View>
              </>
            ) : (
              <View style={[styles.demoWarn, { borderColor: colors.pending }]}>
                <Ionicons name="hourglass-outline" size={15} color={colors.pending} />
                <Text style={[text.bodySmall, { color: colors.pending, flex: 1 }]}>
                  Your wallet is still being created. Reopen this in a moment and the address
                  will be here.
                </Text>
              </View>
            )}

            {/* Nothing to copy or share until the address exists. */}
            <View style={[styles.receiveActions, { opacity: walletAddress ? 1 : 0.4 }]}>
              <Pressable
                onPress={handleCopyAddress}
                disabled={!walletAddress}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  styles.btnFill,
                  {
                    backgroundColor: copied ? colors.primary : colors.foreground,
                    opacity: pressed ? 0.88 : 1,
                    paddingVertical: 14,
                  },
                ]}
              >
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={15}
                  color={copied ? colors.primaryForeground : colors.background}
                />
                <Text
                  style={[
                    text.action,
                    { color: copied ? colors.primaryForeground : colors.background },
                  ]}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Text>
              </Pressable>

              <Pressable
                onPress={handleShareAddress}
                disabled={!walletAddress}
                style={({ pressed }) => [
                  styles.outlineBtn,
                  styles.btnFill,
                  { borderColor: colors.borderStrong, opacity: pressed ? 0.7 : 1, paddingVertical: 14 },
                ]}
              >
                <Ionicons name="share-outline" size={15} color={colors.foreground} />
                <Text style={[text.action, { color: colors.foreground }]}>Share</Text>
              </Pressable>
            </View>

            {/* The one irreversible mistake available on this screen, so it
                gets the warning colour rather than the muted one it had. */}
            <View style={[styles.chainWarn, { borderColor: colors.pending }]}>
              <Ionicons name="warning-outline" size={15} color={colors.pending} />
              <Text style={[text.data, { color: colors.pending, flex: 1 }]}>
                {`Only send ${SETTLEMENT.onChain}. Tokens sent on another chain cannot be
                recovered.`}
              </Text>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 36 },

  person: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 22 },
  avatar: { width: 52, height: 52, borderRadius: 2 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontFamily: font.monoMedium, fontSize: 17 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  verifyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexShrink: 0,
  },


  numbers: { flexDirection: 'row', borderWidth: 2, borderRadius: 2, overflow: 'hidden' },
  numberCell: { flex: 1, alignItems: 'center', paddingVertical: 14, gap: 3 },

  sectionLabel: { marginTop: 30, marginBottom: 12 },

  wallet: { borderWidth: 2, borderRadius: 2, padding: 16 },
  walletTop: { marginTop: 30 },
  walletHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  walletActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  /**
   * Fills its row only where it is asked to.
   *
   * flex: 1 lived on the button itself, which is right in the two action rows
   * and wrong in the withdrawal sheet: that is a column, so flexBasis: 0 left
   * the button contributing no intrinsic height and it collapsed to its own
   * padding with the label squashed inside — a coloured box with no words on
   * it. A column child already stretches to full width without any of this.
   */
  btnFill: { flex: 1 },
  primaryBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 2,
    paddingVertical: 13,
    // Clips SendingIndicator's sweep to the button. Without it the highlight
    // travels out over the sheet on either side.
    overflow: 'hidden',
  },
  outlineBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 13,
  },


  records: { flexDirection: 'row', gap: 10, marginTop: 30 },
  recordCard: {
    flex: 1,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 7,
  },
  recordTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },


  segmented: { flexDirection: 'row', borderWidth: 2, borderRadius: 2, overflow: 'hidden' },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 12,
  },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 15,
    borderBottomWidth: 1,
  },

  signOut: {
    alignItems: 'center',
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 15,
    marginTop: 28,
  },

  backdrop: { flex: 1, justifyContent: 'flex-end' },
  // Fills the backdrop rather than hugging the sheet, so this is the box the
  // keyboard shrinks and the sheet keeps sitting on top of what is left.
  lift: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 2,
    paddingHorizontal: 22,
    paddingTop: 12,
    gap: 14,
    // Never taller than the space the keyboard leaves behind. Without this the
    // sheet keeps its full height and is pushed off the top of the screen.
    maxHeight: '92%',
  },
  // flexShrink so the scroll view gives up height to the cap above rather than
  // insisting on its content size and defeating it.
  sheetScroll: { flexShrink: 1 },
  accessoryBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    borderTopWidth: 2,
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  // The gap the sheet used to apply to these children directly, now that they
  // sit one level deeper.
  sheetContent: { gap: 14 },
  grabber: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  balanceBox: { borderWidth: 2, borderRadius: 2, padding: 14, gap: 3, marginTop: 4 },
  destRow: { flexDirection: 'row', gap: 9 },
  /**
   * Icon beside the name rather than stacked over it, which buys back a line
   * of height in a sheet that has to clear the keyboard.
   *
   * The label takes flex: 1 so a name too long for a half-width card wraps
   * under itself instead of pushing the icon out of the card.
   */
  destHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dest: {
    flex: 1,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 3,
  },
  destLocked: { opacity: 0.55 },
  amountHead: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  amountField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  amountPrefix: { fontFamily: font.monoMedium, fontSize: 19 },
  amountInput: { flex: 1, fontFamily: font.monoMedium, fontSize: 19, padding: 0 },
  addressRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  addressField: {
    flex: 1,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 13,
    paddingVertical: 12,
    fontFamily: font.mono,
    fontSize: 13,
  },
  // Square, and matched to the field beside it rather than given a height of
  // its own, so the two stay aligned whatever the font scale does.
  scanButton: {
    width: 46,
    borderWidth: 2,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  demoWarn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginTop: 4,
  },
  qrFrame: {
    alignSelf: 'center',
    padding: 14,
    borderRadius: 2,
    marginTop: 4,
  },
  addressBox: { borderWidth: 2, borderRadius: 2, padding: 13, gap: 6 },
  address: { fontFamily: font.mono, fontSize: 13, lineHeight: 19 },
  walletMeta: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  balanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 6 },
  refreshBtn: { alignItems: 'center', justifyContent: 'center', padding: 2 },
  chainWarn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    padding: 11,
    marginTop: 12,
  },
  confirmAddress: {
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginTop: 7,
  },
  feeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    padding: 12,
    marginTop: 14,
  },
  backLink: { paddingVertical: 13, alignItems: 'center' },
  // Badge beside the word rather than stacked over it. alignSelf is gone with
  // it: in a row that would fight the row's own alignment.
  // flex-start, not center: the text column is taller than the badge now,
  // and centring it against two lines drops the badge below the title it
  // belongs to.
  sentHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  sentText: { flex: 1 },
  sentBadge: {
    width: 52,
    height: 52,
    borderWidth: 2,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  receiptBox: { borderWidth: 2, borderRadius: 2, marginTop: 16 },
  receiptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  explorerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 14,
    marginTop: 16,
  },
  receiveActions: { flexDirection: 'row', gap: 10 },

});
