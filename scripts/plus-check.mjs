// Does the Plus offer actually exist, from a player's side?
//
//   node scripts/plus-check.mjs [url]
//
// The bug this guards against is not a crash. It is a dead end: the game told
// a player "SolRush Plus only" and then gave them nowhere to go — no page, no
// price, no way to buy. That reads as broken, and it refuses a sale the game
// itself just proposed. Every assertion here is about a path existing.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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

const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const ch = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'plus-'))}`,
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

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL_ });
  /* Wait for the swatches, not for the online counter.

     The counter reads "0" before the socket has said anything, so the obvious
     condition — "it is no longer empty" — is true at t=0 and waits for
     nothing. Every assertion below it then ran against a page that had not
     finished booting, and reported a missing offer that was simply not drawn
     yet. The grid is filled by renderCosmetics(), which runs when the server
     has answered hello, so its children are the honest signal. */
  for (let i = 0; i < 80; i++) {
    if (await ev(`document.getElementById('skin-grid')?.children.length > 0`)) break;
    await sleep(250);
  }
  await ev(`document.querySelector('.nav-btn[data-screen="screen-profile"]')?.click()`);
  await sleep(600);
  const onProfile = await ev(`document.querySelector('.screen.active')?.id === 'screen-profile'
    && document.getElementById('skin-grid').children.length > 0`);
  step(onProfile, 'the profile screen with the appearance box is open');

  step(await ev(`document.getElementById('btn-plus')?.hidden === false`),
    'a player without Plus is shown the offer banner');

  /* The dead end itself: a locked swatch has to lead somewhere. */
  const locked = await ev(`(() => {
    const el = [...document.querySelectorAll('#skin-grid .locked, #skin-grid [data-locked]')][0]
      || [...document.querySelectorAll('#skin-grid > *')].find(e => e.className.includes('lock'));
    if (!el) return null;
    el.click();
    return true;
  })()`);
  step(locked === true, 'there is a locked skin to tap');
  await sleep(500);
  step(await ev(`document.getElementById('overlay-plus')?.hidden === false`),
    'tapping a locked skin opens the offer instead of a dead-end toast');

  const shown = await ev(`({
    price: document.getElementById('plus-price-value').textContent,
    title: document.querySelector('#overlay-plus h2').textContent,
    lede: document.querySelector('#overlay-plus .plus-lede').textContent,
    items: [...document.querySelectorAll('#overlay-plus .plus-list li')]
             .map(li => li.lastElementChild.textContent).filter(Boolean).length,
    buy: document.getElementById('plus-buy').textContent,
    once: document.querySelector('#overlay-plus .plus-price span').textContent,
  })`);
  step(shown.price.length > 3, `a price is shown: "${shown.price}"`);
  step(shown.items === 5, `${shown.items} things you get are listed`);
  step(shown.title.length > 0 && shown.lede.length > 0 && shown.buy.length > 0,
    'the offer is written, not a set of empty translation slots');
  step(/once|fois|vez|раз|kez|بار/i.test(shown.once),
    `it says the payment is one-off: "${shown.once}"`);

  // The buy button must be honest while no processor is wired.
  await ev(`document.getElementById('plus-buy').click()`);
  await sleep(400);
  const toastText = await ev(`document.getElementById('toast')?.hidden === false
    && document.getElementById('toast').textContent`);
  step(!!toastText, `the buy button says what happens next: "${toastText}"`);

  // Captured with the offer open: the artefact is only worth keeping if it
  // shows the thing under test. The first version photographed the screen
  // after dismissing it, which proved nothing.
  await ev(`document.getElementById('toast').hidden = true`);
  await sleep(200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.PLUS_SHOT || 'plus-offer.png', Buffer.from(shot.data, 'base64'));

  await ev(`document.getElementById('plus-close').click()`);
  await sleep(300);
  step(await ev(`document.getElementById('overlay-plus').hidden === true`),
    'and the offer can be dismissed');
} catch (e) {
  console.error('plus check failed:', e.message);
  failed = true;
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
  else ch.kill();
}

console.log(failed
  ? '\nFAIL — the game still refuses a sale it offered.'
  : '\nPASS — a locked cosmetic leads to a real offer with a real price.');
process.exitCode = failed ? 1 : 0;
