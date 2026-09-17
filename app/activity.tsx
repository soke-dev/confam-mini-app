import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import { useColors } from '@/hooks/useColors';
import { text } from '@/constants/type';
import { formatNaira } from '@/constants/money';
import { useApp, type WalletEntry } from '@/contexts/AppContext';
import { SETTLEMENT } from '@/constants/chain';

/**
 * How each kind of movement is named and signed.
 *
 * No unit here: every `amount` on a WalletEntry is naira, so a per-kind unit
 * was only ever a way to get it wrong. Deposits and withdrawals were marked
 * "$" while carrying a naira figure, printing ₦13.50 as "$13.5".
 */
const KIND: Record<
  WalletEntry['type'],
  { label: string; sign: '+' | '−'; tone: 'in' | 'out' | 'neutral' }
> = {
  earning: { label: 'Verification', sign: '+', tone: 'in' },
  refund: { label: 'Refunded', sign: '+', tone: 'in' },
  deposit: { label: 'Top up', sign: '+', tone: 'neutral' },
  withdrawal: { label: 'Withdrawn', sign: '−', tone: 'out' },
  tip: { label: 'Tip sent', sign: '−', tone: 'out' },
  hold: { label: 'Held for a question', sign: '−', tone: 'out' },
  fee: { label: 'Platform fee', sign: '−', tone: 'out' },
};

/** Anything the server adds later renders plainly instead of crashing. */
const UNKNOWN_KIND = { label: 'Movement', sign: '+', tone: 'neutral' } as const;

/** Base's block explorer, where a transaction can be verified independently. */
function openTx(txHash: string) {
  void Linking.openURL(SETTLEMENT.explorerTx(txHash));
}

export default function ActivityScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { walletHistory } = useApp();
  const topPad = Platform.OS === 'web' ? 22 : insets.top + 6;

  const money = (entry: WalletEntry) => {
    const meta = KIND[entry.type] ?? UNKNOWN_KIND;
    /**
     * Deposits arrive in USDC and the naira column is a conversion, so both
     * are shown: the dollars that actually moved, and what they were worth.
     * Everything else is naira-denominated and shows one figure.
     */
    if (entry.type === 'deposit' && typeof entry.amountUsdc === 'number') {
      return `+$${entry.amountUsdc} · ₦${formatNaira(entry.amount)}`;
    }
    return `${meta.sign}₦${formatNaira(entry.amount)}`;
  };

  const toneOf = (entry: WalletEntry) => {
    const tone = (KIND[entry.type] ?? UNKNOWN_KIND).tone;
    return tone === 'in'
      ? colors.money
      : tone === 'out'
        ? colors.mutedForeground
        : colors.foreground;
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
      >
        <Pressable
          onPress={() => router.back()}
          style={[styles.backBtn, { borderColor: colors.border }]}
        >
          <Ionicons name="arrow-back" size={18} color={colors.foreground} />
        </Pressable>

        <Text style={[text.display, { color: colors.foreground, marginTop: 22 }]}>Activity</Text>
        <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 6 }]}>
          {walletHistory.length === 0
            ? 'Nothing has moved yet.'
            : `Every naira in and out of your wallet · ${walletHistory.length} entries.`}
        </Text>

        <View style={{ marginTop: 24 }}>
          {walletHistory.map((entry) => (
            <View key={entry.id} style={[styles.row, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[text.subheading, { color: colors.foreground }]} numberOfLines={2}>
                  {entry.description}
                </Text>
                <Text style={[text.data, { color: colors.faintForeground }]}>
                  {(KIND[entry.type] ?? UNKNOWN_KIND).label}
                  {entry.pending ? ' · pending' : ''}
                </Text>
              </View>
              <View style={styles.amountCol}>
                <Text style={[text.dataMedium, { fontSize: 14, color: toneOf(entry) }]}>
                  {money(entry)}
                </Text>
                {/* Only on-chain rows have a hash. It is the one record of the
                    movement that does not depend on this app, so it is offered
                    to anyone who wants to check rather than take our word. */}
                {entry.txHash && (
                  <Pressable
                    onPress={() => openTx(entry.txHash!)}
                    hitSlop={8}
                    style={({ pressed }) => [styles.txLink, { opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Text style={[text.data, { color: colors.accent }]}>
                      {entry.txHash.slice(0, 8)}…{entry.txHash.slice(-6)}
                    </Text>
                    <Ionicons name="open-outline" size={11} color={colors.accent} />
                  </Pressable>
                )}
              </View>
            </View>
          ))}
        </View>

        {walletHistory.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={26} color={colors.faintForeground} />
            <Text
              style={[
                text.body,
                { color: colors.mutedForeground, textAlign: 'center', maxWidth: 260 },
              ]}
            >
              Payments for jobs you finish, money held against questions you ask, and top ups all
              appear here.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 44 },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    // Top-aligned: on-chain rows carry a second line under the amount, and
    // centring would drag the description off the description's own baseline.
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  amountCol: { alignItems: 'flex-end', gap: 3 },
  txLink: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 70 },
});
