import { useEffect } from 'react';

/**
 * Makes the app as tall as the window actually is.
 *
 * Expo's web shell sets `height: 100%` on html, body and #root. A percentage
 * height resolves against the *large* viewport — the page as it would be if
 * the browser's chrome were hidden — so on a phone browser that keeps a URL
 * bar on screen, the document is taller than the window by exactly that bar.
 * Everything anchored to the bottom then sits below the fold, which is what
 * the tab bar slipping down the screen inside Nimiq Pay on Android actually
 * was.
 *
 * `100dvh` is the dynamic viewport height: what is visible now, remeasured as
 * chrome comes and goes.
 *
 * Applied from here rather than from app/+html.tsx, which would be the natural
 * home for it and does not work: that file is only read when web output is
 * "static", and this app exports as a single page, where Expo serves its own
 * index.html and ignores it. A rule appended to head at runtime wins on order
 * against the shell's own, in both modes, and needs no change to how the app
 * is built.
 */

const STYLE_ID = 'confam-viewport-height';

const CSS = `
  html, body {
    /* Fallback first, so a browser without dvh keeps the old behaviour. */
    height: 100vh;
    height: 100dvh;
  }
  #root {
    height: 100vh;
    height: 100dvh;
  }
`;

export function ViewportHeight() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    // Idempotent: fast refresh and remounts must not stack copies of this.
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;

    /*
     * Appended last so it follows Expo's #expo-reset block. Both are plain
     * element selectors of equal specificity, so the later one wins — which
     * is the whole mechanism, and the reason this must not be inserted before
     * the shell's own styles.
     */
    document.head.appendChild(style);
  }, []);

  return null;
}
