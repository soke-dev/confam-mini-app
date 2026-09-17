import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { font, text } from '@/constants/type';
import { FEE_PERCENT, VERIFIED_ONLY_ABOVE, formatNaira } from '@/constants/money';
import { Wordmark } from '@/components/Wordmark';
import { SETTLEMENT } from '@/constants/chain';

const STEPS = [
  {
    n: '01',
    title: 'You ask about a place',
    body: 'A question and the spot it is about. Asking costs nothing.',
  },
  {
    n: '02',
    title: 'Confam AI checks what is known',
    body: 'It reads what somebody already verified about that place and how old it is, and decides whether that still answers you. If it does, you get it straight away with the photograph, and you can tip whoever took it.',
  },
  {
    n: '03',
    title: 'Otherwise someone goes',
    body: 'You set what you will pay and how long they have. Whoever takes it first goes there in person.',
  },
  {
    n: '04',
    title: 'You decide',
    body: 'Photo or video comes back with the time and how far from the place it was taken. Confirm it and they are paid. Query it and a reviewer rules before any money moves.',
  },
];


export default function AboutScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 22 : insets.top + 6;

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

        <View style={{ marginTop: 24 }}>
          <Wordmark size={22} />
        </View>

        <Text style={[text.titleSoft, { color: colors.foreground, marginTop: 14 }]}>
          Real answers from people who are actually there.
        </Text>

        <Text style={[text.body, { color: colors.mutedForeground, marginTop: 10 }]}>
          Some things cannot be looked up. Whether a street floods, whether the queue is worth it,
          whether the shop is really open. Confam pays somebody already standing there to look
          and show you.
        </Text>

        <Text style={[text.label, styles.groupLabel, { color: colors.faintForeground }]}>
          How it works
        </Text>

        {STEPS.map((step) => (
          <View key={step.n} style={styles.step}>
            <Text style={[text.dataMedium, styles.stepNum, { color: colors.accent }]}>
              {step.n}
            </Text>
            <View style={{ flex: 1 }}>
              <Text style={[text.subheading, { color: colors.foreground }]}>{step.title}</Text>
              <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 2 }]}>
                {step.body}
              </Text>
            </View>
          </View>
        ))}

        <Text style={[text.label, styles.groupLabel, { color: colors.faintForeground }]}>
          Confam AI
        </Text>

        <Text style={[text.body, { color: colors.mutedForeground }]}>
          Every question goes to the agent first. It reads what somebody already verified about
          that place and how long ago, weighs it against what you are asking, and decides one
          thing: does anybody have to go.
        </Text>
        <Text style={[text.body, { color: colors.mutedForeground, marginTop: 10 }]}>
          It never answers from its own knowledge. Everything it gives you came from a person who
          stood there and photographed it, so a wrong answer is a wrong photograph rather than a
          confident guess. When it decides the evidence has aged past being true, it sends
          somebody instead, and tells you why in plain words before you spend anything.
        </Text>
        <Text style={[text.body, { color: colors.mutedForeground, marginTop: 10 }]}>
          It also reads evidence as it arrives, checking it is clear enough and shows what was
          asked. It can flag work but never rejects it: the person who walked there can send it
          anyway, and you decide.
        </Text>
        <Text style={[text.body, { color: colors.mutedForeground, marginTop: 10 }]}>
          Programs can use it too. You → Confam AI issues a key, and an agent can ask questions
          and pay verifiers exactly as the app does.
        </Text>

        <Text style={[text.label, styles.groupLabel, { color: colors.faintForeground }]}>
          The rules
        </Text>

        <View style={[styles.table, { borderColor: colors.border }]}>
          {[
            { k: 'Platform fee', v: `${FEE_PERCENT} of what the asker pays` },
            { k: 'Verified only', v: `Automatic above ₦${formatNaira(VERIFIED_ONLY_ABOVE)}` },
            { k: 'One job', v: 'One verifier, locked until it expires' },
            { k: 'Refunds', v: 'Full, if nobody delivers in your window' },
            { k: 'Settlement', v: `${SETTLEMENT.onChain}, when you confirm` },
          ].map((row, i) => (
            <View
              key={row.k}
              style={[
                styles.tableRow,
                i > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
              ]}
            >
              <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                {row.k}
              </Text>
              <Text
                style={[text.data, { color: colors.foreground, flex: 1.3, textAlign: 'right' }]}
              >
                {row.v}
              </Text>
            </View>
          ))}
        </View>

        <Text style={[text.label, styles.groupLabel, { color: colors.faintForeground }]}>
          Legal
        </Text>

        {/*
          * A link rather than the documents themselves.
          *
          * They lived here, which left the sign-in screen asking somebody to
          * agree to terms it had no way to open. On their own route they can
          * be pointed at from anywhere that needs them.
          */}
        <Pressable
          onPress={() => router.push('/legal')}
          style={[styles.legalRow, { borderBottomColor: colors.border }]}
        >
          <View style={styles.legalHead}>
            <Text style={[text.subheading, { color: colors.foreground, flex: 1 }]}>
              Terms, privacy and licences
            </Text>
            <Ionicons name="chevron-forward" size={15} color={colors.mutedForeground} />
          </View>
        </Pressable>

        <Text style={[text.data, styles.version, { color: colors.faintForeground }]}>
          Version 1.0.0
        </Text>
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
  groupLabel: { marginTop: 30, marginBottom: 12 },
  step: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  stepNum: { paddingTop: 2 },
  table: { borderWidth: 2, borderRadius: 2 },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  legalRow: { paddingVertical: 15, borderBottomWidth: 1 },
  legalHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  version: { marginTop: 28 },
});
