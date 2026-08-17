// Does the winner's victory signature actually play on the LOSER's screen?
//
//   node scripts/finish-check.mjs [url]
//
// That sentence is the entire product. Every unit test around it can pass while
// the answer is no: resolveFinish() can gate correctly, the keyframes can be
// perfect, the picker can preview beautifully — and if the id never reaches the
// other player's game_start, or the result screen covers the board before the
// animation runs, the buyer paid for something only they can see.
//
// So this drives two real browsers through a real ranked game. One logs in as a
// Plus account and chooses a paid signature; the other is a guest and resigns.
// The claim is then read off the GUEST's page: the overlay that appears over
// their board must be the one the winner picked.
//
// The account is created here and deleted in the finally block. It exists for
// about twenty seconds, on purpose: the alternative is a permanent probe row
// sitting on the production database being quietly forgotten.

import './../server/boot-env.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { register } from '../server/auth.js';
import { q, close } from '../server/db.js';

const URL_ = process.argv[2] || 'http://localhost:3210/';
const EMAIL = `finish-probe-${randomBytes(4).toString('hex')}@example.com`;
const PASSWORD = randomBytes(12).toString('hex');
const PICK = 'stamp';        // last in the catalogue, and the loudest

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
  let id = 0; const pending = new Map(); const errors = [];
  sock.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });
  await new Promise((r) => sock.on('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); sock.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const ev = async (e) =>
    (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
  return { name, ch, send, ev, errors };
}

const kill = (p) => (process.platform === 'win32'
  ? spawnSync('taskkill', ['/pid', String(p.ch.pid), '/T', '/F'], { stdio: 'ignore' })
  : p.ch.kill());

// The overlay carries its id in a class, so one string answers both "did
// anything play" and "whose was it". Read from the observer's log rather than
// from the live DOM, so a signature that has already finished still counts.
const seen = (p) => p.ev(`(window.__fin || []).join(' ')`);

// Wait for a condition on the page instead of guessing how long it takes.
async function until(p, expr, what, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await p.ev(expr)) return true;
    await sleep(200);
  }
  throw new Error(`${p.name}: ${what}`);
}

const pages = [];
let userId = null;
try {
  const acct = await register(EMAIL, PASSWORD, 'Probe' + randomBytes(2).toString('hex'));
  if (acct?.error) throw new Error('could not create the probe account: ' + acct.error);
  userId = acct.user.id;
  await q('UPDATE users SET plus = true WHERE id = $1', [userId]);

  const A = await launch('win');   // the account, with Plus
  const B = await launch('lose');  // a guest
  pages.push(A, B);

  for (const p of pages) {
    await p.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 80; i++) {
      if (await p.ev(`document.getElementById('online-count')?.textContent.trim() !== ''`)) break;
      await sleep(250);
    }
  }

  /* ---- A logs in and buys nothing: the flag is already on the row ----

     Waited on rather than slept through. Fixed sleeps here failed about one run
     in three, and a check that cries wolf gets ignored, which is worse than not
     having it. */
  /* The click is inside the condition, and retried. A single click fired while
     the app was still wiring up its listeners lands on nothing and is lost
     forever, which is what "the login button never appeared" actually meant:
     the profile screen was never opened, so nothing on it had a layout box. */
  await until(A, `(() => {
    document.querySelector('[data-screen="screen-profile"]')?.click();
    return document.getElementById('screen-profile')?.classList.contains('active');
  })()`, 'the profile screen never opened');
  await until(A, `(() => {
    const b = document.getElementById('btn-show-login');
    if (b && b.offsetParent) b.click();
    return document.getElementById('auth-form')?.hidden === false;
  })()`, 'the login form never opened');
  await A.ev(`(() => { const e = document.getElementById('auth-email'), p = document.getElementById('auth-password');
    e.value = ${JSON.stringify(EMAIL)}; e.dispatchEvent(new Event('input', {bubbles:true}));
    p.value = ${JSON.stringify(PASSWORD)}; p.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await A.ev(`document.getElementById('btn-auth-submit').click()`);

  let logged = false;
  for (let i = 0; i < 50; i++) {
    if (await A.ev(`document.getElementById('logged-box')?.hidden === false`)) { logged = true; break; }
    await sleep(300);
  }
  // Say WHY, not just that it did not happen — the form puts the server's
  // answer on the screen, and "too_many" reads nothing like a broken selector.
  const why = logged ? '' : await A.ev(`document.getElementById('auth-msg')?.textContent || ''`);
  step(logged, `logged in as a Plus account${why ? ' — the form says: ' + why : ''}`);
  if (!logged) throw new Error('cannot check a Plus feature without logging in');

  /* Poll, do not sleep. #logged-box is revealed by the HTTP profile fetch, but
     the picker is redrawn by hello_ok over the socket — two different round
     trips, and a fixed wait measured the wrong one. */
  let unlocked = false;
  for (let i = 0; i < 40; i++) {
    if (await A.ev(`document.querySelectorAll('#finish-grid .cos-swatch.locked').length === 0`)) {
      unlocked = true; break;
    }
    await sleep(150);
  }
  step(unlocked, 'Plus unlocks every victory signature');

  await A.ev(`[...document.querySelectorAll('#finish-grid .cos-swatch')]
                .find(b => b.getAttribute('aria-label') === ${JSON.stringify(PICK)})?.click()`);
  await sleep(700);   // the choice rides on the next hello
  step(await A.ev(`localStorage.getItem('wr_finish') === ${JSON.stringify(PICK)}`),
    `choosing "${PICK}" stores it`);

  /* ---- a real ranked game ---- */
  await A.ev(`document.querySelector('[data-screen="screen-home"]').click()`);
  await sleep(300);
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

  // What the winner's own client believes about itself, read off the picker
  // rather than out of a module local: which signature is marked chosen, and
  // whether it still thinks anything is locked.
  const winnerState = `chosen=${await A.ev(
    `document.querySelector('#finish-grid .cos-swatch.on')?.getAttribute('aria-label')`)} locked=${await A.ev(
    `document.querySelectorAll('#finish-grid .cos-swatch.locked').length`)}`;

  /* Watch instead of poll. The overlay lives for about a second and both pages
     are being driven over one debugging socket, so a poll can genuinely step
     over it — and "I did not see it" would be indistinguishable from "it never
     happened". An observer installed before the resign cannot miss it. */
  for (const p of pages) {
    await p.ev(`(() => {
      window.__fin = [];
      new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) {
          if (n.classList?.contains('finish')) window.__fin.push(n.className);
        }
      }).observe(document.getElementById('board'), { childList: true });
    })()`);
  }

  // B gives up, so A wins without sixteen scripted moves.
  await B.ev(`document.getElementById('btn-resign').click()`);
  await sleep(300);
  await B.ev(`document.getElementById('btn-resign-yes').click()`);

  /* Poll hard and immediately: the whole thing is over in about a second, and
     a fixed sleep would either miss it or prove nothing about when it ran. */
  let onLoser = '', onWinner = '';
  for (let i = 0; i < 40; i++) {
    onLoser = onLoser || await seen(B);
    onWinner = onWinner || await seen(A);
    if (onLoser && onWinner) break;
    await sleep(50);
  }

  step(onWinner.includes('fin-' + PICK), `the winner sees their own signature (${onWinner || 'nothing'})`);
  // The headline claim. Everything else in this feature is decoration.
  step(onLoser.includes('fin-' + PICK),
    `the LOSER sees the winner's signature (${onLoser || 'nothing'})`);
  // Only when something above went wrong. On a green run this is noise, and a
  // check that prints noise is a check people stop reading.
  if (!onWinner || !onLoser) console.log(`        winner's own client: ${winnerState}`);
  step(await B.ev(`document.querySelector('#board > .finish')?.children.length > 0
                   || document.getElementById('overlay-gameover')?.hidden === false`),
    'the animation is built out of real elements, not an empty box');

  /* Tap to skip. A celebration the loser cannot dismiss is a grudge, so the
     first touch anywhere has to hand them their result. */
  await sleep(80);
  const skipped = await B.ev(`(async () => {
    const overlay = document.getElementById('overlay-gameover');
    if (!overlay.hidden) return 'already-shown';   // the animation had finished
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    return overlay.hidden ? 'still-hidden' : 'skipped';
  })()`);
  step(skipped !== 'still-hidden', `a tap ends it early (${skipped})`);

  // And it must end on its own for anyone who does not tap.
  let shown = false;
  for (let i = 0; i < 40; i++) {
    if (await A.ev(`document.getElementById('overlay-gameover')?.hidden === false`)) { shown = true; break; }
    await sleep(100);
  }
  step(shown, 'the result screen arrives on its own');
  step(await A.ev(`!document.querySelector('#board > .finish')`),
    'the overlay is cleaned up, not left over the next game');

  const errs = [...A.errors, ...B.errors];
  step(errs.length === 0, `no exceptions${errs.length ? ': ' + errs.slice(0, 2).join(' / ') : ''}`);
} catch (e) {
  console.error('finish check failed:', e.message);
  failed = true;
} finally {
  for (const p of pages) kill(p);
  // The probe account and the match row it left behind. Deleted here rather
  // than "later", because later is how the last one is still on production.
  if (userId) {
    await q('DELETE FROM users WHERE id = $1', [userId]).catch((e) => {
      console.error(`could not delete the probe account (${EMAIL}):`, e.message);
    });
  }
  await close().catch(() => {});
}

console.log('');
console.log(failed ? 'FAIL — the victory signature does not reach the other player.'
  : "PASS — the winner's signature plays on the loser's screen, and can be skipped.");
process.exitCode = failed ? 1 : 0;
