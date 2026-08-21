// Does the admin panel open, refuse the wrong people, and actually show the
// money?
//
//   ADMIN_EMAILS=probe-admin@example.test npm start        (in one terminal)
//   node scripts/admin-check.mjs [url]                     (in another)
//
// The panel is the one page in this project with nothing above it: no player
// ever opens it, so nothing complains when it breaks. It is also the page most
// worth breaking into — player emails, payment rows, and a button that grants a
// paid product. So this checks both halves: that an ordinary account is refused
// by every route, and that a real admin session renders real figures rather
// than a grid of "NaN" and "undefined", which is what a renamed column looks
// like from here.
//
// It drives a browser rather than reading JSON, because every bug this page has
// had was in the rendering: a number the server sent correctly and the page
// divided by zero, a table that scrolled off a phone, a chart with no bars.
//
// Two throwaway accounts are created and deleted again at the end, including
// when the run fails: a probe account left behind on a public deployment is an
// account with a known password, and one of them is in ADMIN_EMAILS.
import './../server/boot-env.js';
import { q, close } from '../server/db.js';
import { register, login } from '../server/auth.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const URL_ = (process.argv[2] || 'http://localhost:3210').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_PROBE_EMAIL || 'probe-admin@example.test';
const PLAIN = 'probe-plain@example.test';
const PASS = 'Probe-Passw0rd!';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].find(existsSync);
if (!CHROME) { console.error('no Chrome found'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const step = (ok, t) => { if (!ok) failed = true; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${t}`); };

const call = (path, body, token) => fetch(URL_ + path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  },
  body: JSON.stringify(body || {}),
});

/* Made in the database rather than through /api/register, which allows five
   registrations an hour per address and this run needs two. Going through the
   HTTP route meant the check could be run twice and then refused to run again
   until the server was restarted — a check nobody can re-run is a check nobody
   uses. Nothing about the gate is skipped by this: the token is minted the
   ordinary way and every assertion below still goes over HTTP. */
async function account(email) {
  const made = await register(email, PASS, 'Probe ' + email.split('@')[0].slice(-5));
  if (made.token) return made.token;
  const back = await login(email, PASS);
  if (back.token) return back.token;
  throw new Error(`cannot get a session for ${email}: ${made.error} / ${back.error}`);
}

/* Every admin route, listed by hand on purpose.

   The mistake that matters here is not a broken check — it is a NEW route
   added later without one. test/dom.test.mjs walks the server file and insists
   each `case '/api/admin/…'` calls isAdmin; this walks the same list from the
   outside and insists the server actually says no. */
const ROUTES = [
  '/api/admin/overview', '/api/admin/live', '/api/admin/payments',
  '/api/admin/matches', '/api/admin/players', '/api/admin/plus', '/api/admin/cart',
];

const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const ch = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'admin-'))}`,
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || null;
  } catch { /* not up */ }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('DevTools never answered'); process.exit(1); }

const sock = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
let id = 0; const pending = new Map();
const blew = [];
sock.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  // A rendering error here does not clear the page — it stops halfway and
  // leaves something that photographs almost right. Collect them.
  else if (m.method === 'Runtime.exceptionThrown') {
    blew.push(m.params.exceptionDetails?.exception?.description
      || m.params.exceptionDetails?.text || 'unknown');
  }
  // console.error is where this app reports a failure it survived — boot()
  // catches afterLogin's exceptions and logs them rather than stopping.
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    blew.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
await new Promise((r) => sock.on('open', r));
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id; pending.set(n, res); sock.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

try {
  const adminToken = await account(ADMIN);
  const plainToken = await account(PLAIN);

  /* ---------- the gate ---------- */
  const asAdmin = await call('/api/admin/overview', {}, adminToken);
  if (asAdmin.status === 403) {
    console.error(`\n${ADMIN} is not an admin on the server under test.`);
    console.error(`Start it with ADMIN_EMAILS=${ADMIN} and run this again.`);
    process.exit(1);
  }
  step(asAdmin.ok, 'the admin account is let in');

  let refused = 0;
  for (const r of ROUTES) if ((await call(r, {}, plainToken)).status === 403) refused++;
  step(refused === ROUTES.length,
    `an ordinary account is refused by ${refused}/${ROUTES.length} admin routes`);

  let anon = 0;
  for (const r of ROUTES) if ((await call(r, {})).status === 403) anon++;
  step(anon === ROUTES.length, `a caller with no token is refused by ${anon}/${ROUTES.length}`);

  /* ---------- the page ---------- */
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // localStorage is per-origin, so the session has to be planted from a page on
  // that origin before the panel is opened.
  const plant = (tok) =>
    ev(`localStorage.setItem('wr_session', ${JSON.stringify(JSON.stringify({ access_token: tok }))})`);

  /* Waits for the profile to have ARRIVED, not merely for the page to be up.

     Two false signals were tried first and both are worth naming. The online
     counter reads "0" before the socket has said anything, so "it is no longer
     empty" is true at t=0 and waits for nothing. The appearance grid fills on
     the socket's hello, which lands before /api/profile answers — so the admin
     link was still hidden when it was measured, and this check reported a
     working feature as broken. Worse, the OPPOSITE assertion — an ordinary
     account not seeing the link — passed for the same wrong reason, and would
     have gone on passing if the link were shown to everybody.

     #logged-box is unhidden only when a session AND a profile both exist,
     which is exactly the state being tested. */
  async function openProfile() {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      ready = await ev(`document.getElementById('logged-box')?.hidden === false`);
      if (!ready) await sleep(250);
    }
    if (!ready) {
      console.log('  page said: ' + await ev(`JSON.stringify({
        url: location.href,
        logged: document.getElementById('logged-box')?.hidden,
        authBox: document.getElementById('auth-buttons')?.hidden,
        skins: document.getElementById('skin-grid')?.children.length,
        raw: (localStorage.getItem('wr_session') || 'none').slice(0, 30),
        formOpen: document.getElementById('auth-form')?.hidden,
        nick: document.getElementById('profile-nick')?.textContent,
      })`));
      console.log('  page logged: ' + (blew.join(' | ') || 'nothing'));
      console.log('  /api/profile said: ' + await ev(`fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   Authorization: 'Bearer ' + JSON.parse(localStorage.wr_session).access_token },
        body: '{}',
      }).then(async r => r.status + ' ' + (await r.text()).slice(0, 300)).catch(e => 'threw ' + e.message)`));
      throw new Error('the game never finished logging the probe account in');
    }
    await ev(`document.querySelector('.nav-btn[data-screen="screen-profile"]')?.click()`);
    await sleep(400);
  }

  /* ---------- the way in, from the game ---------- */
  /* The panel used to be reachable only by typing its address, which is fine
     on the machine that built it and useless on the phone where a stuck
     payment is actually noticed. The link is only shown when the server says
     this account may use it — so it has to be checked BOTH ways round, and the
     one that matters is the ordinary account not seeing it. */
  await send('Page.navigate', { url: URL_ + '/' });
  await sleep(1200);
  await plant(plainToken);
  await send('Page.navigate', { url: URL_ + '/' });
  await openProfile();
  /* Computed display, not the hidden property. They came apart: the anchor is
     styled `display: block` to look like the button beside it, and an author
     declaration beats the browser's own [hidden] rule no matter how specific
     it is — so the element reported hidden === true and was on screen the whole
     time. Asking what the page actually draws is the only question worth
     asking here. */
  const plainSees = await ev(`(() => {
    const a = document.getElementById('btn-admin');
    return JSON.stringify({ hidden: a?.hidden, display: a ? getComputedStyle(a).display : null });
  })()`);
  step(JSON.parse(plainSees).display === 'none',
    `an ordinary account is not shown the way into the panel (${plainSees})`);

  /* ---------- where "temps par joueur" comes from ---------- */
  /* The panel reports how long people stay, and the only source for that is a
     beacon the browser sends as the page goes away. If it stops firing the
     tile does not break — it quietly reads "—" forever and nobody finds out.
     So: sit on the page long enough to be worth counting, leave, and look for
     the row in the database.

     The device id is read from the page rather than invented, because the
     beacon sends whatever the game itself stored. */
  const device = await ev(`localStorage.getItem('wr_device')`);
  await sleep(6500);                       // the beacon ignores anything under 5s
  await send('Page.navigate', { url: URL_ + '/rules/' });   // fires pagehide
  await sleep(1200);
  const beacon = device
    ? await q(`SELECT (meta->>'s')::int AS s FROM events
                WHERE name = 'session' AND device = $1 ORDER BY at DESC LIMIT 1`, [device])
    : { rows: [] };
  step(beacon.rows.length > 0 && beacon.rows[0].s >= 5,
    `the browser reports how long it stayed: ${beacon.rows[0]?.s ?? 'nothing recorded'} s`);
  if (device) await q(`DELETE FROM events WHERE device = $1`, [device]);

  await plant(adminToken);
  await send('Page.navigate', { url: URL_ + '/' });
  await openProfile();
  const link = await ev(`(() => {
    const a = document.getElementById('btn-admin');
    if (!a || getComputedStyle(a).display === 'none') return null;
    const r = a.getBoundingClientRect();
    return { href: a.getAttribute('href'), text: a.textContent.trim(), w: Math.round(r.width) };
  })()`);
  step(!!link, 'the admin account is shown a link to the panel on its profile');
  step(link?.href === '/admin/', `and it points at the panel: ${link?.href}`);
  step((link?.text || '').length > 2 && link?.w > 100,
    `with a translated label on a full-width button: "${link?.text}" (${link?.w}px)`);
  await send('Page.navigate', { url: URL_ + '/admin/' });

  /* Waits for a view to have finished drawing. "The document loaded" is true
     long before the fetch it makes has answered, and every figure read in
     between comes back undefined.

     Waiting on tiles was the first attempt and it was wrong: the players view
     has none, so this reported a perfectly good page as never rendering. The
     honest signal is that the placeholder is gone and something is in its
     place, whatever that something is. */
  async function drawn(what) {
    for (let i = 0; i < 80; i++) {
      const ready = await ev(`!document.querySelector('#view .skel')
        && document.querySelectorAll('#view .card, #view .tile').length > 0`);
      if (ready) { await sleep(120); return true; }
      await sleep(250);
    }
    console.log('  view said: ' + await ev(`document.getElementById('view')?.textContent?.trim().slice(0,200)`));
    throw new Error(`${what} never rendered`);
  }

  await drawn('the overview');
  step(true, 'the panel renders for an admin session');

  const navCount = await ev(`document.querySelectorAll('#nav [data-view]').length`);
  step(navCount === 6, `the sidebar lists ${navCount} sections`);

  /* Every number on the page, as text. This is the assertion that matters:
     a renamed or missing column does not throw, it prints "undefined" or
     "NaN" in a nice big font and looks like a design. */
  async function figures(where) {
    const raw = await ev(`JSON.stringify([...document.querySelectorAll(
        '#view .tile b, #view .big, #view .hero-side b')].map(e => e.textContent.trim()))`);
    const all = JSON.parse(raw);
    const bad = all.filter((s) => /undefined|NaN|null/i.test(s) || s === '');
    /* Not every view has headline figures — the players list is a table and
       nothing else — so an empty set is fine here. What is never fine is a
       figure that renders as "undefined": it does not throw, it prints in a
       nice big font and looks like a design decision. */
    const body = await ev(`document.getElementById('view').textContent`);
    const inText = /undefined|NaN/.test(body);
    step(bad.length === 0 && !inText,
      `${where}: ${all.length} figure${all.length === 1 ? '' : 's'}, none broken`
      + (bad.length ? ` — ${bad.join(', ')}` : '')
      + (inText ? ' — but "undefined" appears in the page text' : ''));
    return all;
  }

  await figures('overview');

  // Revenue is the reason this page exists. It must be a figure, not a blank.
  const revenue = await ev(`document.querySelector('#view .big')?.textContent.replace(/\\s+/g,' ').trim()`);
  step(/[0-9]/.test(revenue || ''), `revenue is shown: "${revenue}"`);

  /* ---------- the range filter ---------- */
  /* The whole point of this rebuild: the figures must actually follow the
     window. A control that changes nothing but its own highlight is worse than
     no control, because it is believed. */
  const presets = await ev(`document.querySelectorAll('#preset [data-preset]').length`);
  step(presets === 6, `${presets} range presets, including a custom one`);

  /* Reads the heading AND the window the drawn data actually came from.

     Counting columns alone was not enough, and the reason is worth keeping:
     the heading is written from the range now selected, while the bars come
     from whatever the server last answered. When a slow request landed after a
     fast one those two disagreed — a 90-day heading over 30 days of bars — and
     each half looked entirely reasonable on its own. The chart now carries the
     range of its own data, so the two can be compared. */
  const readRange = () => ev(`(() => {
    const card = document.getElementById('chart-card');
    return JSON.stringify({
      cap: document.querySelector('#view .cap')?.textContent.trim(),
      cols: document.querySelectorAll('#chart-sec .col').length,
      from: card?.dataset.from || '', to: card?.dataset.to || '',
      step: Number(card?.dataset.step || 0),
    });
  })()`);

  // What the browser would have asked for, so the answer can be held to it.
  const wanted = (days) => ev(`(() => {
    const end = new Date(); end.setHours(0,0,0,0); end.setDate(end.getDate() + 1);
    const start = new Date(end); start.setDate(start.getDate() - ${days});
    return start.toISOString() + '|' + end.toISOString();
  })()`);

  async function rangeIs(preset, days, expectCols) {
    await ev(`document.querySelector('#preset [data-preset="${preset}"]').click()`);
    await drawn(`the ${preset} view`);
    const got = JSON.parse(await readRange());
    const want = (await wanted(days)).split('|');
    step(got.from === want[0] && got.to === want[1],
      `${preset}: the drawn data covers the window asked for (${got.from.slice(0, 10)} → ${got.to.slice(0, 10)})`);
    step(got.cols === expectCols, `${preset}: ${got.cols} columns, step ${got.step}`);
    return got;
  }

  const seven = await rangeIs('7', 7, 7);
  const ninety = await rangeIs('90', 90, 90);
  step(seven.cap !== ninety.cap,
    `and the heading follows the window: "${seven.cap}" then "${ninety.cap}"`);

  // A year is bucketed into weeks rather than 365 hair-thin bars.
  const year = await rangeIs('365', 365, 53);
  step(!/^\d+ [a-zû.]+ → \d+ [a-zû.]+$/i.test(year.cap || ''),
    `a range crossing a year says which year: "${year.cap}"`);

  /* A custom period, chosen by date. Three days is deliberately narrow: it
     proves the dates are being used rather than rounded to a preset. */
  await ev(`document.querySelector('#preset [data-preset="custom"]').click()`);
  await sleep(400);
  const picked = await ev(`(() => {
    const end = new Date(); end.setHours(12,0,0,0);
    const start = new Date(end); start.setDate(start.getDate() - 2);
    const iso = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')
                   + '-' + String(d.getDate()).padStart(2,'0');
    const f = document.getElementById('d-from'), t = document.getElementById('d-to');
    if (!f || !t) return null;
    f.value = iso(start); t.value = iso(end);
    document.getElementById('d-go').click();
    return iso(start) + ' → ' + iso(end);
  })()`);
  step(Boolean(picked), 'the custom period exposes two date fields and an apply button');
  await drawn('the custom period');
  const custom = JSON.parse(await readRange());
  step(custom.cols === 3, `a three-day period draws ${custom.cols} columns (${picked})`);

  await rangeIs('30', 30, 30);

  // The chart is redrawn in place, so its buttons have to survive the redraw.
  await ev(`document.querySelector('#seg [data-metric="revenue"]').click()`);
  await sleep(500);
  step(await ev(`document.querySelector('#seg [data-metric="revenue"]')?.getAttribute('aria-pressed') === 'true'
       && document.querySelectorAll('#chart-sec .col').length === 30`),
    'switching the chart to revenue redraws it and keeps its buttons working');

  /* ---------- every section opens ---------- */
  for (const view of ['revenue', 'players', 'matches', 'time', 'live']) {
    await ev(`document.querySelector('#nav [data-view="${view}"]').click()`);
    await drawn(view);
    await figures(view);
    const title = await ev(`document.getElementById('title').textContent`);
    step(await ev(`document.querySelector('#nav [data-view="${view}"]')
         ?.getAttribute('aria-current') === 'page'`),
      `${view} opens and is marked current ("${title}")`);
  }

  // The payments filter is the one control that queries with a WHERE clause
  // built from a button.
  await ev(`document.querySelector('#nav [data-view="revenue"]').click()`);
  await drawn('revenue');
  const filtered = await ev(`(async () => {
    const b = document.querySelector('#pay-filter [data-status="completed"]');
    if (!b) return 'no filter';
    b.click();
    await new Promise(r => setTimeout(r, 900));
    return [...document.querySelectorAll('#pay-box .pill')].map(p => p.textContent.trim()).join(',');
  })()`);
  step(!String(filtered).includes('abandonné') && !String(filtered).includes('en attente'),
    `filtering payments to "payés" leaves only those: ${filtered || 'no rows'}`);

  await ev(`document.querySelector('#nav [data-view="overview"]').click()`);
  await drawn('overview');

  /* ---------- fits a phone ---------- */
  const mobile = JSON.parse(await ev(`JSON.stringify({
    inner: innerWidth,
    scroll: document.documentElement.scrollWidth,
    sideOff: document.getElementById('side').getBoundingClientRect().right <= 1,
    burger: getComputedStyle(document.getElementById('burger')).display !== 'none',
  })`));
  step(mobile.scroll <= mobile.inner + 1,
    `no sideways scroll at ${mobile.inner}px (content ${mobile.scroll}px)`);
  step(mobile.sideOff && mobile.burger,
    'the sidebar is off-screen on a phone and a menu button is offered instead');

  // The drawer has to actually come in, and go away again.
  await ev(`document.getElementById('burger').click()`);
  await sleep(400);
  step(await ev(`document.getElementById('side').getBoundingClientRect().left >= -1`),
    'tapping the menu brings the sidebar in');
  const shotDrawer = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(process.env.ADMIN_SHOT_NAV || 'admin-390-nav.png', Buffer.from(shotDrawer.data, 'base64'));
  await ev(`document.getElementById('scrim').click()`);
  await sleep(400);
  step(await ev(`document.getElementById('side').getBoundingClientRect().right <= 1`),
    'and tapping outside puts it away');

  /* Two pictures of the phone, because one of them is always the wrong one.
     The full page is legible only shrunk to a thumbnail, where a broken line
     wrap disappears; the first screen alone hides everything below it. */
  const shotM = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(process.env.ADMIN_SHOT_M || 'admin-390.png', Buffer.from(shotM.data, 'base64'));
  const shotF = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(process.env.ADMIN_SHOT_F || 'admin-390-full.png', Buffer.from(shotF.data, 'base64'));

  /* ---------- and a desktop ---------- */
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const desk = JSON.parse(await ev(`JSON.stringify({
    inner: innerWidth,
    scroll: document.documentElement.scrollWidth,
    sideVisible: document.getElementById('side').getBoundingClientRect().width > 100,
    thead: getComputedStyle(document.querySelector('#view thead') || document.body).display,
  })`));
  step(desk.scroll <= desk.inner + 1, `no sideways scroll at ${desk.inner}px`);
  step(desk.sideVisible, 'the sidebar is permanently open on a wide screen');

  const shotD = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(process.env.ADMIN_SHOT_D || 'admin-1280.png', Buffer.from(shotD.data, 'base64'));

  // A table page, at desktop width, to prove the headers come back.
  await ev(`document.querySelector('#nav [data-view="matches"]').click()`);
  await drawn('matches');
  step(await ev(`getComputedStyle(document.querySelector('#view thead')).display !== 'none'`),
    'and table headers come back on a wide screen');
  const shotT = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(process.env.ADMIN_SHOT_T || 'admin-1280-matches.png', Buffer.from(shotT.data, 'base64'));

  step(blew.length === 0, blew.length ? `page threw: ${blew.join(' | ')}` : 'nothing threw while rendering');
} catch (e) {
  console.error('admin check failed:', e.message);
  failed = true;
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
  else ch.kill();

  // In the finally block on purpose. A failed run is exactly the run that
  // would otherwise leave an admin account with a published password behind.
  try {
    const gone = await q('DELETE FROM users WHERE email = ANY($1)', [[ADMIN, PLAIN]]);
    console.log(`\n  cleaned up ${gone.rowCount} probe account(s)`);
  } catch (e) {
    console.error(`\n  ! could not delete the probe accounts: ${e.message}`);
    console.error(`  ! delete ${ADMIN} and ${PLAIN} by hand before this is deployed.`);
    failed = true;
  }
  await close().catch(() => { });
}

console.log(failed
  ? '\nFAIL — the admin panel is not showing what it claims to.'
  : '\nPASS — refused to everyone else, and every figure on it is a figure.');
process.exitCode = failed ? 1 : 0;
