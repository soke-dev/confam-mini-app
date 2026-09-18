export type Fix = { lat: number; lng: number };

export type WhereResult =
  | { ok: true; at: Fix }
  | { ok: false; why: 'refused' | 'unavailable'; detail?: string };

/**
 * Where the browser thinks it is, asked the way that is known to work.
 *
 * Straight to navigator.geolocation, rather than through expo-location, and
 * with the options that were measured returning a fix in 17ms accurate to 11m
 * inside Nimiq Pay on a real phone.
 *
 * Two things about the library version made it unusable here. Its
 * getCurrentPositionAsync accepts no timeout, so a fix that never arrives is a
 * promise that never settles and a screen that never moves — which is exactly
 * what "finding where you are" did. And its permission handling goes through
 * the Permissions API, which in a WebView can answer "prompt" forever without
 * ever showing one.
 *
 * The browser's own call has a timeout argument and reports refusal as a
 * distinct code, so both problems go away by asking it directly.
 */

const TIMEOUT_MS = 15_000;

/** PERMISSION_DENIED. Named, because 1 on its own says nothing. */
const DENIED = 1;

export function whereAmI(_ask: boolean): Promise<WhereResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, why: 'unavailable', detail: 'navigator.geolocation is missing' });
      return;
    }

    /*
     * The browser prompts on the call itself, so there is no separate asking
     * step — which is why `ask` is ignored here. Answering "no" arrives as
     * PERMISSION_DENIED, and that is the only signal worth treating as final.
     */
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          ok: true,
          at: { lat: position.coords.latitude, lng: position.coords.longitude },
        }),
      (error) =>
        resolve({
          ok: false,
          why: error.code === DENIED ? 'refused' : 'unavailable',
          /*
           * Code and message together. The codes are 1 denied, 2 position
           * unavailable, 3 timed out, and they mean genuinely different
           * things: one is a permission, one is a device with no fix to give,
           * one is fifteen seconds of nothing. Showing only the friendly
           * sentence threw all three away.
           */
          detail: `code ${error.code}: ${error.message || 'no message'}`,
        }),
      { enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: 0 },
    );
  });
}
