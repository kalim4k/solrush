// Can a finished game actually be sent to somebody, and does the link work?
//
//   node scripts/replay-check.mjs [url]
//
// Two browsers play a real ranked game to a real finish, the loser resigns, and
// then a THIRD browser — no account, no session, nothing shared but the URL —
// opens the link and has to see the same game. That third browser is the whole
// point: a replay only has value if it works for somebody who was not there.
//
// The reconstruction is where this can go quietly wrong. The server stores the
// moves, not the positions, so the link is only as good as the engine's ability
// to replay them in order. A move recorded that the engine would refuse, or one
// recorded that never happened, desynchronises everything after it — and the
// replay still "plays", just of a different game. So the final position of the
// reconstruction is compared against the number of moves that were made.

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
].find(existsSync);
if (!CHROME) { console.error('no Chrome found'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const step = (ok, t) => { if (!ok) failed = true; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${t}`); };

async function launch(name) {
  const port = await new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
  const ch = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-extensions',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rp-' + name + '-'))}`,
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
  return { name, ch, send, ev };
}

const kill = (p) => (process.platform === 'win32'
  ? spawnSync('taskkill', ['/pid', String(p.ch.pid), '/T', '/F'], { stdio: 'ignore' })
  : p.ch.kill());

// Ready means the board is drawn, not that the page responded. Waiting on the
// online counter does not work: it reads "0" before the socket has answered.
const ready = async (p) => {
  for (let i = 0; i < 80; i++) {
    if (await p.ev(`document.getElementById('skin-grid')?.children.length > 0`)) return true;
    await sleep(250);
  }
  return false;
};

const pages = [];
try {
  const A = await launch('a'); pages.push(A);
  const B = await launch('b'); pages.push(B);
  for (const p of [A, B]) { await p.send('Page.navigate', { url: URL_ }); }
  step(await ready(A) && await ready(B), 'two browsers are up and connected');

  // A friend room, so the pairing is deterministic rather than at the mercy of
  // whoever else happens to be in matchmaking.
  const tap = async (p, sel, until) => {
    for (let i = 0; i < 40; i++) {
      if (await p.ev(until)) return true;
      await p.ev(`document.querySelector(${JSON.stringify(sel)})?.click()`);
      await sleep(300);
    }
    return false;
  };
  await tap(A, '#btn-friend', `document.getElementById('screen-friend')?.classList.contains('active')`);
  await tap(A, '#btn-friend-create', `document.getElementById('overlay-create')?.hidden === false`);
  await A.ev(`document.getElementById('cr-create').click()`);

  let code = '';
  for (let i = 0; i < 40 && !code; i++) {
    code = (await A.ev(`document.getElementById('room-code-value')?.textContent || ''`)).trim();
    await sleep(300);
  }
  step(!!code, `a room was created (${code})`);

  await tap(B, '#btn-friend', `document.getElementById('screen-friend')?.classList.contains('active')`);
  await B.ev(`(() => { const i = document.getElementById('friend-code-input');
    i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await B.ev(`document.getElementById('btn-friend-join').click()`);

  let started = false;
  for (let i = 0; i < 60 && !started; i++) {
    started = await A.ev(`document.querySelectorAll('#board .pawn').length >= 2`);
    await sleep(300);
  }
  step(started, 'the game started on both screens');

  /* A few real moves, so there is something to replay. Whoever has the turn
     taps a legal destination; the other waits. Played through the UI rather
     than the socket, so what ends up stored is what a player would produce. */
  let played = 0;
  for (let i = 0; i < 8; i++) {
    for (const p of [A, B]) {
      const moved = await p.ev(`(() => {
        const t = document.querySelector('#board .cell.legal, #board .legal');
        if (!t) return false;
        t.click();
        return true;
      })()`);
      if (moved) played++;
      await sleep(450);
    }
  }
  step(played >= 4, `${played} moves were played through the board`);

  // B resigns, which ends the game for both without waiting on a clock.
  await B.ev(`document.getElementById('btn-resign').click()`);
  await sleep(300);
  await B.ev(`document.getElementById('btn-resign-yes').click()`);

  let over = false;
  for (let i = 0; i < 40 && !over; i++) {
    over = await A.ev(`document.getElementById('overlay-gameover')?.hidden === false`);
    await sleep(300);
  }
  step(over, 'the game ended and the result screen is up');

  step(await A.ev(`document.getElementById('btn-share-replay')?.hidden === false`),
    'the winner is offered a way to send the game');

  /* The share button copies to the clipboard in a headless browser with no
     share sheet, and reading the clipboard needs a permission. So the token is
     taken from where the button gets it. */
  await A.ev(`(() => {
    /* game is module-scoped, so the button is the only public handle on the
       token: click it and intercept what it tries to send. navigator.share is
       stubbed out too — where it exists, shareReplay prefers it and never
       reaches the clipboard at all. The result is read in a SECOND evaluation
       because the click starts an async chain; reading it in the same one
       returned null every time, which looked like a missing token. */
    window.__shared = null;
    navigator.share = (d) => { window.__shared = d.url; return Promise.resolve(); };
    navigator.clipboard.writeText = (t) => { window.__shared = t; return Promise.resolve(); };
    document.getElementById('btn-share-replay').click();
  })()`);
  let shareToken = null;
  for (let i = 0; i < 20 && !shareToken; i++) {
    shareToken = await A.ev(`window.__shared`);
    await sleep(200);
  }
  const t = (shareToken || '').split('/r/')[1] || '';
  step(/^[A-Za-z0-9_-]{8,64}$/.test(t), `the share link carries a token (${shareToken || 'none'})`);

  /* The stranger. A third browser, no session, nothing but the URL. */
  const C = await launch('c'); pages.push(C);
  await C.send('Page.navigate', { url: new URL('/r/' + t, URL_).href });
  let opened = false;
  for (let i = 0; i < 60 && !opened; i++) {
    opened = await C.ev(`document.getElementById('replay-bar')?.hidden === false`);
    await sleep(300);
  }
  step(opened, 'somebody with only the link sees the replay open');

  const seen = await C.ev(`({
    frames: document.getElementById('rp-count')?.textContent || '',
    title: document.getElementById('rp-title')?.textContent || '',
    titleShown: document.getElementById('rp-title')?.hidden === false,
    pawns: document.querySelectorAll('#board .pawn').length,
    path: location.pathname,
  })`);
  const total = Number((seen.frames.split('/')[1] || '0'));
  step(total === played, `the reconstruction has ${total} moves; ${played} were played`);
  step(seen.pawns >= 2, 'the board is drawn with both pawns');
  step(seen.titleShown && seen.title.includes('·'), `both players are named: "${seen.title}"`);
  step(seen.path === '/', 'the address is cleaned up so a refresh does not replay it again');

  /* Controls a spectator must not have. All three were on screen in the first
     working version, and only a screenshot showed it: a stranger was offered a
     button to abandon somebody else's finished match, a dock to place walls in
     it, and two clocks reading 5:00 beside players who stopped hours ago. */
  const controls = await C.ev(`({
    resign: document.getElementById('btn-resign')?.hidden,
    dock: document.getElementById('wall-dock')?.hidden,
    clocksHidden: getComputedStyle(document.getElementById('me-clock')).visibility === 'hidden',
    bottomLabel: document.getElementById('zone-bottom')?.textContent || '',
  })`);
  step(controls.resign === true, 'a spectator is not offered a resign button');
  step(controls.dock === true, 'nor a wall dock');
  step(controls.clocksHidden, 'nor a running clock on a game that ended');
  /* The near end of the board carries a name, and it used to be the VIEWER's.
     In your own game that is correct and indistinguishable; in a replay it put
     the spectator's guest nickname under a stranger's pawn, so the board said
     "Calm Wolf" while the pill above it said "Steady Raven". Only a screenshot
     showed it. */
  const nearPlayer = seen.title.split('·')[0].trim().toUpperCase();
  step(controls.bottomLabel.toUpperCase().includes(nearPlayer),
    `the near end is labelled with the player who sat there: "${controls.bottomLabel.trim()}"`);

  // And a token nobody issued must not open anything.
  await C.send('Page.navigate', { url: new URL('/r/' + 'a'.repeat(16), URL_).href });
  await sleep(2500);
  step(await C.ev(`document.getElementById('replay-bar')?.hidden !== false`),
    'an invented token opens nothing');
} catch (e) {
  console.error('replay check failed:', e.message);
  failed = true;
} finally {
  for (const p of pages) kill(p);
}

console.log(failed
  ? '\nFAIL — a shared game does not survive the trip.'
  : '\nPASS — a finished game can be sent, and opens for somebody who was not there.');
process.exitCode = failed ? 1 : 0;
