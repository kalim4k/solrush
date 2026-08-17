// Does the appearance picker actually appear, and does a skin reach the board?
//
//   node scripts/cosmetics-check.mjs [url]
//
// The unit tests can prove resolveSkin() gates a paid skin correctly and still
// tell you nothing about whether the player can see a single swatch. This one
// opens the profile screen, counts what is drawn, clicks a free skin, and reads
// the pawn's class back off the board — which is the only claim that matters:
// that the thing the player bought shows up on the piece.
//
// It also watches the console. A module that fails to import leaves the page
// looking almost right, because everything above the failed import already ran.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const URL_ = process.argv[2] || 'http://localhost:3210/';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('no Chrome or Edge found'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

let failed = false;
const step = (ok, text) => { if (!ok) failed = true; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); };

const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'cos-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const kill = () => (process.platform === 'win32'
  ? spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  : chrome.kill());

try {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || null;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('DevTools never answered');

  const sock = new WebSocket(wsUrl, { maxPayload: 32 * 1024 * 1024 });
  let id = 0; const pending = new Map(); const errors = [];
  sock.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });
  await new Promise((r) => sock.on('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); sock.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const ev = async (e) =>
    (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    if (await ev(`document.querySelectorAll('#skin-grid .cos-swatch').length > 0`)) break;
    await sleep(250);
  }

  /* The cheap sentinel for an expensive bug, and it needs no login.

     hello_ok used to answer a GUEST with the default skin and badge, and the
     client wrote whatever came back into localStorage so that a second device
     would inherit what an account owns. But the first hello of every session
     is a guest one, fired before the login form is even filled in — so the
     browser learned that "classic/none" was a deliberate choice, sent it as
     one on the next hello, and overwrote the gold pawn the account had paid
     for. The account lost its cosmetics by the simple act of opening the game.

     A guest has nothing to inherit, so nothing should be stored for one. */
  step(await ev(`localStorage.getItem('wr_skin') === null && localStorage.getItem('wr_badge') === null`),
    'a guest hello stores no choice on the browser');

  const skins = await ev(`document.querySelectorAll('#skin-grid .cos-swatch').length`);
  const badges = await ev(`document.querySelectorAll('#badge-grid .cos-swatch').length`);
  step(skins === 9, `nine pawn skins drawn (saw ${skins})`);
  step(badges === 6, `six badges drawn (saw ${badges})`);

  // Nobody is Plus yet, so exactly the free ones stay selectable — and the paid
  // ones must still be VISIBLE, because a skin you cannot see is one you will
  // never buy. Dimmed, not removed.
  const locked = await ev(`document.querySelectorAll('#skin-grid .cos-swatch.locked').length`);
  step(locked === 6, `six skins locked for a player without Plus (saw ${locked})`);

  const grad = await ev(
    `getComputedStyle(document.querySelectorAll('#skin-grid .cos-swatch')[1]).backgroundImage`);
  step(String(grad).includes('gradient'), 'a free skin swatch is actually painted');

  // Click "moss" — free, third in the catalogue — then read the pawn back.
  await ev(`document.querySelectorAll('#skin-grid .cos-swatch')[2].click()`);
  await sleep(400);
  step(await ev(`localStorage.getItem('wr_skin') === 'moss'`), 'choosing a skin stores it');
  step(await ev(`document.querySelectorAll('#skin-grid .cos-swatch.on').length === 1`),
    'exactly one swatch is marked as chosen');

  // A locked skin must refuse, and leave the choice alone.
  await ev(`document.querySelector('#skin-grid .cos-swatch.locked').click()`);
  await sleep(300);
  step(await ev(`localStorage.getItem('wr_skin') === 'moss'`),
    'clicking a locked skin changes nothing');

  // And the board has to agree. An AI game is enough: it renders the same pawns.
  await ev(`document.getElementById('btn-ai')?.click()`);
  await sleep(500);
  await ev(`document.getElementById('ai-easy')?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`document.querySelectorAll('.pawn').length >= 2`)) break;
    await sleep(250);
  }
  const painted = await ev(`[...document.querySelectorAll('.pawn')].map(p => p.className).join(' | ')`);
  step(String(painted).includes('skin-moss'), `the pawn on the board wears it (${painted})`);

  step(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''}`);
} catch (e) {
  console.error('cosmetics check failed:', e.message);
  failed = true;
} finally {
  kill();
}

console.log('');
console.log(failed ? 'FAIL — the appearance picker is not working.'
  : 'PASS — skins and badges are drawn, gated, and reach the board.');
process.exitCode = failed ? 1 : 0;
