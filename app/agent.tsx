import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { text } from '@/constants/type';
import { useDialog } from '@/contexts/DialogContext';
import {
  createAgentKey,
  listAgentKeys,
  revokeAgentKey,
  hasApi,
  type AgentKey,
} from '@/utils/questionsApi';
import { API_BASE } from '@/utils/api';
import { SETTLEMENT } from '@/constants/chain';

/**
 * Confam AI, for people who want to point a program at it.
 *
 * The keys have existed since the agent surface was built and nothing in the
 * app ever called them, so the only route to one was signing a message on a
 * web page — asking somebody already signed in here to prove who they are a
 * second time, somewhere else.
 *
 * Kept plain on purpose. This is a settings screen for a small number of
 * people who know what an API key is, not a pitch; the explaining belongs
 * where somebody is deciding whether to use the app at all.
 */
export default function AgentScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { confirm, notify } = useDialog();
  const topPad = Platform.OS === 'web' ? 22 : insets.top + 6;

  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * The one time a key is readable.
   *
   * Only its hash is stored, so this is not something that can be fetched
   * again later — it is shown until the screen is left, and said so plainly.
   */
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(async () => {
    if (!hasApi) {
      setLoading(false);
      return;
    }
    const result = await listAgentKeys();
    if (result.ok) setKeys(result.data.keys.filter((k) => !k.revokedAt));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    if (busy) return;
    setBusy(true);
    const result = await createAgentKey('From the app');
    setBusy(false);

    if (!result.ok) {
      await notify({
        title: 'Could not create a key',
        message: 'detail' in result && result.detail ? result.detail : 'Try again in a moment.',
      });
      return;
    }
    setFresh({ name: result.data.name, token: result.data.token });
    void load();
  }

  async function revoke(key: AgentKey) {
    const go = await confirm({
      title: `Revoke ${key.name}?`,
      message:
        'Anything using this key stops working immediately. Jobs it already created are not affected; those are yours either way.',
      confirmLabel: 'Revoke it',
      cancelLabel: 'Keep it',
      tone: 'danger',
    });
    if (!go) return;

    const result = await revokeAgentKey(key.id);
    if (!result.ok) {
      await notify({ title: 'Could not revoke it', message: 'Try again in a moment.' });
      return;
    }
    if (fresh) setFresh(null);
    void load();
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: topPad, paddingBottom: insets.bottom + 40 }]}
      >
        <Pressable
          onPress={() => router.back()}
          style={[styles.backBtn, { borderColor: colors.border }]}
        >
          <Ionicons name="arrow-back" size={18} color={colors.foreground} />
        </Pressable>

        <Text style={[text.display, { color: colors.foreground, marginTop: 22 }]}>Confam AI</Text>
        <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 6 }]}>
          An agent that decides whether anybody has to go and look. Ask it about a place and it
          answers from evidence somebody already brought back, if that still holds. Otherwise it
          {`pays a person nearby in ${SETTLEMENT.onChain} to walk there and photograph it.`}
        </Text>
        <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 10 }]}>
          It runs behind your own questions in this app. You can also point your own program at it.
        </Text>

        {/* ── Keys ────────────────────────────────────────────────── */}
        <Text style={[text.label, styles.groupLabel, { color: colors.faintForeground }]}>
          Your keys
        </Text>

        {fresh && (
          <View style={[styles.card, { borderColor: colors.primary, backgroundColor: colors.primarySoft }]}>
            <Text style={[text.label, { color: colors.primary }]}>Copy this now</Text>
            <Text style={[text.bodySmall, { color: colors.foreground, marginTop: 6 }]}>
              It is not stored and cannot be shown again.
            </Text>
            <Text selectable style={[styles.token, { color: colors.foreground, borderColor: colors.border }]}>
              {fresh.token}
            </Text>
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(fresh.token);
                await notify({ title: 'Copied', message: 'The key is on your clipboard.' });
              }}
              style={({ pressed }) => [
                styles.wideBtn,
                { backgroundColor: colors.primary, opacity: pressed ? 0.88 : 1 },
              ]}
            >
              <Text style={[text.action, { color: colors.primaryForeground }]}>Copy the key</Text>
            </Pressable>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
        ) : keys.length === 0 ? (
          <Text style={[text.bodySmall, { color: colors.faintForeground, marginTop: 12 }]}>
            No keys yet. One is enough to start; make another when you want to retire the first.
          </Text>
        ) : (
          keys.map((key) => (
            <View key={key.id} style={[styles.row, { borderColor: colors.border }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[text.body, { color: colors.foreground }]} numberOfLines={1}>
                  {key.name}
                </Text>
                <Text style={[text.data, { color: colors.faintForeground, marginTop: 2 }]}>
                  {key.hint}
                  {'   '}
                  {key.lastUsedAt
                    ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                    : 'never used'}
                </Text>
              </View>
              <Pressable onPress={() => void revoke(key)} hitSlop={10}>
                <Text style={[text.data, { color: colors.danger }]}>Revoke</Text>
              </Pressable>
            </View>
          ))
        )}

        <Pressable
          onPress={() => void mint()}
          disabled={busy || !hasApi}
          style={({ pressed }) => [
            styles.wideBtn,
            {
              backgroundColor: colors.surface,
              borderWidth: 2,
              borderColor: colors.borderStrong,
              opacity: pressed || busy ? 0.7 : 1,
              marginTop: 14,
            },
          ]}
        >
          <Text style={[text.action, { color: colors.foreground }]}>
            {busy ? 'Creating…' : 'Create a key'}
          </Text>
        </Pressable>

        {/* ── How ─────────────────────────────────────────────────── */}
        <Text style={[text.label, styles.groupLabel, { color: colors.faintForeground }]}>
          Connect your agent
        </Text>
        <Text style={[text.bodySmall, { color: colors.mutedForeground }]}>
          Send the key as an Authorization header. Everything else is two calls.
        </Text>

        <View style={[styles.code, { borderColor: colors.border, backgroundColor: colors.sunken }]}>
          <Text style={[text.data, { color: colors.mutedForeground }]}>
            {[
              `GET  ${API_BASE || 'https://…'}/agent`,
              '  the tool definitions, ready to paste',
              '',
              'POST /agent/ask',
              '  { "question": "Is the gate open?",',
              '    "place": "Apapa" }',
              '',
              'GET  /agent/ask/<id>',
              '  poll for the answer and the photographs',
              '',
              'POST /agent/ask/<id>/accept',
              '  pay the verifier, release the escrow',
              '',
              'Authorization: Bearer sk_confam_…',
            ].join('\n')}
          </Text>
        </View>

        <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 12 }]}>
          An answer nobody queries within fifteen minutes is accepted for you, so a verifier is
          never left waiting on a program that stopped calling.
        </Text>

        <Pressable
          onPress={() => void Linking.openURL(`${API_BASE}/confamagent`)}
          disabled={!hasApi}
          style={({ pressed }) => [
            styles.wideBtn,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.88 : 1,
              marginTop: 16,
            },
          ]}
        >
          <Text style={[text.action, { color: colors.primaryForeground }]}>
            Open Confam Agent
          </Text>
        </Pressable>

        <Text style={[text.data, { color: colors.faintForeground, marginTop: 10, textAlign: 'center' }]}>
          Full documentation is /docs inside it.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: 20 },
  backBtn: {
    width: 38,
    height: 38,
    borderWidth: 2,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupLabel: { marginTop: 30, marginBottom: 10 },
  card: { borderWidth: 2, borderRadius: 2, padding: 16, marginTop: 4 },
  token: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    borderWidth: 2,
    borderRadius: 2,
    padding: 10,
    marginTop: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 2,
    borderRadius: 2,
    padding: 14,
    marginTop: 8,
  },
  code: { borderWidth: 2, borderRadius: 2, padding: 14, marginTop: 12 },
  wideBtn: {
    borderRadius: 2,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
