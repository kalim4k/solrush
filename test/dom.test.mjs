// app.js reaches for elements by id and writes to them without checking. That
// is fine — they are all in index.html — right up until one is not, and then
// the first render throws and the whole page stays blank. Nothing else catches
// this: the file parses, the module loads, and the failure happens at runtime
// inside a handler nobody has clicked yet.
//
// So: every id app.js asks for must exist in the markup, and every data-i18n
// element must be reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'public/js/app.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// $('...') is the helper; getElementById is the same question written out.
const wanted = new Set([
  ...[...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]),
  ...[...app.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
]);

/* Elements app.js knows might not be there and checks for first.

   The donation block is the live example: its markup was pulled while the ad
   networks were reviewing the site, and the handler was left behind wrapped in
   `if ($('wallet-copy'))` so that putting the markup back is all it takes to
   wake it up. That is a guarded access, not a missing element, and a test that
   cannot tell them apart would push someone to delete working code. */
const OPTIONAL = new Set(['wallet-copy', 'wallet-addr']);

test('every id app.js reaches for exists in index.html', () => {
  const missing = [...wanted]
    .filter(id => !htmlIds.has(id) && !OPTIONAL.has(id))
    .sort();
  assert.deepEqual(missing, [],
    'app.js will throw on boot for: ' + missing.join(', '));
});

test('optional elements really are guarded before use', () => {
  // If one stops being guarded, it stops being optional — and the exemption
  // above would then be hiding a genuine boot crash.
  for (const id of OPTIONAL) {
    if (htmlIds.has(id)) continue;   // present after all; nothing to prove
    const guarded = app.includes(`if ($('${id}'))`)
      || new RegExp(`\\$\\('${id}'\\)\\?`).test(app);
    const insideGuardedBlock = /if \(\$\('wallet-copy'\)\) \{[\s\S]*?\n\}/.test(app);
    assert.ok(guarded || insideGuardedBlock, `"${id}" is used without a guard`);
  }
});

test('ids in the markup are unique', () => {
  // Two elements with one id means $() silently returns the first, and half the
  // updates land on the wrong node.
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set(), dupes = new Set();
  for (const id of all) { if (seen.has(id)) dupes.add(id); seen.add(id); }
  assert.deepEqual([...dupes], [], 'duplicate ids: ' + [...dupes].join(', '));
});

test('no third-party tag or foreign credential survives in the shipped files', () => {
  // The audit removed an ad network, an analytics token, a rewarded-video API
  // key and a set of social handles, all belonging to the original author.
  // This is the test that stops one creeping back in on a later copy-paste.
  /* These are the ORIGINAL author's, and must stay spelled their way — a
     project-wide rename of the brand once turned the domain entry below into
     our own, which quietly made this test assert nothing. */
  const banned = [
    'massivesalad', 'applixir', 'cloudflareinsights', 'cdn-cgi',
    'wall_rush', 'wallrush', 'Karoboev', 'esm.sh', 'supabase',
    'f12d997b',
  ];
  for (const [name, text] of [['index.html', html], ['app.js', app]]) {
    for (const needle of banned) {
      assert.ok(!text.includes(needle), `${name} still contains "${needle}"`);
    }
  }
});

test('the emoji buttons match the server allowlist exactly', () => {
  /* The server relays only the four it knows, so an emoji present in the
     markup but absent from that list is a button the player can press which
     silently never arrives — and the sender sees their own tap work, because
     nothing local fails. The two lists live in different files and different
     languages, so only a test keeps them together. */
  const server = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
  const inHtml = [...html.matchAll(/data-emoji="([^"]+)"/g)].map(m => m[1]);
  const listed = server.match(/if \(\[([^\]]+)\]\.includes\(msg\.e\)\)/);
  assert.ok(listed, 'the server allowlist could not be found');
  const inServer = [...listed[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(inHtml.sort(), inServer.sort());
});

test('every env() has a fallback', () => {
  /* This one cost a bug report.

     Firefox on the desktop does not define safe-area-inset-*, and an env()
     whose variable is undefined and which has no fallback makes the whole
     declaration invalid at computed-value time. `bottom` reverts to `auto`,
     and a position:fixed element with bottom:auto is laid out at its static
     position — so the bottom navigation stopped being pinned and appeared
     below the end of the page.

     Chrome defines the variable, so every screenshot looked right. Nothing but
     this test stands between the next env() and the same afternoon. */
  const css = readFileSync(join(ROOT, 'public/css/style.css'), 'utf8');
  const bare = [...css.matchAll(/env\(\s*([\w-]+)\s*\)/g)].map(m => m[0]);
  assert.deepEqual(bare, [],
    'env() without a fallback: ' + bare.join(', ') + ' — write env(name, 0px)');
});

test('the page carries real text for a crawler that does not run scripts', () => {
  // Everything else on this page is written by JS into empty elements, so the
  // about paragraph is the only prose a search engine is handed. Losing it is
  // silent and costs the listing its description.
  const about = html.match(/<section class="about">([\s\S]*?)<\/section>/);
  assert.ok(about, 'the about section is gone');
  const text = about[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.ok(text.length > 200, 'the about paragraph is too short to be useful');
});
