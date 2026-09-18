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
  // Explicitly false, not merely falsy: an older browser that has never heard
  // of isSecureContext leaves it undefined, and guessing "insecure" there
  // would blame the page for a failure that is probably a real one.
  return (window as { isSecureContext?: boolean }).isSecureContext === false;
}
