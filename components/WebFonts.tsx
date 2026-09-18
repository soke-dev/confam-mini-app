/**
 * The device no-op. WebFonts.web.tsx does the work in a browser.
 *
 * On iOS and Android `useFonts` loads the faces properly, so there is nothing
 * to register and no document to register it with.
 */
export function WebFonts() {
  return null;
}
