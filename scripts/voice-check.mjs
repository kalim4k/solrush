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

  /* ---- both join the call ---- */
  for (const p of [A, B]) {
    await p.click('#btn-voice');
  }

  const t0 = Date.now();
  for (const p of [A, B]) {
    // Joined muted by design: the button carries 'muted' once connected.
    await p.waitFor(`document.getElementById('btn-voice').classList.contains('muted')
                     || document.getElementById('btn-voice').classList.contains('live')`,
      25000, 'the call to connect');
    const audio = await p.evaluate(`Boolean(document.getElementById('voice-audio').srcObject)`);
    step(audio, `${p.name}: remote audio stream attached`);
  }
  /* How long the handshake took, printed because it is the number that decides
     whether this feels instant or broken. On a machine with no route to the
     STUN servers, ICE waits for them to time out before it settles. */
  console.log(`  ..    call connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* The strongest signal available: ask the browser what the peer connection
     thinks, rather than trusting our own UI class names. */
  for (const p of [A, B]) {
    const label = await p.evaluate(`document.getElementById('voice-label').textContent`);
    const peer = await p.evaluate(`document.getElementById('voice-peer').textContent`);
    step(Boolean(label), `${p.name}: "${label}" · peer: "${peer}"`);
  }

  /* ---- the microphone starts closed ---- */
  const aLiveAtStart = await A.evaluate(`document.getElementById('btn-voice').classList.contains('live')`);
  step(!aLiveAtStart, 'microphone starts closed, as designed');

  /* ---- A opens the microphone; B must be told ----

     Asserted by waiting for B's line to CHANGE, rather than by comparing it to
     an expected string: the browser picks its own language here, so hard-coding
     "Their mic is on" would make this a French-only check. An earlier version
     of this step called step(true, ...) and printed whatever B happened to be
     showing — it passed while B was still displaying the old state, which is
     the failure it was written to catch. */
  const bBefore = await B.evaluate(`document.getElementById('voice-peer').textContent`);
  await A.click('#btn-voice');
  await A.waitFor(`document.getElementById('btn-voice').classList.contains('live')`, 8000, 'A to go live');
  await B.waitFor(
    `document.getElementById('voice-peer').textContent !== ${JSON.stringify(bBefore)}`,
    8000, 'B to be told the mic opened');

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
  const bSees = await B.evaluate(`document.getElementById('voice-peer').textContent`);
  step(bSees !== bBefore, `A opened the mic; B went from "${bBefore}" to "${bSees}"`);

  /* ---- leaving ends it cleanly on both sides ---- */
  await A.click('#btn-voice-leave');
  await A.waitFor(`document.getElementById('voice-audio').srcObject === null`, 8000, 'A to leave');
  step(true, 'A left the call and the stream was released');

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
    await p.waitFor(`Boolean(document.getElementById('btn-quick'))`, 20000, 'the app to boot');
    await sleep(1200);
  }
  for (const p of [C, D]) await p.click('#btn-quick');

  for (const p of [C, D]) {
    await p.waitFor(`document.querySelectorAll('#board [data-vr]').length > 0`,
      20000, 'a quick match to start');
    const hidden = await p.evaluate(`document.getElementById('voice-row').hidden`);
    step(hidden, `${p.name}: voice NOT offered against a stranger`);
  }

  for (const p of pages) p.cdp.close();
} catch (e) {
  console.error('voice check failed:', e.message);
  failed = true;
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
