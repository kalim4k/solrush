// Do games played, wins, losses and points actually reach the profile screen?
//
//   node scripts/stats-check.mjs [url]
//
// Reported as "the counters stay at zero", and both halves of that turned out
// to be worth checking separately, because the server was right the whole time.
//
// The account row was being updated correctly on every ranked game. What was
// missing was any path from there back to the screen: `profile` was fetched
// once, at login, and never read again, so a player could win all evening and
// still see zeroes until a page reload.
//
// The obvious repair — re-fetch the profile when game_over arrives — is wrong in
// a way no unit test would catch. game_over is sent before the database write
// that follows it, so the fetch reliably reads the old row and stores it. The
// server has to push the totals once they exist.
//
// So this plays a real ranked game between two browsers and reads the numbers
// off the profile screen without reloading it. Anything less than end to end
// would have passed against the broken version.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const URL_ = process.argv[2] || 'http://localhost:3210/';
const EMAIL = process.env.STATS_EMAIL;
const PASSWORD = process.env.STATS_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('set STATS_EMAIL and STATS_PASSWORD to an account this may play with.');
  console.error('it will finish one ranked game as that account, so its record moves by one.');
  process.exit(1);
}

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('no Chrome or Edge found'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const step = (ok, text) => { if (!ok) failed = true; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); };

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function launch(name) {
  const port = await freePort();
  const ch = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-extensions',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), name + '-'))}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || null;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error(`${name}: DevTools never answered`);

  const sock = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  sock.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => sock.on('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); sock.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable');
  const ev = async (e) =>
    (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
  return { name, ch, send, ev };
}

const kill = (p) => (process.platform === 'win32'
  ? spawnSync('taskkill', ['/pid', String(p.ch.pid), '/T', '/F'], { stdio: 'ignore' })
  : p.ch.kill());

// Read the three counters off the profile screen exactly as a player would.
const readStats = (p) => p.ev(`(() => {
  const n = (id) => Number(document.getElementById(id).textContent) || 0;
  return { games: n('stat-games'), wins: n('stat-wins'), losses: n('stat-losses') };
})()`);

const pages = [];
try {
  const A = await launch('A');
  const B = await launch('B');
  pages.push(A, B);

  for (const p of pages) {
    await p.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 80; i++) {
      if (await p.ev(`document.getElementById('online-count')?.textContent.trim() !== ''`)) break;
      await sleep(250);
    }
  }

  // A plays as the account; B stays a guest, which is enough to make a match.
  await A.ev(`document.querySelector('[data-screen="screen-profile"]').click()`);
  await sleep(500);
  await A.ev(`document.getElementById('btn-show-login').click()`);
  await sleep(400);
  await A.ev(`(() => { const e = document.getElementById('auth-email'), p = document.getElementById('auth-password');
    e.value = ${JSON.stringify(EMAIL)}; e.dispatchEvent(new Event('input', {bubbles:true}));
    p.value = ${JSON.stringify(PASSWORD)}; p.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await A.ev(`document.getElementById('btn-auth-submit').click()`);

  /* Wait for the logged-in state instead of sleeping at it.
     updateProfileUI() reveals #logged-box only once the profile has come back,
     which is also the moment the counters below stop being placeholder zeroes.
     Snapshotting before that produced a "before" of 0 against an account that
     had a game on it, and the check then measured the wrong difference. */
  let logged = false;
  for (let i = 0; i < 50; i++) {
    if (await A.ev(`document.getElementById('logged-box')?.hidden === false`)) { logged = true; break; }
    await sleep(300);
  }
  await sleep(600);          // let the counters paint

  const before = await readStats(A);
  step(logged, `logged in (record before: ${before.games} games, ${before.wins}W ${before.losses}L)`);

  await A.ev(`document.querySelector('[data-screen="screen-home"]').click()`);
  await sleep(400);
  await A.ev(`document.getElementById('btn-quick').click()`);
  await sleep(1200);
  await B.ev(`document.getElementById('btn-quick').click()`);

  let paired = true;
  for (const p of pages) {
    let ok = false;
    for (let i = 0; i < 60; i++) {
      if (await p.ev(`document.querySelectorAll('#board [data-vr]').length > 0`)) { ok = true; break; }
      await sleep(300);
    }
    if (!ok) paired = false;
  }
  step(paired, 'quick match started a ranked game');

  /* Resigning rather than playing it out. A finished game is a finished game as
     far as the counters are concerned, and sixteen scripted moves would make
     this check slow and fragile for no extra coverage. */
  await A.ev(`document.getElementById('btn-resign').click()`);
  await sleep(400);
  await A.ev(`document.getElementById('btn-resign-yes').click()`);
  await sleep(3500);

  // Straight to the profile, with NO reload — a reload would refetch and hide
  // the very bug this exists for.
  await A.ev(`document.getElementById('btn-back-menu')?.click();
              document.querySelector('[data-screen="screen-profile"]')?.click()`);
  await sleep(1500);

  const after = await readStats(A);
  step(after.games === before.games + 1,
    `games played went ${before.games} → ${after.games}`);
  step(after.losses === before.losses + 1,
    `losses went ${before.losses} → ${after.losses}`);
} catch (e) {
  console.error('stats check failed:', e.message);
  failed = true;
} finally {
  for (const p of pages) kill(p);
}

console.log('');
console.log(failed ? 'FAIL — a finished ranked game does not reach the profile.'
  : 'PASS — a ranked game updates the record on screen, with no reload.');
process.exitCode = failed ? 1 : 0;
