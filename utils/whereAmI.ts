import * as Location from 'expo-location';

/**
 * Where the phone thinks it is, or why it will not say.
 *
 * The device half. whereAmI.web.ts does the same job in a browser, and does it
 * differently for a reason worth stating: expo-location's
 * getCurrentPositionAsync takes no timeout, so a fix that never arrives is a
 * promise that never settles. On a device that is survivable — the OS gives up
 * on its own eventually. In a WebView it is not, and the screen sits on
 * "finding where you are" indefinitely.
 */

export type Fix = { lat: number; lng: number };

export type WhereResult =
  | { ok: true; at: Fix }
  /** 'refused' means asking again is pointless; only Settings can undo it. */
  | { ok: false; why: 'refused' | 'unavailable' };

/**
 * How long to wait for a fix.
 *
 * Fifteen seconds, matching what was measured inside Nimiq Pay, where a fix
 * came back in 17ms and accurate to 11m. The number is not there for the good
 * case — it is there so the bad one ends.
 */
const TIMEOUT_MS = 15_000;

/** Rejects rather than hanging, whatever the platform decides to do. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

export async function whereAmI(ask: boolean): Promise<WhereResult> {
  try {
    const permission = ask
      ? await Location.requestForegroundPermissionsAsync()
      : await Location.getForegroundPermissionsAsync();

    if (permission.status !== 'granted') {
      return { ok: false, why: permission.canAskAgain ? 'unavailable' : 'refused' };
    }

    const loc = await within(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      TIMEOUT_MS,
    );
    return { ok: true, at: { lat: loc.coords.latitude, lng: loc.coords.longitude } };
  } catch {
    return { ok: false, why: 'unavailable' };
  }
}
