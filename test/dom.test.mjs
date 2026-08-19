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

/* Machine translation is refused, and it has to stay refused.

   This app already speaks six languages and switches document.documentElement
   .lang to whichever one is showing. A browser translating on top of that
   rewrites correct wording as a guess at correct wording, live, in an
   interface where labels change width mid-game and other players' nicknames
   get "translated".

   The symptom only appears for someone whose browser language differs from
   the page's, so nothing but this test stands between the next edit to <head>
   and a silently mangled UI for exactly the players it was written for. */
test('the page opts out of automatic browser translation', () => {
  const openTag = html.match(/<html\b[^>]*>/)[0];
  assert.match(openTag, /\btranslate="no"/, '<html> is missing translate="no"');
  assert.match(openTag, /\bclass="[^"]*\bnotranslate\b/, '<html> is missing class="notranslate"');
  assert.match(html, /<meta\s+name="google"\s+content="notranslate">/,
    'the <meta name="google" content="notranslate"> hint is gone');
});

test('the language shown is the language the document declares', () => {
  // Chrome offers to translate when it thinks the page is in a language other
  // than the reader's. Leaving lang="en" pinned while the UI renders in French
  // is what makes that offer appear in the first place, so the opt-out above
  // is the belt and this is the braces.
  assert.match(app, /document\.documentElement\.lang\s*=\s*lang/,
    'app.js no longer keeps <html lang> in step with the chosen language');
});

/* The badge sits beside the nickname by layout, not by a nudge.

   It was an inline span with vertical-align: -.05em, which aligns it to the
   text BASELINE — the wrong reference for an emoji, whose visual middle sits
   well above its baseline. The badge hung low next to the name, and worse the
   bolder and larger the name got, so it looked wrong on the profile heading
   and in the player pills at once. Nudging the number only moves which font
   size is wrong.

   Two boxes centred against each other need no number and hold at every size.
   This pins the shape that makes that possible: a nickname element of its own,
   so a flex row has something to align and something to truncate. */
test('the badge is centred by layout rather than by a magic offset', () => {
  const css = readFileSync(join(ROOT, 'public/css/style.css'), 'utf8');

  assert.match(app, /className = 'nick-text'/,
    'setNickWithBadge no longer gives the nickname its own element');
  assert.match(app, /classList\.add\('nick-line'\)/,
    'the nickname line is no longer marked for the layout rule');

  const rule = css.match(/\.nick-line\s*\{[^}]*\}/);
  assert.ok(rule, '.nick-line is missing from the stylesheet');
  assert.match(rule[0], /align-items:\s*center/, '.nick-line no longer centres its children');

  const badge = css.match(/^\.badge\s*\{[^}]*\}/m);
  assert.ok(badge, '.badge is missing from the stylesheet');
  assert.doesNotMatch(badge[0], /vertical-align/,
    '.badge is back to aligning itself against the text baseline');
});

/* AdSense refused solrush.site on 2026-08-19: "Google-served ads on screens
   without publisher content". The loader was in the head of the app shell — a
   page that, with the tags stripped, holds one paragraph of prose and a
   hundred-odd words of button labels, followed by a game board. The policy
   names that case directly ("screens that serve navigation or other
   behavioural purposes"), and leaving the tag there also lets Auto Ads place
   units inside the interface, mid-game.

   The tag belongs on documents, not on the app. This keeps it off. */
test('the game shell does not ask for ads', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.doesNotMatch(html, /adsbygoogle|pagead2\.googlesyndication/,
    'no ad loader on a screen whose content is a menu and a board');
});

/* SolRush Plus had no offer. The game gated five kinds of cosmetic behind it,
   said "SolRush Plus only" when one was tapped, and then led nowhere: no page
   describing it, no price, no way to buy. A player reads that as broken, and
   it refuses a sale the game itself just proposed.

   These pin the parts a screenshot cannot: that the offer exists in the
   markup, and that the price is defined once rather than copied into six
   language packs where the copies can drift apart. */
test('the Plus offer exists and can be bought from', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /id="overlay-plus"/, 'there must be an offer to open');
  assert.match(html, /id="plus-buy"/, 'and a way to act on it');
  assert.match(html, /id="btn-plus"/, 'reachable without tapping a locked item first');
});

test('the price is written down exactly once', () => {
  const app = readFileSync(join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(app, /const PLUS_PRICE = /, 'the price lives in one constant');

  for (const code of ['en', 'fr', 'es', 'ru', 'tr', 'fa']) {
    const pack = readFileSync(join(ROOT, `public/lang/${code}.js`), 'utf8');
    assert.doesNotMatch(pack, /FCFA|€|\$\d/,
      `${code}.js carries a price; six copies of a number is six chances to disagree`);
  }
});

/* Maketou has no webhooks. Nothing will ever call this server to say a payment
   landed, so the only sources of truth are the redirect back from checkout —
   which is lost whenever somebody closes the tab or switches to their
   mobile-money app and does not return — and asking Maketou about the cart.

   These pin the two properties that keep a lost redirect from becoming money
   taken for nothing, and keep a browser from being able to claim it paid. */
test('a payment is confirmed by asking, not by being told', () => {
  const server = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
  const route = server.slice(server.indexOf("case '/api/plus/status'"));
  const body = route.slice(0, route.indexOf("case '/api/replay'"));

  assert.match(body, /getCart\(/,
    'the status route must ask the processor rather than trust the caller');
  assert.doesNotMatch(body, /body\.(plus|paid|status)/,
    'nothing the browser sends may decide whether somebody has paid');
  assert.match(body, /cart\.status === PAID/,
    'only the one completed status grants Plus');
});

test('an unfinished payment is re-checked when the player comes back', () => {
  const app = readFileSync(join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(app, /checkPlus\(\);/,
    'the app must re-ask on its own, not only on return from checkout');
  const server = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
  assert.match(server, /status = 'waiting_payment'/,
    'open carts have to be findable afterwards, which is what the table is for');
});

test('the payment keys are not in the repository', () => {
  for (const f of ['server/maketou.js', 'render.yaml', '.env.example']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // [ \t]* rather than \s*, which crosses the newline and matches the NEXT
    // variable's name — .env.example failed this on its own blank placeholder.
    assert.doesNotMatch(src, /MAKETOU_API_KEY[ \t]*[:=][ \t]*["']?[A-Za-z0-9_-]{12,}/,
      `${f} looks like it carries a real key`);
  }
});
