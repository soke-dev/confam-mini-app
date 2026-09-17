import React, { useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Platform,
  ScrollView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LEGAL } from '@/constants/legal';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useThemeMode } from '@/contexts/ThemeContext';
import { font, text } from '@/constants/type';
import { useApp } from '@/contexts/AppContext';
import { useEmailLogin, privyConfigured, WALLET_MODE } from '@/utils/privy';
import { WalletSignIn } from '@/components/WalletSignIn';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Wordmark } from '@/components/Wordmark';

function isValidEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}


export default function SignInScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { mode, setMode } = useThemeMode();
  const { signIn } = useApp();
  const { sendCode, loginWithCode, state, error } = useEmailLogin();

  const [email, setEmail] = useState('');
  /** Which document is open over the sheet, if any. */
  const [legal, setLegal] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const inputRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);

  /**
   * The code step is driven by Privy's own flow state, not by a local flag.
   * A local `sent` boolean would drift out of step with the SDK — a resend, a
   * failure, or a restored session would leave the screen showing a stage the
   * SDK is no longer in.
   */
  const awaitingCode = state === 'awaiting-code' || state === 'submitting';
  const busy = state === 'sending' || state === 'submitting';

  const fade = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(20)).current;

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(rise, { toValue: 0, tension: 58, friction: 10, useNativeDriver: true }),
    ]).start();
  }, [fade, rise]);

  const valid = isValidEmail(email);
  const codeValid = /^\d{6}$/.test(code);

  async function handleContinue() {
    if (!valid || busy) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Without Privy configured there is nothing to send a code with. Falling
    // through to the local session keeps the rest of the app reachable, and
    // the screen says so rather than pretending an email went out.
    if (!privyConfigured) {
      signIn(email.trim().toLowerCase());
      return;
    }

    try {
      await sendCode(email.trim().toLowerCase());
      codeRef.current?.focus();
    } catch {
      // useEmailLogin surfaces the reason through `error`.
    }
  }

  async function handleVerify() {
    if (!codeValid || busy) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await loginWithCode(code);
      // Privy owns the session now; this mirrors it into app state so the
      // rest of the screens keep working off one source.
      signIn(email.trim().toLowerCase());
    } catch {
      setCode('');
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {/*
       * KeyboardAvoidingView only shrank the screen; it never moved the
       * focused field. The email input sits high enough to survive that, but
       * the six-digit code is further down the page and ended up behind the
       * keypad — you could type a code you could not read.
       *
       * KeyboardAwareScrollView scrolls whatever has focus into view instead,
       * which is the behaviour this screen actually needed. It has been in the
       * tree since KeyboardProvider went into the root layout, just unused.
       */}
      <KeyboardAwareScrollViewCompat
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: (Platform.OS === 'web' ? 26 : insets.top) + 26,
            paddingBottom: (Platform.OS === 'web' ? 28 : insets.bottom) + 28,
          },
        ]}
      >
        <Animated.View style={{ opacity: fade, transform: [{ translateY: rise }] }}>
          {/* ── Masthead ───────────────────────────────────────────── */}
          <View style={styles.masthead}>
            {/*
              * The shared mark, not a second copy of it.
              *
              * This screen drew its own two-tone "ASK NEARBY" in local styles,
              * so the rebrand renamed the app everywhere the component was
              * used and left the one screen that had its own — the first
              * screen anybody sees. Rendering the component means the next
              * change to the mark reaches here whether or not anyone
              * remembers this file exists.
              */}
            <Wordmark size={19} />

            <Pressable
              onPress={() => setMode(colors.isDark ? 'light' : 'dark')}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={colors.isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              style={({ pressed }) => [
                styles.themeBtn,
                { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
              ]}
            >
              <Ionicons
                name={colors.isDark ? 'sunny-outline' : 'moon-outline'}
                size={16}
                color={colors.mutedForeground}
              />
            </Pressable>
          </View>

          {/*
            * The tagline is the headline now.
            *
            * "Real answers from people who are actually there" described the
            * mechanism, and the three lines below already do that, with
            * examples. This says what the product is, which is what a
            * headline is for, and it is what the terminal has been saying
            * all along.
            */}
          <Text style={[styles.headline, { color: colors.foreground }]}>
            The physical world,{'\n'}
            <Text style={{ color: colors.accent }}>on demand.</Text>
          </Text>

          {/*
            * Two lines. The questions, then everything else.
            *
            * This was four evenly spaced statements, then three, and both read
            * as a list rather than one idea. The questions go first because
            * recognising one you have wanted answered explains this faster
            * than any description can; the rest is a single sentence about who
            * answers and one clause about why it can be trusted.
            *
            * The chain is mentioned as proof rather than as payment. What
            * somebody signing up cares about is whether an answer can be
            * trusted, not which token moved.
            */}
          <View style={styles.facts}>
            <Text style={[text.body, { color: colors.foreground }]}>
              Is the road flooded? Is the queue long? Is the shop open?
            </Text>
            <Text style={[text.body, { color: colors.mutedForeground, marginTop: 8 }]}>
              Confam AI answers what is known, or somebody nearby goes and looks. Machines ask
              too, all proved on chain.
            </Text>
          </View>

          {/* ── Sign in ────────────────────────────────────────────── */}
          {/*
            * In the mini app the email panel is replaced rather than added to.
            * Somebody inside a wallet host has no reason to be asked for an
            * address and a six digit code: the credential they are carrying is
            * the wallet, and asking for anything else would be asking them to
            * make a second account for it.
            *
            * Everything around this — the headline, the three questions, the
            * legal footer — is the screen the app already had.
            */}
          {WALLET_MODE ? (
            <View style={styles.form}>
              <WalletSignIn />
            </View>
          ) : (
          <View style={styles.form}>
            <Text style={[text.label, { color: colors.faintForeground }]}>Your email</Text>
            <View
              style={[
                styles.field,
                {
                  backgroundColor: colors.surface,
                  borderColor: valid ? colors.primary : colors.borderStrong,
                },
              ]}
            >
              <TextInput
                ref={inputRef}
                style={[styles.input, { color: colors.foreground }]}
                placeholder="you@example.com"
                placeholderTextColor={colors.faintForeground}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={handleContinue}
              />
              {valid && <Ionicons name="checkmark-circle" size={19} color={colors.primary} />}
            </View>

            {/* The six digits Privy just emailed. Shown only once the code is
                genuinely on its way, so the field never appears empty and
                unexplained. */}
            {awaitingCode && (
              <>
                <Text style={[text.label, { color: colors.faintForeground, marginTop: 16 }]}>
                  Six-digit code
                </Text>
                <View
                  style={[
                    styles.field,
                    {
                      backgroundColor: colors.surface,
                      borderColor: codeValid ? colors.primary : colors.borderStrong,
                    },
                  ]}
                >
                  <TextInput
                    ref={codeRef}
                    style={[styles.input, { color: colors.foreground, letterSpacing: 6 }]}
                    placeholder="000000"
                    placeholderTextColor={colors.faintForeground}
                    value={code}
                    onChangeText={(v) => setCode(v.replace(/[^0-9]/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    returnKeyType="go"
                    onSubmitEditing={handleVerify}
                  />
                  {codeValid && (
                    <Ionicons name="checkmark-circle" size={19} color={colors.primary} />
                  )}
                </View>
                <Text style={[text.data, { color: colors.faintForeground }]}>
                  Sent to {email}.{' '}
                  <Text style={{ color: colors.accent }} onPress={handleContinue}>
                    Send again
                  </Text>
                </Text>
              </>
            )}

            {error && (
              <View style={[styles.errorRow, { borderColor: colors.danger }]}>
                <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                <Text style={[text.bodySmall, { color: colors.danger, flex: 1 }]}>{error}</Text>
              </View>
            )}

            <Pressable
              onPress={awaitingCode ? handleVerify : handleContinue}
              disabled={busy || (awaitingCode ? !codeValid : !valid)}
              style={({ pressed }) => [
                styles.continueBtn,
                {
                  backgroundColor: (awaitingCode ? codeValid : valid)
                    ? colors.accent
                    : colors.sunken,
                  opacity: pressed ? 0.88 : 1,
                },
              ]}
            >
              <Text
                style={[
                  text.action,
                  {
                    color: (awaitingCode ? codeValid : valid)
                      ? colors.accentForeground
                      : colors.faintForeground,
                  },
                ]}
              >
                {state === 'sending'
                  ? 'Sending code'
                  : state === 'submitting'
                    ? 'Checking'
                    : awaitingCode
                      ? 'Sign in'
                      : 'Continue'}
              </Text>
              {!busy && (
                <Ionicons
                  name="arrow-forward"
                  size={16}
                  color={
                    (awaitingCode ? codeValid : valid)
                      ? colors.accentForeground
                      : colors.faintForeground
                  }
                />
              )}
            </Pressable>

            {/*
              * Only the warning survives here.
              *
              * The reassurance it used to carry — that we email a code and one
              * account both asks and earns — explained the next screen to
              * somebody who was about to see it anyway, and sat between the
              * button and the terms doing nothing for either.
              *
              * The other branch stays: a build with no sign-in service walks
              * straight past authentication, and that must not be silent.
              */}
            {!privyConfigured && (
              <Text style={[text.bodySmall, { color: colors.faintForeground }]}>
                No sign-in service is configured in this build, so this goes straight in.
              </Text>
            )}
          </View>
          )}

          {/*
            * Openable, because it is being agreed to.
            *
            * This was plain text with the documents three taps away inside
            * About, so somebody was asked to accept terms the screen gave them
            * no way to read.
            *
            * A sheet rather than a route: the layout renders this screen
            * *instead of* the navigator when nobody is signed in, so
            * router.push has nothing to push onto and the links did nothing at
            * all. Mounting the navigator for signed-out people would bring
            * back the sign-in flash the layout was arranged to avoid.
            */}
          <Text style={[text.data, styles.terms, { color: colors.faintForeground }]}>
            By continuing you agree to our{' '}
            <Text style={{ color: colors.accent }} onPress={() => setLegal('Terms of service')}>
              Terms
            </Text>
            {' and '}
            <Text style={{ color: colors.accent }} onPress={() => setLegal('Privacy policy')}>
              Privacy Policy
            </Text>
            .
          </Text>
        </Animated.View>
      </KeyboardAwareScrollViewCompat>

      {/*
        * The document itself, over the sheet.
        *
        * Full screen rather than a peek: a privacy policy somebody has to
        * scroll inside a 200px box is one they will not read, which defeats
        * the point of making it reachable at all.
        */}
      <Modal
        visible={legal !== null}
        animationType="slide"
        onRequestClose={() => setLegal(null)}
      >
        <View style={[styles.screen, { backgroundColor: colors.background }]}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: (Platform.OS === 'web' ? 20 : insets.top) + 12,
              paddingBottom: insets.bottom + 40,
            }}
          >
            <Pressable
              onPress={() => setLegal(null)}
              style={[styles.legalClose, { borderColor: colors.border }]}
            >
              <Ionicons name="close" size={18} color={colors.foreground} />
            </Pressable>

            <Text style={[text.display, { color: colors.foreground, marginTop: 20 }]}>
              {legal}
            </Text>
            <Text style={[text.bodySmall, { color: colors.faintForeground, marginTop: 8 }]}>
              Written in plain language so it can be read. It has not yet been reviewed by a
              lawyer, and some limits may be narrower in practice than they are written, because
              consumer law overrides an agreement in places.
            </Text>

            {LEGAL.find((d) => d.title === legal)?.body.map((para) => (
              <Text
                key={para}
                style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 12 }]}
              >
                {para}
              </Text>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  legalClose: {
    width: 38,
    height: 38,
    borderWidth: 2,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // No justifyContent:'center' here. Centring a content container that can
  // outgrow the viewport clips the top of the headline beyond reach.
  scroll: { paddingHorizontal: 24, flexGrow: 1 },

  masthead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 30,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    padding: 11,
  },
  themeBtn: {
    width: 34,
    height: 34,
    borderWidth: 2,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  headline: {
    fontFamily: font.sansBold,
    fontSize: 33,
    lineHeight: 36,
    letterSpacing: -0.2,
    textTransform: 'uppercase',
  },

  facts: { marginTop: 18 },
  plate: {
    width: 30,
    height: 30,
    borderWidth: 2,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  form: { marginTop: 26, gap: 10 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 15,
    paddingVertical: 14,
  },
  input: { flex: 1, fontFamily: font.sans, fontSize: 16 },
  continueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 2,
    paddingVertical: 16,
    marginTop: 4,
  },

  terms: { marginTop: 28, lineHeight: 17 },
});
