// What happens when the connection drops for a moment.
//
//   node scripts/reconnect-check.mjs [url]
//
// Every other check in this repo runs two browsers side by side on a connection
// that never fails, and they all passed while the deployed game was unusable:
// a room made and then waited in would disappear, its code would stop working,
// and two devices on Quick match would spin forever.
//
// The cause was that a closed socket was treated as a player leaving. On a
// laptop on localhost a socket never closes. On a phone it closes every time
// the screen locks or the player switches app — which is exactly what somebody
// does after creating a room, because they go and send the code to a friend.
//
// So this one drops the connection on purpose, using the DevTools network
// emulator, and checks the game survives it.

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OFFLINE = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
const ONLINE = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function launch(name) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), `rc-${name}-`));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-extensions',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl || null;
    } catch { /* not up */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error(`${name}: DevTools never answered`);

  const sock = new WebSocket(wsUrl, { maxPayload: 32 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  sock.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
  });
  await new Promise(r => sock.on('open', r));
  const send = (method, params = {}) => new Promise(resolve => {
    const n = ++id; pending.set(n, { resolve });
    sock.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable');
  await send('Network.enable');

  const ev = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.click() ?? null`);
  const waitFor = async (expr, ms, what) => {
    for (let i = 0; i < ms / 200; i++) { if (await ev(expr)) return true; await sleep(200); }
    throw new Error(`${name}: timed out waiting for ${what}`);
  };

  return { name, chrome, send, ev, click, waitFor };
}

const kill = (p) => process.platform === 'win32'
  ? spawnSync('taskkill', ['/pid', String(p.chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  : p.chrome.kill();

let failed = false;
const pages = [];
const step = (ok, text) => { if (!ok) failed = true; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); };

/* The socket is up when the server has answered hello, which is what fills the
   online counter. Waiting on this rather than on a timer is the difference
   between a check and a coin toss.

   For a RE-connection the counter is useless on its own: it still holds the
   value from last time, so the wait returns instantly and the check races on
   while the socket is still down. Blanking it first makes it a real signal —
   only a fresh hello_ok can fill it again. */
const CONNECTED = `document.getElementById('online-count').textContent.trim() !== ''`;
const FORGET_CONNECTION = `document.getElementById('online-count').textContent = ''`;

try {
  const A = await launch('A');
  const B = await launch('B');
  pages.push(A, B);
  for (const p of [A, B]) {
    await p.send('Page.navigate', { url: URL_ });
    await p.waitFor(`Boolean(document.getElementById('btn-friend'))`, 25000, 'the app');
    await p.waitFor(CONNECTED, 25000, 'the socket');
  }

  /* ---- 1. make a room, then lose the connection while waiting ---- */
  await A.click('#btn-friend'); await sleep(400);
  await A.click('#btn-friend-create'); await sleep(400);
  await A.click('#cr-create');
  await A.waitFor(`(document.getElementById('room-code-value').textContent||'').length >= 4`, 15000, 'a code');
  const code = await A.ev(`document.getElementById('room-code-value').textContent.trim()`);

  await A.ev(FORGET_CONNECTION);
  await A.send('Network.emulateNetworkConditions', OFFLINE);
  await sleep(9000);                       // long enough for the socket to actually die
  await A.send('Network.emulateNetworkConditions', ONLINE);
  await A.waitFor(CONNECTED, 40000, 'A to reconnect');
  step(true, `room ${code} created, connection dropped for 9s, A reconnected`);

  /* ---- 2. the friend types the code ---- */
  await B.click('#btn-friend'); await sleep(400);
  await B.ev(`(() => { const i = document.getElementById('friend-code-input');
    i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await B.click('#btn-friend-join');

  let joined = true;
  for (const p of [A, B]) {
    try { await p.waitFor(`document.querySelectorAll('#board [data-vr]').length > 0`, 20000, 'the board'); }
    catch { joined = false; }
  }
  step(joined, 'the code still works after the host dropped and came back');

  /* ---- 3. quick match, with one side dropping while queued ----

     A and B are released first. Four headless Chromes at once is enough
     contention on a laptop that the fourth one's DevTools port simply never
     answers, which reads as a product failure and is not one. */
  for (const p of [A, B]) kill(p);
  pages.length = 0;
  await sleep(1500);

  const C = await launch('C');
  const D = await launch('D');
  pages.push(C, D);
  for (const p of [C, D]) {
    await p.send('Page.navigate', { url: URL_ });
    await p.waitFor(`Boolean(document.getElementById('btn-quick'))`, 25000, 'the app');
    await p.waitFor(CONNECTED, 25000, 'the socket');
  }

  await C.click('#btn-quick');
  await sleep(800);
  await C.ev(FORGET_CONNECTION);
  await C.send('Network.emulateNetworkConditions', OFFLINE);
  await sleep(9000);
  await C.send('Network.emulateNetworkConditions', ONLINE);
  await C.waitFor(CONNECTED, 40000, 'C to reconnect');

  await D.click('#btn-quick');

  let paired = true;
  for (const p of [C, D]) {
    try { await p.waitFor(`document.querySelectorAll('#board [data-vr]').length > 0`, 30000, 'a match'); }
    catch { paired = false; }
  }
  step(paired, 'quick match still pairs a player whose connection blinked');

  for (const p of pages) p.send('Network.emulateNetworkConditions', ONLINE);
} catch (e) {
  console.error('reconnect check failed:', e.message);
  failed = true;
} finally {
  for (const p of pages) kill(p);
}

console.log('');
console.log(failed
  ? 'FAIL — a dropped connection still breaks online play.'
  : 'PASS — rooms, codes and matchmaking survive a dropped connection.');
process.exitCode = failed ? 1 : 0;
