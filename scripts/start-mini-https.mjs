import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Runs the mini app over https, which is the only way the parts that matter
 * actually work.
 *
 * Geolocation and the camera are secure-context features. Browsers have
 * refused them on insecure origins since 2016; `http://localhost` is exempt
 * and `http://192.168.1.250:8081` — which is how a phone reaches this machine
 * — is not. Over plain http a verifier taking a job is told their location did
 * not come through, however long they wait, and evidence capture never starts
 * at all.
 *
 * Both halves need tunnelling, not just the app. An https page may not call an
 * http API: the browser blocks it as mixed content, and the failure looks like
 * the server being down. So this raises one tunnel for the API, tells the app
 * to use that address, then raises a second for the app itself.
 *
 *   cd api && npm run dev        (first, in its own terminal)
 *   npm run mini:https
 *
 * Quick tunnels are anonymous and disposable: the addresses change every run,
 * which is why the app is started between the two rather than before them.
 */

const API_PORT = process.env.API_PORT ?? '8080';
const APP_PORT = process.env.MINI_PORT ?? '8081';

const line = '─'.repeat(64);

/** Waits for a cloudflare quick tunnel to announce its address. */
function tunnel(port, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`],
      { shell: true },
    );

    let settled = false;
    const look = (chunk) => {
      const found = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (found && !settled) {
        settled = true;
        resolve({ url: found[0], child });
      }
    };

    /* cloudflared writes its banner to stderr, but not on every version. */
    child.stdout.on('data', look);
    child.stderr.on('data', look);

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`${label} tunnel exited before it published an address (code ${code})`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`${label} tunnel did not publish an address within 60s`));
      }
    }, 60_000);
  });
}

/* The API has to be up first: a tunnel to nothing publishes an address that
 * 502s, which is a confusing way to discover a server was never started. */
const reachable = await fetch(`http://localhost:${API_PORT}/health`)
  .then((r) => r.ok)
  .catch(() => false);

if (!reachable) {
  console.error(
    `\nNothing is answering on http://localhost:${API_PORT}.\n` +
      'Start the API first, in its own terminal:\n\n  cd api && npm run dev\n',
  );
  process.exit(1);
}

console.log('raising a tunnel for the API...');
const api = await tunnel(API_PORT, 'API');
console.log('  API  ' + api.url);

console.log('raising a tunnel for the app...');
const app = await tunnel(APP_PORT, 'app');
console.log('  app  ' + app.url);

console.log('');
console.log(line);
console.log('  Confam mini app, over https');
console.log(line);
console.log(`  Open on your phone   ${app.url}`);
console.log(`  Talking to the API   ${api.url}`);
console.log(line);
console.log('  Camera and location work here. They cannot over plain http.');
console.log('  Both addresses change every run — paste the new one each time.');
console.log(line);
console.log('');

const eas = JSON.parse(readFileSync('eas.json', 'utf8'));
const env = eas.build?.production?.env;
if (!env) throw new Error('start-mini-https: no production env block in eas.json.');

const expo = spawn('npx', ['expo', 'start', '--web', '--port', APP_PORT], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    ...env,
    EXPO_PUBLIC_API_URL: api.url,
    EXPO_PUBLIC_AUTH: 'wallet',
    EXPO_NO_DOTENV: '1',
  },
});

/* One Ctrl-C should take all three down, not leave two tunnels running. */
const stop = () => {
  api.child.kill();
  app.child.kill();
  expo.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
expo.on('exit', stop);
