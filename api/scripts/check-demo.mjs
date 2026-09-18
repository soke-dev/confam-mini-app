/**
 * Parses the script inside every generated page, and fails the build if one
 * does not.
 *
 * A page here is a string inside a TypeScript template literal containing HTML
 * containing JavaScript, so a backslash has to survive three levels of
 * escaping and twice it did not. Nothing complained: tsc sees a valid string,
 * the server serves it happily, the browser hits a SyntaxError on load and
 * every button on the page silently stops working — which looks exactly like
 * a page that was never wired up.
 *
 * A parse is all this needs to be. It costs milliseconds and catches the whole
 * class.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Parses one generated page's inline script, or ends the build. */
function mustParse(label, html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) {
    console.error(`check-demo: no <script> block found in the ${label}`);
    process.exit(1);
  }

  const slug = label.replace(/[^a-z]+/gi, '-');
  const file = join(tmpdir(), `confam-${slug}-check-${process.pid}.js`);
  writeFileSync(file, match[1]);

  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`check-demo: ${label} script parses (${match[1].length} chars)`);
  } catch (error) {
    console.error(`check-demo: the ${label} script does not parse\n`);
    console.error(String(error.stderr ?? error.message));
    process.exit(1);
  } finally {
    try { unlinkSync(file); } catch {}
  }
}

/**
 * Every element the script reaches for must exist in the markup.
 *
 * A parse proves the script is well formed, not that it is wired to anything.
 * Rename an id in the HTML and the JavaScript still parses perfectly, then
 * throws on the first getElementById at load — which stops the whole script,
 * so the page renders and does nothing at all. That is the same silent failure
 * as a SyntaxError and it is not caught by parsing.
 *
 * Only literal lookups are checked. Ids built at runtime, like
 * el('tab-' + name), are skipped rather than guessed at: a check that invents
 * what it cannot see would fail on correct code.
 */
function mustBeWired(label, html) {
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] ?? '';
  const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  const wanted = new Set([
    ...[...script.matchAll(/\bel\('([\w-]+)'\)/g)].map((m) => m[1]),
    ...[...script.matchAll(/\b(?:show|text)\('([\w-]+)',/g)].map((m) => m[1]),
  ]);

  const missing = [...wanted].filter((id) => !declared.has(id));
  if (missing.length > 0) {
    console.error(
      `check-demo: the ${label} script reaches for ${missing.length} element(s) ` +
        `that the page does not contain:\n  ${missing.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(`check-demo: ${label} is wired (${wanted.size} ids, all present)`);
}

const { DEMO_PAGE } = await import('../dist/demoPage.js');
mustParse('agent terminal', DEMO_PAGE);

/*
 * The landing page is rendered once, for the same reason the terminal's script
 * is parsed: it is generated, nothing imports it at build time, and a fault in
 * it is invisible until somebody loads the site.
 *
 * icon() throws on a name it does not have. That is not hypothetical — the
 * Apple and Android marks were deleted along with the store badges that had
 * replaced them, and the chips went out with a hole where each logo belonged.
 */
const { landingPage } = await import('../dist/landingPage.js');
const page = landingPage('https://www.confam.xyz');

const icons = (page.match(/<svg class="ico/g) || []).length;
if (icons < 12) {
  throw new Error(`check-demo: only ${icons} icons rendered on the landing page`);
}
console.log(`check-demo: landing page renders (${page.length} chars, ${icons} icons)`);
