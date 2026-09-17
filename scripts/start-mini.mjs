import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

/**
 * Runs the app as the Nimiq Pay mini app, in development.
 *
 * Same app, same screens, one difference: EXPO_PUBLIC_AUTH=wallet swaps the
 * email panel for a wallet signature, because inside a wallet host there is no
 * email round trip worth running and no embedded wallet worth creating.
 *
 * The API address is worked out rather than configured. Nimiq Pay runs on a
 * phone, so "localhost" is the phone — an app told to talk to localhost:8080
 * would be looking for the API on the handset and finding nothing. It needs
 * this machine's address on the network the phone is also on, and that address
 * changes with the network, so hardcoding it means it works today and confuses
 * somebody in a fortnight.
 *
 *   npm run mini
 *
 * The API has to be running too, in its own terminal:  cd api && npm run dev
 */

/** This machine's address on the local network, as a phone would reach it. */
function lanAddress() {
  const candidates = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      /*
       * Virtual adapters first to be rejected. A machine with Docker, WSL or a
       * VPN installed offers several IPv4 addresses and only one of them is on
       * the Wi-Fi the phone is on; picking the wrong one produces an app that
       * loads and then cannot reach the API, which looks like a broken build
       * rather than a wrong address.
       */
      const virtual = /virtual|vethernet|wsl|docker|loopback|vpn|tailscale|hyper-v/i.test(name);
      candidates.push({ name, address: entry.address, virtual });
    }
  }

  const real = candidates.find((c) => !c.virtual) ?? candidates[0];
  return real ?? null;
}

const PORT = process.env.MINI_PORT ?? '8081';
const API_PORT = process.env.API_PORT ?? '8080';

const lan = lanAddress();
if (!lan) {
  throw new Error(
    'start-mini: no network address found. A phone cannot reach this machine ' +
      'over localhost, so there is nothing useful to start.',
  );
}

const eas = JSON.parse(readFileSync('eas.json', 'utf8'));
const env = eas.build?.production?.env;
if (!env) {
  throw new Error('start-mini: no production env block in eas.json.');
}

const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? `http://${lan.address}:${API_PORT}`;

const line = '─'.repeat(58);
console.log(line);
console.log('  Confam mini app');
console.log(line);
console.log(`  Open on your phone   http://${lan.address}:${PORT}`);
console.log(`  Talking to the API   ${apiUrl}`);
console.log(`  Network adapter      ${lan.name}`);
console.log(line);
console.log('  In Nimiq Pay: Mini Apps, then the Custom URL field.');
console.log('  The phone must be on the same Wi-Fi as this machine.');
console.log('  The API runs separately:  cd api && npm run dev');
console.log(line);
console.log('');

const result = spawnSync('npx', ['expo', 'start', '--web', '--port', PORT], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    ...env,
    EXPO_PUBLIC_API_URL: apiUrl,
    EXPO_PUBLIC_AUTH: 'wallet',
    /*
     * A stale .env must not win over eas.json. Without this, dotenv fills in
     * anything eas.json happens not to name — which is how an over-the-air
     * update once pointed every installed copy of the app at a laptop.
     */
    EXPO_NO_DOTENV: '1',
  },
});

process.exit(result.status ?? 1);
