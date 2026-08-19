// Does the game screen fit, without scrolling, on the phones this is played on?
//
//   node scripts/fit-check.mjs [url]
//
// A player mid-move cannot be asked to scroll to find the wall dock or the
// emoji they want, and for a long time they were: the board claimed a fixed
// 55dvh regardless of the header, the player pills, the dock, the hint and the
// bottom bar sharing the screen with it — about 250px of fixed chrome. Anything
// shorter than roughly 740px overflowed, and a friend room, which adds the
// voice row, overflowed well above that.
//
// Nothing but a real browser at a real viewport can answer this. The failure is
// invisible on a desktop, invisible to a unit test, and invisible on whichever
// single phone a developer happens to own.
//
// Race mode needs two browsers, and it is the case worth the trouble: a 9x13
// board is limited by HEIGHT where the duel board is limited by width, and its
// finish band is absolutely positioned — which the first version of the
// measurement subtracted from the budget as though it took up room, driving the
// figure negative and falling back to the very rule it was replacing.

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

// The small end of what this game is actually played on, plus one landscape.
const DEVICES = [
  ['iPhone SE', 320, 568],
  ['Galaxy A-class', 360, 640],
  ['common Android', 360, 740],
  ['iPhone 12/13', 390, 844],
  ['Pixel 7', 412, 915],
  ['landscape', 740, 360],
];

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
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fit-' + name + '-'))}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
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
  const ev = async (e) =>
    (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  return { name, ch, send, ev };
}

const kill = (p) => (process.platform === 'win32'
  ? spawnSync('taskkill', ['/pid', String(p.ch.pid), '/T', '/F'], { stdio: 'ignore' })
  : p.ch.kill());

/* Two numbers and a sanity check. `over` is the game screen's own overflow;
   `doc` catches the case where the screen fits but the document around it still
   scrolls. `cells` guards against the most embarrassing pass available —
   reporting "fits" for a screen with no game on it, which an earlier run of
   this did for three devices in a row. */
const REPORT = `(() => {
  const s = document.getElementById('screen-game');
  const b = document.getElementById('board').getBoundingClientRect();
  return {
    over: Math.round(s.scrollHeight - window.innerHeight),
    doc: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    board: Math.round(b.width) + 'x' + Math.round(b.height),
    cells: document.querySelectorAll('#board .cell').length,
  };
})()`;

async function sweep(page, label, devices = DEVICES) {
  for (const [name, width, height] of devices) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    const r = await page.ev(REPORT);
    const ok = r.cells > 0 && r.over <= 0 && r.doc <= 0;
    const why = r.cells === 0 ? 'NO BOARD ON SCREEN'
      : r.over > 0 ? `overflows by ${r.over}px`
        : r.doc > 0 ? `page scrolls by ${r.doc}px`
          : `board ${r.board}`;
    step(ok, `${label} ${name.padEnd(15)} ${width}x${height}  ${why}`);
  }
}

const tap = async (p, sel, until) => {
  for (let i = 0; i < 40; i++) {
    if (await p.ev(until)) return true;
    await p.ev(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await sleep(300);
  }
  return false;
};

const pages = [];
try {
  const A = await launch('a');
  pages.push(A);
  await A.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    if (await A.ev(`document.getElementById('online-count')?.textContent.trim() !== ''`)) break;
    await sleep(250);
  }

  // An AI game draws the same screen as an online one, minus the voice row.
  await A.ev(`document.getElementById('btn-ai').click()`); await sleep(400);
  await A.ev(`document.getElementById('ai-easy').click()`);
  for (let i = 0; i < 40; i++) {
    if (await A.ev(`document.querySelectorAll('.pawn').length >= 2`)) break;
    await sleep(250);
  }
  await sweep(A, 'duel      ');

  // The voice row appears only in a friend room, and it is 40 to 60px of the
  // budget — the difference between fitting and not on the small phones.
  await A.ev(`document.getElementById('voice-row').hidden = false`);
  await sweep(A, 'duel+voice', DEVICES.slice(0, 4));

  /* Race, in a real friend room: taller board, one zone label instead of two,
     and the voice row present throughout. */
  const B = await launch('b');
  pages.push(B);
  await B.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    if (await B.ev(`document.getElementById('online-count')?.textContent.trim() !== ''`)) break;
    await sleep(250);
  }

  await A.ev(`document.getElementById('btn-to-menu')?.click()`); await sleep(500);
  await tap(A, '#btn-friend', `document.getElementById('screen-friend')?.classList.contains('active')`);
  await tap(A, '#btn-friend-create', `document.getElementById('overlay-create')?.hidden === false`);
  await A.ev(`document.querySelector('#cr-mode [data-val="race"]').click()`); await sleep(300);
  await A.ev(`document.getElementById('cr-create').click()`);

  let code = '';
  for (let i = 0; i < 40 && !code; i++) {
    code = (await A.ev(`document.getElementById('room-code-value')?.textContent || ''`)).trim();
    await sleep(300);
  }
  await tap(B, '#btn-friend', `document.getElementById('screen-friend')?.classList.contains('active')`);
  await B.ev(`(() => { const i = document.getElementById('friend-code-input');
    i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await B.ev(`document.getElementById('btn-friend-join').click()`);
  for (const p of [A, B]) {
    for (let i = 0; i < 60; i++) {
      if (await p.ev(`document.querySelectorAll('#board [data-vr]').length > 0`)) break;
      await sleep(300);
    }
  }
  await sweep(A, 'race      ', DEVICES.slice(0, 4));
} catch (e) {
  console.error('fit check failed:', e.message);
  failed = true;
} finally {
  for (const p of pages) kill(p);
}

console.log('');
console.log(failed
  ? 'FAIL — the game screen does not fit on every phone.'
  : 'PASS — the whole game fits on one screen everywhere, with nothing to scroll.');
process.exitCode = failed ? 1 : 0;
