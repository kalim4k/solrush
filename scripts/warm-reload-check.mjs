// Does an edit actually reach a browser that has been here before?
//
//   node scripts/warm-reload-check.mjs [url]
//
// Every other check in this repo runs in a fresh profile: no service worker, no
// HTTP cache, every request goes to the network, everything looks correct. That
// is a first-time visitor, and a first-time visitor cannot exhibit a staleness
// bug. Two shipped bugs — a stylesheet that left the bottom nav off the screen
// and a language pack missing every legal document — were both invisible to the
// whole test suite for exactly this reason, and both were plainly visible to
// anyone who had opened the game once before.
//
// So: same profile, twice, with a file changed in between and no version bump.
// Visit one installs the worker. Visit two must see the new bytes. If the
// worker answers from its cache first, it does not, and this fails.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocket } from 'ws';

const URL_ = process.argv[2] || 'http://localhost:3210/';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('no Chrome or Edge found'); process.exit(1); }

const MARK = 'WARMPROBE' + Date.now().toString(36).toUpperCase();

/* Two probes, because the two layers fail differently.

   style.css carries a ?v= and is meant to be busted by that alone — it is the
   file whose staleness hid the bottom nav. lang/en.js carries no version at all
   and is reached by a bare import, so nothing about its URL ever changes — it
   is the shape of file that hid the legal documents. A fix that only rescues
   one of them is not a fix. Neither probe bumps the version: the point is that
   changed content reaches the browser on its own merits. */
const PROBES = [
  {
    file: join(ROOT, 'public/css/style.css'),
    append: `\n:root { --warm-probe: ${MARK}; }\n`,
    read: `getComputedStyle(document.documentElement).getPropertyValue('--warm-probe').trim()`,
    label: 'css/style.css   (versioned ?v=)',
  },
  {
    // Valid ESM: a side effect after the default export still runs on import.
    file: join(ROOT, 'public/lang/en.js'),
    append: `\nwindow.__warmProbe = '${MARK}';\n`,
    read: `String(window.__warmProbe || '')`,
    label: 'lang/en.js      (no version at all)',
  },
];

/* Ask the OS for a port instead of deriving one from the pid. Back-to-back runs
   picked the same number often enough to collide with the previous Chrome,
   which had not finished dying, and the failure surfaced as "DevTools never
   answered" — indistinguishable from a real breakage in the output. */
const PORT = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const profile = mkdtempSync(join(tmpdir(), 'warm-'));   // fresh dir, reused for BOTH visits
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

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
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  return {
    ready: new Promise(r => ws.on('open', r)),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    close: () => ws.close(),
  };
}

const originals = PROBES.map(p => readFileSync(p.file));
let failed = false;

try {
  const cdp = client(await targetUrl());
  await cdp.ready;
  await cdp.send('Page.enable');

  const evaluate = async (expression) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    return result.value;
  };

  /* ---- visit 1: arrive as a new player, let the worker install ---- */
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(3000);

  let controlled = false;
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`Boolean(navigator.serviceWorker.controller)`)) { controlled = true; break; }
    await sleep(500);
  }
  if (!controlled) throw new Error('no service worker took control on the first visit');
  console.log('visit 1: service worker installed and controlling');

  /* ---- edit the files, exactly as a deploy would, with no version bump ---- */
  for (const [i, p] of PROBES.entries()) {
    writeFileSync(p.file, Buffer.concat([originals[i], Buffer.from(p.append)]));
  }
  console.log(`edited ${PROBES.length} files on disk (marker ${MARK})`);

  /* ---- visit 2: come back, same profile, same worker ---- */
  await cdp.send('Page.navigate', { url: URL_ });

  /* Wait for a signal, not for a duration. A fixed sleep here reported the
     legal documents as empty on one run and fine on the next, purely because
     the modules had not finished evaluating — a flaky check that blames the app
     is worse than no check. If the staleness bug is back these polls simply run
     out, which is the correct answer rather than a race. */
  const waitFor = async (expr, ms, what) => {
    for (let i = 0; i < ms / 250; i++) {
      if (await evaluate(expr)) return true;
      await sleep(250);
    }
    console.log(`  (gave up waiting for ${what})`);
    return false;
  };

  // The language pack is a static import, so this going true means app.js's
  // dependencies have evaluated — and that the fresh copy is the one that ran.
  await waitFor(`typeof window.__warmProbe === 'string'`, 20000, 'the language pack to load');
  // Handlers are registered near the end of app.js, after the imports resolve.
  await waitFor(`document.readyState === 'complete'`, 10000, 'the document to finish');
  await sleep(1200);

  console.log('');
  for (const p of PROBES) {
    const got = await evaluate(p.read);
    const ok = String(got).includes(MARK);
    if (!ok) failed = true;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${p.label}  ${ok ? 'served fresh' : `still stale (read ${JSON.stringify(got)})`}`);
  }

  /* ---- and the two symptoms that were actually reported ----

     Asserted against the DOM rather than a screenshot. Both times a screenshot
     was trusted on this project it lied: once because headless ignored the
     requested viewport width, once because --disable-gpu silently switched off
     backdrop-filter. Numbers do not have rendering artefacts. */
  console.log('');
  const nav = await evaluate(`(() => {
    const el = document.getElementById('bottom-nav');
    if (!el) return { ok: false, why: 'no #bottom-nav in the DOM' };
    if (el.classList.contains('hidden')) return { ok: true, why: 'hidden on this screen (expected)', skip: true };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // 'auto' is what an invalid env() without a fallback collapses to, and it
    // drops a fixed element to its static position — off the bottom of the page.
    if (cs.bottom === 'auto') return { ok: false, why: "computed bottom is 'auto' (env() with no fallback?)" };
    if (r.bottom > innerHeight + 1) return { ok: false, why: 'sits ' + Math.round(r.bottom - innerHeight) + 'px below the fold' };
    if (r.width < 100 || r.height < 20) return { ok: false, why: 'collapsed to ' + Math.round(r.width) + 'x' + Math.round(r.height) };
    return { ok: true, why: Math.round(r.width) + 'x' + Math.round(r.height) + ' at bottom:' + cs.bottom };
  })()`);
  if (!nav.ok) failed = true;
  console.log(`  ${nav.ok ? 'PASS' : 'FAIL'}  bottom nav on a returning visit  ${nav.why}`);

  const legal = await evaluate(`(() => {
    const links = [...document.querySelectorAll('[data-legal]')];
    if (!links.length) return { ok: false, why: 'no [data-legal] links found' };
    const out = [];
    for (const a of links) {
      a.click();
      const title = (document.getElementById('legal-title') || {}).textContent || '';
      const body = (document.getElementById('legal-text') || {}).textContent || '';
      // The bug printed the key name itself into the dialog.
      const raw = /^[a-z_]+$/.test(title.trim()) || body.trim().startsWith(a.dataset.legal + '_body');
      out.push({ doc: a.dataset.legal, title: title.trim().slice(0, 28), len: body.trim().length, raw });
    }
    return { ok: out.every(d => !d.raw && d.len > 300), docs: out };
  })()`);
  if (!legal.ok) failed = true;
  if (legal.docs) {
    for (const d of legal.docs) {
      const ok = !d.raw && d.len > 300;
      if (!ok) failed = true;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  legal "${d.doc}"  ${d.raw ? 'showing the raw key name' : `"${d.title}" (${d.len} chars)`}`);
    }
  } else {
    console.log(`  FAIL  legal documents  ${legal.why}`);
  }

  /* ---- phase 3: still works with the network pulled ----

     Network-first is the fix for staleness, but the cache is still what makes
     the game open in a tunnel. Having just rewritten the code that provides
     that, asserting it rather than assuming it. The stylesheet is the tell: it
     is precached as "/css/style.css" and requested as "/css/style.css?v=123",
     so if the fallback ever loses ignoreSearch the page opens unstyled — which
     is how this whole area went wrong the first time. */
  console.log('');
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(4000);

  const off = await evaluate(`(() => {
    const nav = document.getElementById('bottom-nav');
    if (!nav) return { ok: false, why: 'page did not render offline' };
    // A missing stylesheet leaves it static, not fixed.
    const pos = getComputedStyle(nav).position;
    if (pos !== 'fixed') return { ok: false, why: 'rendered but unstyled (nav position: ' + pos + ')' };
    return { ok: true, why: 'shell served from cache, styles applied' };
  })()`);
  if (!off.ok) failed = true;
  console.log(`  ${off.ok ? 'PASS' : 'FAIL'}  offline, network pulled  ${off.why}`);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  cdp.close();
} catch (e) {
  console.error('warm reload check failed:', e.message);
  failed = true;
} finally {
  // Restore before anything else can read these files.
  PROBES.forEach((p, i) => writeFileSync(p.file, originals[i]));

  /* Chrome is a process tree. kill() reaches the launcher and leaves the
     renderers and the GPU process alive, still holding the profile directory
     and the debugging port, so the next run trips over them. */
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    chrome.kill();
  }
}

console.log('');
console.log(failed
  ? 'FAIL — a returning browser is being served files that no longer exist on disk.'
  : 'PASS — an edit with no version bump reaches a browser that has visited before.');
process.exitCode = failed ? 1 : 0;
