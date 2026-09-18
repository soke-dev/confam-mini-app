import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Builds the mini app for hosting.
 *
 * The same app the phone runs and the same export the admin desk uses, with
 * one variable changed: EXPO_PUBLIC_AUTH=wallet, which swaps Privy's email
 * flow for a wallet signature and leaves every screen alone.
 *
 * Three things this exists to stop.
 *
 * The environment. Expo inlines EXPO_PUBLIC_* at export time from whatever
 * .env is lying around, and a developer's .env points at their own machine —
 * which has produced a bundle talking to 192.168.1.250 before now. The values
 * come from eas.json, which is already where production says what it points
 * at, so a hosted mini app and the store builds cannot disagree about where
 * the server is.
 *
 * The auth mode. Exported without EXPO_PUBLIC_AUTH it is the ordinary app: it
 * would ask somebody inside Nimiq Pay for an email address and a six digit
 * code, and there would be no wallet sign-in anywhere on it.
 *
 * The routing. The export is a single page — one index.html and a router that
 * runs in the browser — so a static host asked for /task/abc looks for a file
 * of that name and returns 404. The rewrite written into the output fixes
 * that.
 *
 *   npm run mini:export        then  npx vercel deploy dist-mini --prod
 */

const OUT = 'dist-mini';
const NEWLINE = String.fromCharCode(10);

const eas = JSON.parse(readFileSync('eas.json', 'utf8'));
const env = eas.build?.production?.env;

if (!env?.EXPO_PUBLIC_API_URL) {
  throw new Error(
    'export-mini: no production env in eas.json. That is where the API address ' +
      'lives; without it this would bake in whatever .env says.',
  );
}

const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? env.EXPO_PUBLIC_API_URL;

console.log('export-mini: building against', apiUrl);
console.log('export-mini: auth mode wallet');

const result = spawnSync(
  'npx',
  ['expo', 'export', '--platform', 'web', '--clear', '--output-dir', OUT],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      ...env,
      EXPO_PUBLIC_API_URL: apiUrl,
      EXPO_PUBLIC_AUTH: 'wallet',
      // Belt and braces: a stale .env must not win over eas.json.
      EXPO_NO_DOTENV: '1',
    },
  },
);

if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(OUT, { recursive: true });

writeFileSync(
  `${OUT}/vercel.json`,
  JSON.stringify(
    {
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
      headers: [
        {
          /*
           * Indexable, unlike the admin desk. This one is meant to be found:
           * it is the address people are given, and a mini app nobody can
           * look up is a mini app nobody opens.
           */
          source: '/(.*)',
          headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
        },
      ],
    },
    null,
    2,
  ) + NEWLINE,
);

/**
 * Moves the bundled assets out of a directory called node_modules.
 *
 * Metro writes font and image assets to a path mirroring where they came from,
 * so the app's typefaces land in `assets/node_modules/@expo-google-fonts/...`.
 * Vercel's uploader skips anything named node_modules, so those files were
 * never deployed — and with a single-page rewrite catching every unmatched
 * path, a request for a font returned index.html with a 200. Nothing looked
 * broken from the outside: the files simply were not there, and the app fell
 * back to the browser's default face with every icon as an empty box.
 *
 * Renaming the directory and rewriting the references is enough, because the
 * paths only ever appear as literal strings in the bundle.
 */
function unhideVendorAssets() {
  const from = `${OUT}/assets/node_modules`;
  if (!existsSync(from)) return;

  renameSync(from, `${OUT}/assets/vendor`);

  let patched = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) {
        const before = readFileSync(path, 'utf8');
        const after = before.split('assets/node_modules/').join('assets/vendor/');
        if (after !== before) {
          writeFileSync(path, after);
          patched += 1;
        }
      }
    }
  };
  walk(OUT);

  console.log(`export-mini: moved assets out of node_modules (${patched} file(s) rewritten)`);
}

unhideVendorAssets();

/*
 * The output is served as-is, so nothing may sit in it that is not meant to be
 * public. `vercel link` writes a .env.local there holding a VERCEL_OIDC_TOKEN,
 * and a static host asked for /.env.local may well hand it over.
 */
rmSync(`${OUT}/.env.local`, { force: true });
writeFileSync(`${OUT}/.vercelignore`, ['.env*', '.vercel', ''].join(NEWLINE));

console.log('');
console.log(`export-mini: wrote ${OUT}/vercel.json (SPA rewrite)`);
console.log('export-mini: stripped any token file from the output');
console.log(`export-mini: deploy with  npx vercel deploy ${OUT} --prod`);
