import { useEffect } from 'react';
import { Asset } from 'expo-asset';
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
import Ionicons from '@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf';

/**
 * Registers the app's faces with the browser directly.
 *
 * `useFonts` is what loads them everywhere else and it does not work here: on
 * web it reported an error rather than the faces, so the board rendered in
 * whatever the browser reaches for by default and every icon came out as an
 * empty box — Ionicons is a font too, and it failed with the rest.
 *
 * The files are in the bundle and reachable; only the loading was broken. So
 * this skips it and writes the @font-face rules itself, using the URLs Metro
 * gives for the very same assets. Plain CSS, which a browser has understood
 * for twenty years, in place of a loader that has to work out what platform it
 * is on.
 *
 * The family names match `constants/type.ts` exactly. They have to: those are
 * what every style in the app asks for, and a rule declaring a name nothing
 * references would load a face that is never used.
 */

const FACES: [string, number][] = [
  ['Barlow_400Regular', Barlow_400Regular],
  ['Barlow_500Medium', Barlow_500Medium],
  ['Barlow_600SemiBold', Barlow_600SemiBold],
  ['Barlow_700Bold', Barlow_700Bold],
  ['IBMPlexMono_400Regular', IBMPlexMono_400Regular],
  ['IBMPlexMono_500Medium', IBMPlexMono_500Medium],
  ['IBMPlexMono_600SemiBold', IBMPlexMono_600SemiBold],
  ['IBMPlexMono_700Bold', IBMPlexMono_700Bold],
  /*
   * The icon font, under the name @expo/vector-icons asks for. Without it
   * every glyph renders as the browser's missing-character box, which is what
   * the empty square in the corner actually was.
   */
  ['ionicons', Ionicons],
];

const STYLE_ID = 'confam-web-fonts';

export function WebFonts() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;

    const rules = FACES.map(([family, mod]) => {
      /*
       * Asset.fromModule resolves what Metro exported to the URL it is served
       * at — hashed filename and all — so nothing here has to know or guess a
       * path.
       */
      const uri = Asset.fromModule(mod).uri;
      return [
        '@font-face {',
        `  font-family: "${family}";`,
        `  src: url("${uri}") format("truetype");`,
        /*
         * swap, not block. The fallback stack in constants/type.ts shows
         * immediately and is replaced the moment the real face arrives, which
         * is better than a blank screen while a font downloads on a phone.
         */
        '  font-display: swap;',
        '}',
      ].join('\n');
    }).join('\n\n');

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = rules;
    document.head.appendChild(style);
  }, []);

  return null;
}
