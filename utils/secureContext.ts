import { Platform } from 'react-native';

/**
 * Whether the browser is refusing location because of how the page was served.
 *
 * Geolocation, like the camera, is a powerful feature and browsers have only
 * offered it on secure origins since 2016. `https://` qualifies, and so does
 * `http://localhost` — but `http://192.168.1.250:8081`, which is how this app
 * is reached from a phone during development, does not.
 *
 * The failure is indistinguishable from a cold GPS: permission looks granted,
 * the call simply never produces a fix. So a verifier trying to take a job is
 * told to step outside and wait, which is advice that will never work, about a
 * problem that has nothing to do with where they are standing.
 *
 * Always false on a device: a native build has no origin and no such rule.
 */
export function insecurePage(): boolean {
  if (Platform.OS !== 'web') return false;
  if (typeof window === 'undefined') return false;
  const secure = (window as { isSecureContext?: boolean }).isSecureContext;
  if (secure === false) return true;

  /*
   * And the protocol, for the case that check cannot cover.
   *
   * isSecureContext is undefined in a WebView that does not implement it, and
   * treating undefined as "secure" meant the one message that would have
   * explained the problem never appeared — the screen fell through to "could
   * not find you" instead, which says nothing about the address it was served
   * from. http on a real host is insecure whether or not the browser will
   * admit to the concept; localhost is the documented exception.
   */
  const { protocol, hostname } = window.location ?? {};
  if (protocol !== 'http:') return false;
  return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]';
}
