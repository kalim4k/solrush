// Two browsers, one friend room, one real WebRTC call.
//
//   node scripts/voice-check.mjs [url]
//
// The unit tests prove the server relays signalling in private rooms and
// refuses it everywhere else. They cannot prove the two browsers actually
// negotiate a connection and that audio arrives — that needs two real
// browsers, a real microphone and a real ICE handshake.
//
// Chrome supplies a fake microphone (a tone) and auto-grants the permission
// prompt, so this runs unattended. Both instances are on localhost, so they
// connect on host candidates and no STUN or TURN server is involved.

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
  '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('no Chrome or Edge found'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && handlers.has(msg.method)) {
      for (const fn of handlers.get(msg.method)) fn(msg.params);
    }
  });
  return {
    onEvent: (method, fn) => {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(fn);
    },
    ready: new Promise(r => ws.on('open', r)),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function launch(name) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), `voice-${name}-`));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-extensions',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    /* A fake microphone that plays a tone, and no permission prompt. Without
       these getUserMedia would sit forever waiting on a dialog nobody can
       click, which looks identical to a hung negotiation. */
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl || null;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error(`${name}: DevTools never answered`);

  const cdp = connect(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');

  /* Count microphone requests, before anything on the page can run.

     This is the point of the whole redesign, and it is the one claim that
     cannot be read off the screen: listening must cost no microphone
     permission. Chrome here auto-grants the prompt, so a build that quietly
     asked anyway would connect, sound perfect, and pass every visible check —
     while every real player got a permission dialog for the crime of wanting
     to hear their friend. So we count the calls instead of watching for a
     dialog that this browser will never show. */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__gum = 0;
      if (navigator.mediaDevices) {
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (...a) => { window.__gum++; return real(...a); };
      }
      /* Kept for the failure message only. "Timed out waiting for the call to
         connect" is the least informative sentence in this file — signalling
         state and the transceiver directions say which half stalled. */
      if (window.RTCPeerConnection) {
        const Real = window.RTCPeerConnection;
        window.RTCPeerConnection = function (...a) { const c = new Real(...a); window.__pc = c; return c; };
        window.RTCPeerConnection.prototype = Real.prototype;
      }`,
  });

  /* Anything the page throws or logs as an error. Without this a broken
     handler shows up only as "timed out waiting for ...", and the actual
     exception — which names the line — is invisible. */
  const problems = [];
  await cdp.send('Runtime.enable');
  cdp.onEvent('Runtime.exceptionThrown', (p) => {
    problems.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception');
  });
  cdp.onEvent('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    problems.push(`${p.type}: ` + p.args.map(a => a.value ?? a.description ?? '').join(' '));
  });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`${name}: ${exceptionDetails.text}`);
    return result.value;
  };

  const click = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    el.click(); return 'ok';
  })()`);

  const waitFor = async (expr, ms, what) => {
    for (let i = 0; i < ms / 200; i++) {
      if (await evaluate(expr)) return true;
      await sleep(200);
    }
    throw new Error(`${name}: timed out waiting for ${what}`);
  };

  return { name, chrome, cdp, evaluate, click, waitFor, problems };
}

function kill(page) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(page.chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    page.chrome.kill();
  }
}

let failed = false;
const pages = [];

const step = (ok, text) => {
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`);
};

try {
  const A = await launch('A');
  const B = await launch('B');
  pages.push(A, B);

  for (const p of [A, B]) {
    await p.cdp.send('Page.navigate', { url: URL_ });
    await p.waitFor(`Boolean(document.getElementById('btn-friend'))`, 20000, 'the app to boot');
    await sleep(1200);
  }

  /* ---- A opens a friend room ---- */
  await A.click('#btn-friend');
  await sleep(400);
  await A.click('#btn-friend-create');
  await sleep(400);
  await A.click('#cr-create');
  await A.waitFor(`(document.getElementById('room-code-value').textContent || '').length >= 4`,
    15000, 'a room code');
  const code = (await A.evaluate(`document.getElementById('room-code-value').textContent.trim()`));
  step(Boolean(code), `friend room created (code ${code})`);

  /* ---- B joins by code ---- */
  await B.click('#btn-friend');
  await sleep(400);
  await B.evaluate(`(() => {
    const i = document.getElementById('friend-code-input');
    i.value = ${JSON.stringify(code)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await B.click('#btn-friend-join');

  /* The board only has cells once a game is running, so this is the signal.

     It used to try a class name on #screen-game first and fall back to this.
     The class guess was wrong, so the first check burned its full 15-second
     budget on each page before the fallback ran — thirty seconds of doing
     nothing, which is longer than the game's 30-second-per-move cap. The call
     connected fine and then the screenshot caught a "you lost on time" dialog,
     which reads exactly like a broken feature. */
  for (const p of [A, B]) {
    await p.waitFor(`document.querySelectorAll('#board [data-vr]').length > 0`,
      15000, 'the board to be dealt');
  }
  step(true, 'both players are in the same game');

  /* ---- the control is offered, because the server said so ---- */
  for (const p of [A, B]) {
    const shown = await p.evaluate(`!document.getElementById('voice-row').hidden`);
    step(shown, `${p.name}: voice control offered in a friend room`);
  }

  /* ---- B only wants to LISTEN ----

     One switch, no permission. This is the case the old single button could not
     express at all: joining ran getUserMedia, so hearing your friend required
     handing over a microphone. */
  await B.click('#btn-speaker');
  step(await B.evaluate(`document.getElementById('btn-speaker').getAttribute('aria-pressed') === 'true'`),
    'B: the listen switch went on');
  step(await B.evaluate(`window.__gum === 0`),
    'B: listening asked for NO microphone permission');

  /* ---- A wants to talk ---- */
  const t0 = Date.now();
  await A.click('#btn-mic');
  step(await A.evaluate(`window.__gum === 1`), 'A: the mic switch asked for the microphone, once');
  await A.waitFor(`document.getElementById('btn-mic').classList.contains('live')`, 8000, 'A to go live');
  // Switching the mic on switches listening on with it, so that the obvious
  // first tap does not leave somebody talking into a call they cannot hear.
  step(await A.evaluate(`document.getElementById('btn-speaker').getAttribute('aria-pressed') === 'true'`),
    'A: turning the mic on turned listening on too');

  /* The claim that matters: audio reaches the listener who never granted a
     microphone. Asserted on the stream itself, not on a class name. */
  await B.waitFor(`Boolean(document.getElementById('voice-audio').srcObject)`,
    25000, 'the call to connect for the listener');
  step(true, 'B: remote audio arrived without ever opening a microphone');
  await A.waitFor(`Boolean(document.getElementById('voice-audio').srcObject)`,
    25000, 'the call to connect for the talker');
  step(true, 'A: remote audio stream attached');

  /* How long the handshake took, printed because it is the number that decides
     whether this feels instant or broken. On a machine with no route to the
     STUN servers, ICE waits for them to time out before it settles. */
  console.log(`  ..    call connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  step(await B.evaluate(`window.__gum === 0`),
    'B: still no microphone request, with the call live');

  /* ---- B must be told what A is doing ----

     Asserted on #voice-peer's data-peer, not on its words. The words are in
     whichever of six languages the browser asked for, so an earlier version
     compared the line against a snapshot of itself and treated any change as
     success — which passed while B was still showing "Connecting…", and failed
     the moment the snapshot happened to be taken at the right time. A state
     name is the same in every language. */
  await B.waitFor(`document.getElementById('voice-peer').dataset.peer === 'live'`,
    10000, 'B to see the mic open');
  step(true, 'B: sees the mic is open');

  await A.click('#btn-mic');   // mic off again
  await A.waitFor(`!document.getElementById('btn-mic').classList.contains('live')`, 8000, 'A to mute');
  await B.waitFor(`document.getElementById('voice-peer').dataset.peer === 'muted'`,
    8000, 'B to be told the mic closed');
  step(true, 'B: told the moment the mic closed');

  // A is listening only now, so the call must still be up — closing a
  // microphone is not leaving.
  step(await A.evaluate(`Boolean(document.getElementById('voice-audio').srcObject)`),
    'A: closing the mic did not end the call');

  await A.click('#btn-mic');
  await A.waitFor(`document.getElementById('btn-mic').classList.contains('live')`, 8000, 'A to go live again');
  await B.waitFor(`document.getElementById('voice-peer').dataset.peer === 'live'`,
    8000, 'B to see the mic reopen');
  step(true, 'B: sees it reopen — and no renegotiation was needed for any of it');

  /* An optional look at the live control: node scripts/voice-check.mjs <url> <out.png>
     Taken while the microphone is actually open, which is the state worth
     looking at, and before the game's 30-second-per-move cap can put a result
     dialog over the top of it. */
  if (process.argv[3]) {
    await A.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(500);
    const shot = await A.cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.argv[3], Buffer.from(shot.data, 'base64'));
    console.log(`  ..    wrote ${process.argv[3]}`);
  }
  /* ---- both switches off IS leaving ----

     There is no third button any more. Turning off the last switch that was on
     has to release the microphone and drop the connection, or the ✕ that was
     removed took the only way out with it. */
  await A.click('#btn-mic');
  await A.click('#btn-speaker');
  await A.waitFor(`document.getElementById('voice-audio').srcObject === null`, 8000, 'A to leave');
  step(true, 'turning both switches off left the call and released the stream');
  step(await A.evaluate(`document.getElementById('btn-mic').getAttribute('aria-pressed') === 'false'
                         && document.getElementById('btn-speaker').getAttribute('aria-pressed') === 'false'`),
    'A: both switches read as off afterwards');

  /* ---- and the property that actually matters ----

     Voice must not exist between strangers. The unit tests prove the server
     refuses to relay it in a public room; this proves a player paired by
     matchmaking is never even offered the button. Fresh browsers, because the
     first pair is sitting in a live friend game. */
  const C = await launch('C');
  const D = await launch('D');
  pages.push(C, D);

  for (const p of [C, D]) {
    await p.cdp.send('Page.navigate', { url: URL_ });
    // The socket, not the element. #btn-quick is in the markup from the first
    // byte, so waiting for it proves only that the HTML parsed — and a click
    // fired before the app has wired its listeners is simply lost.
    await p.waitFor(`document.getElementById('online-count')?.textContent.trim() !== ''`,
      20000, 'the app to connect');
  }
  /* Click until the screen moves, rather than once and hope.

     One of the two reliably stayed on the home screen while the other sat in
     the waiting room, and the dump said so plainly: a single click fired at a
     page that has connected but is still finishing its first render lands on
     nothing and is gone. Re-clicking a button that has already worked is
     harmless — the app is already off the home screen by then. */
  for (const p of [C, D]) {
    await p.waitFor(`(() => {
      if (document.getElementById('screen-home')?.classList.contains('active')) {
        document.getElementById('btn-quick')?.click();
        return false;
      }
      return true;
    })()`, 15000, 'the quick-match button to take');
  }

  for (const p of [C, D]) {
    await p.waitFor(`document.querySelectorAll('#board [data-vr]').length > 0`,
      25000, 'a quick match to start');
    const hidden = await p.evaluate(`document.getElementById('voice-row').hidden`);
    step(hidden, `${p.name}: voice NOT offered against a stranger`);
  }

  for (const p of pages) p.cdp.close();
} catch (e) {
  console.error('voice check failed:', e.message);
  failed = true;
  // What each side's connection actually thinks, which is the thing a timeout
  // message never says.
  for (const p of pages) {
    const dump = await p.evaluate(`(() => {
      const where = document.querySelector('.screen.active')?.id
        + ' online=' + (document.getElementById('online-count')?.textContent || '?');
      const c = window.__pc;
      if (!c) return 'no peer connection, on ' + where;
      return JSON.stringify({
        where,
        signaling: c.signalingState, conn: c.connectionState, ice: c.iceConnectionState,
        tx: c.getTransceivers().map(t => t.currentDirection || t.direction).join(','),
        senders: c.getSenders().filter(s => s.track).length,
        audio: Boolean(document.getElementById('voice-audio').srcObject),
        mic: document.getElementById('btn-mic').getAttribute('aria-pressed'),
        spk: document.getElementById('btn-speaker').getAttribute('aria-pressed'),
        says: document.getElementById('voice-peer').textContent,
      });
    })()`).catch((err) => 'could not read: ' + err.message);
    console.log(`  ..    ${p.name} rtc: ${dump}`);
  }
} finally {
  for (const p of pages) {
    for (const problem of p.problems || []) console.log(`  ..    ${p.name} console: ${problem}`);
    kill(p);
  }
}

console.log('');
console.log(failed
  ? 'FAIL — voice did not work end to end.'
  : 'PASS — two browsers connected a real call in a friend room.');
process.exitCode = failed ? 1 : 0;
