// Does the language picker actually change the page?
//
//   node scripts/lang-check.mjs [url]
//
// The switcher shipped broken in a way no unit test could see: LANGS offered
// six languages, AVAILABLE listed two, and loadLang() returned English for the
// rest. Every key existed, every pack that existed was complete, and clicking
// Español did nothing at all. The only check that catches that is clicking the
// button and reading the page back.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import EN from '../public/lang/en.js';
import FR from '../public/lang/fr.js';
import ES from '../public/lang/es.js';
import RU from '../public/lang/ru.js';
import TR from '../public/lang/tr.js';
import FA from '../public/lang/fa.js';

const URL_ = process.argv[2] || 'http://localhost:3210/';

// Three strings per language: one from the home screen, one from a dialog, one
// from a document. A pack that only half-loads passes the first and fails the
// rest, which is worth telling apart.
const CASES = [
  { code: 'en', pack: EN, rtl: false },
  { code: 'fr', pack: FR, rtl: false },
  { code: 'es', pack: ES, rtl: false },
  { code: 'ru', pack: RU, rtl: false },
  { code: 'tr', pack: TR, rtl: false },
  { code: 'fa', pack: FA, rtl: true },
];

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('no Chrome or Edge found'); process.exit(1); }

const PORT = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const profile = mkdtempSync(join(tmpdir(), 'lang-'));
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

let failed = false;

try {
  const cdp = client(await targetUrl());
  await cdp.ready;
  await cdp.send('Page.enable');
  /* awaitPromise matters: setLang() awaits a dynamic import, so the checks below
     are async IIFEs. Without it, evaluate hands back the Promise object itself,
     returnByValue serialises that to undefined, and every field reads
     "undefined" — which looks exactly like a totally broken page rather than a
     mistake in the harness. */
  const evaluate = async (expression) => {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    return result.value;
  };

  await cdp.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`Boolean(document.querySelector('#lang-list button'))`)) break;
    await sleep(250);
  }

  for (const c of CASES) {
    const expect = {
      tagline: c.pack.tagline,
      play_ai: c.pack.play_ai,
      rules_title: c.pack.rules_title,
      // First heading of the rules document, to prove the long text switched too.
      rules_head: c.pack.rules_body.split('\n').find(l => l.startsWith('## ')).slice(3),
    };

    const got = await evaluate(`(async () => {
      const b = document.querySelector('#lang-list button[data-lang="${c.code}"]');
      if (!b) return { err: 'no button for ${c.code}' };
      b.click();
      // setLang is async: it awaits the dynamic import before repainting.
      for (let i = 0; i < 60; i++) {
        if (document.documentElement.lang === '${c.code}') break;
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 250));
      const legal = document.querySelector('[data-legal="rules"]');
      if (legal) legal.click();
      const body = (document.getElementById('legal-text') || {}).textContent || '';
      const title = (document.getElementById('legal-title') || {}).textContent || '';
      const close = document.getElementById('legal-close');
      if (close) close.click();
      const tag = document.querySelector('[data-i18n="tagline"]');
      const ai = document.querySelector('[data-i18n="play_ai"]');
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        stored: localStorage.getItem('wr_lang'),
        tagline: tag ? tag.textContent.trim() : null,
        play_ai: ai ? ai.textContent.trim() : null,
        rules_title: title.trim(),
        bodyLen: body.trim().length,
        bodyHas: body.includes(${JSON.stringify(expect.rules_head)}),
      };
    })()`);

    const problems = [];
    if (got.err) problems.push(got.err);
    else {
      if (got.lang !== c.code) problems.push(`html lang is "${got.lang}"`);
      if (got.stored !== c.code) problems.push(`localStorage kept "${got.stored}"`);
      if (got.dir !== (c.rtl ? 'rtl' : 'ltr')) problems.push(`dir is "${got.dir}"`);
      if (got.tagline !== expect.tagline) problems.push(`tagline "${got.tagline}"`);
      if (got.play_ai !== expect.play_ai) problems.push(`play_ai "${got.play_ai}"`);
      if (got.rules_title !== expect.rules_title) problems.push(`rules title "${got.rules_title}"`);
      if (!got.bodyHas) problems.push(`rules body did not switch (${got.bodyLen} chars)`);
    }

    if (problems.length) failed = true;
    console.log(`  ${problems.length ? 'FAIL' : 'PASS'}  ${c.code}${c.rtl ? ' (rtl)' : '    '}  ` +
      (problems.length ? problems.join('; ') : `"${got.tagline}" · ${got.rules_title} · ${got.bodyLen} chars · dir=${got.dir}`));
  }

  /* The choice has to survive a reload — it is stored in localStorage and read
     back at boot, which is a different code path from the click. */
  await cdp.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`document.documentElement.lang === 'fa'`)) break;
    await sleep(250);
  }
  const after = await evaluate(`JSON.stringify({
    lang: document.documentElement.lang, dir: document.documentElement.dir,
  })`);
  const a = JSON.parse(after);
  const ok = a.lang === 'fa' && a.dir === 'rtl';
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  choice survives a reload  lang=${a.lang} dir=${a.dir}`);

  cdp.close();
} catch (e) {
  console.error('language check failed:', e.message);
  failed = true;
} finally {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    chrome.kill();
  }
}

console.log('');
console.log(failed ? 'FAIL — the picker does not switch every language.'
  : 'PASS — all six languages switch the home screen, the dialogs and the documents.');
process.exitCode = failed ? 1 : 0;
