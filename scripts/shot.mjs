// Screenshots the running game at a real device size.
//
//   node scripts/shot.mjs [url] [width] [height] [out.png]
//
// Chrome's --window-size flag does NOT set the layout viewport in headless: ask
// for 390 and the page is laid out at 526, which is wide enough to clear a
// mobile breakpoint and make a perfectly responsive layout look broken. The
// screenshot is then cropped to 390 and the overflow looks real. An hour can go
// into "fixing" a bug that only exists in the screenshot.
//
// Emulation.setDeviceMetricsOverride is the switch that actually works, and it
// is only reachable over the DevTools protocol — hence the socket below rather
// than another CLI flag.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

// The fifth argument is a comma-separated list of element ids to click before
// the shot, so a screen that is three taps deep can be captured:
//   node scripts/shot.mjs http://localhost:3000/ 390 844 ai.png btn-ai,ai-normal
const [url = 'http://localhost:3000/', w = '390', h = '844', out = 'shot.png', clicks = ''] =
  process.argv.slice(2);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('no Chrome or Edge found'); process.exit(1); }

const PORT = 9222 + (process.pid % 500);

/* A fresh profile every run is the honest default for layout work, but it also
   means every screenshot in this repo has been of a first-time visitor: no
   service worker, no HTTP cache, every request straight to the network. That is
   the one kind of visitor who cannot show a staleness bug, and two of them
   shipped while these screenshots looked perfect.

   SHOT_PROFILE=<dir> reuses a profile so the second run arrives with a worker
   already installed. See scripts/warm-reload-check.mjs for the automated form. */
const profile = process.env.SHOT_PROFILE || mkdtempSync(join(tmpdir(), 'shot-'));
if (process.env.SHOT_PROFILE) console.log(`reusing profile ${profile}`);

/* SwiftShader rather than --disable-gpu.

   --disable-gpu does not merely pick a slower renderer, it turns off the
   compositing effects that need one: backdrop-filter stops blurring and simply
   does nothing. A frosted bar then screenshots as a flat translucent panel with
   the page text legible straight through it, and the obvious reaction is to
   "fix" a design that was never broken. Software GL runs the same code path the
   GPU would. */
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The debugging port is not open the instant the process starts.
async function targetUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools never answered');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method).forEach(fn => fn(msg.params));
      events.delete(msg.method);
    }
  });
  return {
    ready: new Promise(r => ws.on('open', r)),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    once: (method) => new Promise(r => {
      if (!events.has(method)) events.set(method, []);
      events.get(method).push(r);
    }),
    close: () => ws.close(),
  };
}

try {
  const cdp = client(await targetUrl());
  await cdp.ready;
  await cdp.send('Page.enable');

  // mobile: true is what makes width=device-width mean what it says.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: true,
  });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(2500);   // the whole UI is drawn by JS after load

  /* Each step is a CSS selector, or a bare word treated as an id. Board cells
     carry no id — they are addressed as [data-vr="7"][data-vc="4"] — so plain
     getElementById would not reach the one thing most worth clicking. */
  for (const step of clicks.split(',').map(s => s.trim()).filter(Boolean)) {
    const sel = /^[\w-]+$/.test(step) ? `#${step}` : step;
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)});
                            if (!el) return 'missing'; el.click(); return 'clicked'; })()`,
      returnByValue: true,
    });
    console.log(`  ${sel}: ${result.value}`);
    if (result.value === 'missing') throw new Error(`nothing matches ${sel}`);
    await sleep(1600);   // screens fade in, and the AI takes a moment to reply
  }

  // What the page thinks it got — printed so a wrong viewport is obvious in the
  // log rather than a puzzle in the image.
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      inner: innerWidth,
      scroll: document.documentElement.scrollWidth,
      lang: document.documentElement.lang,
    })`,
    returnByValue: true,
  });
  const m = JSON.parse(result.value);
  console.log(`viewport ${m.inner}px, content ${m.scroll}px, lang "${m.lang}"`);
  if (m.scroll > m.inner + 1) console.warn(`  ! horizontal overflow of ${m.scroll - m.inner}px`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${out}`);
  cdp.close();
} catch (e) {
  console.error('screenshot failed:', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
