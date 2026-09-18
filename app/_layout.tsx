/**
 * The crypto polyfills used to live here, and could not work from here: this
 * is a route module, and the router has already loaded Privy by the time it
 * evaluates. They now run from index.js, ahead of the router entry.
 */

import React, { useEffect, type PropsWithChildren } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { WelcomeSheet } from '@/components/WelcomeSheet';
import { Wordmark } from '@/components/Wordmark';
import {
  Barlow_400Regular,
  Barlow_500Medium,
  Barlow_600SemiBold,
  Barlow_700Bold,
} from '@expo-google-fonts/barlow';
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
  IBMPlexMono_700Bold,
} from '@expo-google-fonts/ibm-plex-mono';
import { useFonts } from 'expo-font';
import { Stack, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColors } from '@/hooks/useColors';
import { AppProvider, useApp } from '@/contexts/AppContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { DialogProvider } from '@/contexts/DialogContext';
import { AuthProvider } from '@/components/AuthProvider';
import { ViewportHeight } from '@/components/ViewportHeight';
import { AccountSync } from '@/components/AccountSync';
import { useAuth } from '@/utils/privy';
import SignInScreen from './signin';
import AdminScreen from './admin';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

/**
 * Confam is a phone app, so on a desktop browser we sit it in a centred,
 * phone-width frame rather than letting it stretch the full window. Done in
 * React Native rather than in an `app/+html.tsx` shell because that shell is
 * only honoured under static rendering — this works in dev and in export.
 *
 * Native platforms pass straight through.
 */
function PhoneFrame({ children }: PropsWithChildren) {
  const colors = useColors();
  const { width, height } = useWindowDimensions();
  const segments = useSegments();

  /**
   * The review desk is not a phone app and must not be framed like one.
   *
   * Everything else here is built for a hand and gets a phone-width column on
   * a desktop browser. The desk is the opposite case: it is only ever opened
   * on a desktop, by staff, to compare an objection against a photograph — and
   * squeezing that into 420px made the evidence too small to judge, which is
   * the one thing the page exists for.
   */
  const isAdminRoute = segments[0] === 'admin';

  const framed = Platform.OS === 'web' && width >= 480 && !isAdminRoute;

  if (!framed) {
    return <View style={[styles.fill, { backgroundColor: colors.background }]}>{children}</View>;
  }

  return (
    <View style={[styles.backdrop, { backgroundColor: colors.backdrop }]}>
      <View
        style={[
          styles.frame,
          {
            backgroundColor: colors.background,
            borderColor: colors.borderStrong,
            height: Math.min(height - 48, 900),
          },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

/** First frame, before the fonts are registered. Themed, not blank. */
function BootScreen() {
  const colors = useColors();

  return (
    <View style={[styles.boot, { backgroundColor: colors.background }]}>
      {/* The same lockup the rest of the app uses, so the first painted frame
          is not a different wordmark from every frame after it. */}
      <Wordmark size={20} />
      <View style={[styles.bootRule, { backgroundColor: colors.accent }]} />
    </View>
  );
}

function RootLayoutNav() {
  const { user } = useApp();
  const { ready, user: privyUser } = useAuth();
  const colors = useColors();
  const segments = useSegments();

  /**
   * The review desk is a separate surface, not part of the app.
   *
   * It is reached by URL, has its own password, and is operated by staff who
   * have no reason to hold an Confam account. Routing it through the
   * sign-in gate would mean two unrelated credentials to see one page — and
   * would make a reviewer's ability to work depend on a Privy session they
   * should not need.
   */
  const isAdminRoute = segments[0] === 'admin';

  /**
   * Waits for Privy before deciding anyone is signed out.
   *
   * Privy restores its session from secure storage asynchronously, and app
   * state only learns about it once AccountSync runs. Checking `isSignedIn`
   * alone meant every refresh rendered the sign-in screen first and snapped to
   * the app a moment later — the person had not been signed out, we simply had
   * not finished asking.
   */
  if (isAdminRoute) return <AdminScreen />;

  if (!ready) return <BootScreen />;

  // Privy is the authority here: `user` is our mirror of it and lags by a
  // render, which is exactly the gap that caused the flash.
  if (!privyUser && !user?.isSignedIn) {
    return <SignInScreen />;
  }

  return (
    <>
      {/* Sits outside the Stack so it floats over whatever is showing, and so
          it survives navigation while it is open. */}
      <WelcomeSheet />
      <Stack
        screenOptions={{
          headerBackTitle: 'Back',
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="tracking/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="task/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="verify-identity" options={{ headerShown: false }} />
        <Stack.Screen name="notifications" options={{ headerShown: false }} />
        <Stack.Screen name="my-questions" options={{ headerShown: false }} />
        <Stack.Screen name="my-jobs" options={{ headerShown: false }} />
        <Stack.Screen name="history" options={{ headerShown: false }} />
        <Stack.Screen name="activity" options={{ headerShown: false }} />
        <Stack.Screen name="edit-profile" options={{ headerShown: false }} />
        <Stack.Screen name="alerts" options={{ headerShown: false }} />
        <Stack.Screen name="agent" options={{ headerShown: false }} />
        <Stack.Screen name="privacy" options={{ headerShown: false }} />
        <Stack.Screen name="help" options={{ headerShown: false }} />
        <Stack.Screen name="about" options={{ headerShown: false }} />
        <Stack.Screen name="legal" options={{ headerShown: false }} />
        <Stack.Screen name="disputes" options={{ headerShown: false }} />
        <Stack.Screen name="admin" options={{ headerShown: false }} />
        <Stack.Screen name="signin" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Barlow_400Regular,
    Barlow_500Medium,
    Barlow_600SemiBold,
    Barlow_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
    IBMPlexMono_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Returning null here would flash the host's white default before the
  // first painted frame. Paint the board's own ground instead. The custom
  // families are not registered yet, so this screen deliberately uses the
  // system face with signage tracking rather than referencing our tokens.
  if (!fontsLoaded && !fontError) return <BootScreen />;

  return (
    <SafeAreaProvider>
      {/* Renders nothing. Corrects the document height on web; a no-op on a
          device. Outside the providers because it depends on none of them. */}
      <ViewportHeight />
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={styles.fill}>
            <KeyboardProvider>
              <ThemeProvider>
                {/* Inside ThemeProvider because the dialog is themed, and
                    outside everything else so any screen can raise one. */}
                <DialogProvider>
                  <AuthProvider>
                    <AppProvider>
                      {/* Inside AppProvider: it writes what the server knows
                          into app state. Renders nothing. */}
                      <AccountSync />
                      <PhoneFrame>
                        <RootLayoutNav />
                      </PhoneFrame>
                    </AppProvider>
                  </AuthProvider>
                </DialogProvider>
              </ThemeProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  bootRule: { width: 46, height: 2 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
});
