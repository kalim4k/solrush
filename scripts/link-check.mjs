// Does the Strategy link actually appear, point somewhere real, and follow the
// language? Serving 200 to curl proves the file exists; it does not prove the
// app renders a link to it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const URL_ = 'http://localhost:3210/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const step = (ok, t) => { if (!ok) failed = true; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${t}`); };

const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const ch = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-extensions',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'link-'))}`,
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

const sock = new WebSocket(wsUrl);
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
  await send('Page.navigate', { url: URL_ });

  /* Wait for the app, not for the markup. index.html ships "Strategy" as the
     fallback text of the link, so "the element has text" is true before any
     language pack has loaded — an earlier version of this waited on exactly
     that and sampled a half-booted page, passing and failing on alternate
     runs for no reason the product was responsible for. The online counter is
     only written once the socket has answered. */
  for (let i = 0; i < 80; i++) {
    if (await ev(`document.getElementById('online-count')?.textContent.trim() !== ''`)) break;
    await sleep(250);
  }

  // Nor assume which language it opened in. On a French Windows it opens in
  // French, correctly, and the test has no business being surprised by that.
  const pick = async (code) => {
    await ev(`document.getElementById('btn-lang').click()`);
    await sleep(250);
    await ev(`document.querySelector('#lang-list button[data-lang="${code}"]')?.click()`);
    for (let i = 0; i < 40; i++) {
      if (await ev(`document.documentElement.lang === '${code}'`)) return true;
      await sleep(250);
    }
    return false;
  };
  const read = () => ev(`(() => {
    const a = document.getElementById('link-strategy');
    const r = document.querySelector('.legal-links a[data-legal="rules"]');
    return { text: a.textContent, href: a.getAttribute('href'),
             rules: r.getAttribute('href'), lang: document.documentElement.lang };
  })()`);

  step(await pick('en'), 'the game can be put into English');
  let v = await read();
  step(v.href === '/strategy/', `English points at /strategy/ (got ${v.href})`);
  step(v.rules === '/rules/', `and Rules at /rules/ (got ${v.rules})`);
  step(v.text === 'Strategy', `labelled "${v.text}"`);

  step(await pick('ru'), 'the game can be put into Russian');
  v = await read();
  // No Russian document exists, so the label is translated and the address
  // falls back to English — which the page itself says at the top.
  step(v.href === '/strategy/', `Russian falls back to /strategy/ (got ${v.href})`);
  step(v.text === 'Стратегия', `still labelled in Russian: "${v.text}"`);

  step(await pick('fr'), 'the game can be put into French');
  v = await read();
  step(v.href === '/strategie/', `French points at /strategie/ (got ${v.href})`);
  step(v.rules === '/regles/', `and Rules at /regles/ (got ${v.rules})`);
  step(v.text === 'Stratégie', `labelled "${v.text}"`);

  // Rules still opens the overlay rather than following its href.
  await ev(`document.querySelector('.legal-links a[data-legal="rules"]').click()`);
  await sleep(500);
  const overlay = await ev(`document.getElementById('overlay-legal')?.hidden === false`);
  const path = await ev(`location.pathname`);
  step(overlay && path === '/', `Rules opens the overlay (open=${overlay}) without leaving the page (at ${path})`);
  await ev(`document.getElementById('overlay-legal').hidden = true`);

  // Strategy has no overlay, so its click must genuinely navigate.
  await ev(`document.getElementById('link-strategy').click()`);
  for (let i = 0; i < 40; i++) {
    // readyState too: pathname flips when the navigation commits, which is
    // before the document has finished parsing. Reading innerText at that
    // moment counted 489 words of a 1570-word page and reported it as a
    // content failure.
    if (await ev(`location.pathname === '/strategie/' && document.readyState === 'complete'`)) break;
    await sleep(250);
  }
  /* Counted without a regex on purpose. The first version of this line split
     on /\s+/, the backslash was lost on the way into the browser, and it
     split the page on the letter "s" instead — reporting 489 words for a page
     that had 1570 and blaming the page for it. */
  const doc = await ev(`({ path: location.pathname,
    h1: document.querySelector('h1')?.textContent || '',
    words: document.body.innerText.split(/[^A-Za-zÀ-ÿ0-9'’×-]+/).filter(Boolean).length,
    headings: document.querySelectorAll('h2').length,
    paras: document.querySelectorAll('p').length,
    backToGame: !!document.querySelector('nav a[href="/"]'),
    toRules: !!document.querySelector('nav a[href="/regles/"], footer a[href="/regles/"]') })`);
  step(doc.path === '/strategie/', `the click navigated to ${doc.path}`);
  step(doc.words > 1000, `${doc.words} words of readable text on arrival`);
  step(doc.headings >= 6 && doc.paras >= 15,
    `${doc.headings} sections and ${doc.paras} paragraphs actually rendered`);
  step(doc.backToGame && doc.toRules, 'with a way back to the game and across to the rules');
  console.log(`  ...  h1 reads "${doc.h1}"`);
} catch (e) {
  console.error('failed:', e.message);
  failed = true;
} finally {
  spawnSync('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
}

console.log(failed ? '\nFAIL' : '\nPASS — the strategy pages are reachable, in both languages.');
process.exitCode = failed ? 1 : 0;
