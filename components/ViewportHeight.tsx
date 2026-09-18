/**
 * The device no-op. ViewportHeight.web.tsx does the work in a browser.
 *
 * There is nothing to correct here: a native app has no browser chrome above
 * it and no document to measure against.
 */
export function ViewportHeight() {
  return null;
}
