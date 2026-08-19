// The service worker sits in front of every file the game loads, so a mistake
// here does not break the app — it freezes it. The page keeps working perfectly
// while serving last week's stylesheet, and no amount of reloading, version
// bumping or hard-refreshing changes that. Both bugs it caused were reported as
// "the fix didn't work", which is the most expensive way to find out.
//
// The real proof is scripts/warm-reload-check.mjs, which drives a browser
// through two visits with a file edited in between. It needs a running server
// and Chrome, so these cheap static guards pin the two decisions that matter in
// the meantime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sw = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');

test('subresources go to the network before the cache', () => {
  // Cache-first is what froze returning players on old files. The cache is the
  // offline fallback, not the source of truth.
  assert.match(sw, /e\.respondWith\(freshFirst\(req\)\)/,
    'the subresource handler should hand straight to freshFirst()');
  assert.doesNotMatch(sw, /e\.respondWith\(\s*caches\.match/,
    'respondWith must not start from caches.match — that is cache-first again');
});

test('ignoreSearch is only ever used on the offline fallback', () => {
  /* ignoreSearch on the primary path is the specific combination that broke
     things: it makes the cached "/css/style.css" answer a request for
     "/css/style.css?v=123", so bumping the version silently stops working.
     Offline it is correct and necessary — an approximate match beats no page. */
  for (const m of sw.matchAll(/ignoreSearch/g)) {
    const before = sw.slice(0, m.index);
    const lastCatch = before.lastIndexOf('catch');
    const lastTry = before.lastIndexOf('try {');
    assert.ok(lastCatch > lastTry && lastCatch !== -1,
      'ignoreSearch appears outside a catch block — it must be fallback-only');
  }
});

test('the precache bypasses the HTTP cache', () => {
  // A plain addAll() reads through the HTTP cache and will happily refill a new
  // cache from entries the old immutable headers pinned for a year.
  assert.match(sw, /cache:\s*'reload'/,
    "precache requests need cache: 'reload' or they inherit stale HTTP entries");
});

test('a failed precache still lets the new worker take over', () => {
  // Rejecting install leaves the OLD worker in control serving OLD files, for
  // good. Degraded offline beats a site frozen in the past.
  const install = sw.slice(sw.indexOf("addEventListener('install'"), sw.indexOf("addEventListener('activate'"));
  assert.ok(install.includes('catch'), 'install must swallow precache failure');
  const catchAt = install.indexOf('catch');
  assert.ok(install.indexOf('skipWaiting') > catchAt,
    'skipWaiting must run after the catch, not inside the success chain');
});

test('every precached shell file is a file that exists', () => {
  // addAll is all-or-nothing; one stale path degrades offline for everyone.
  const list = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const paths = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(p => p !== '/');
  assert.ok(paths.length >= 10, 'expected the shell list, found ' + paths.length);
  for (const p of paths) {
    const onDisk = join(ROOT, 'public', p.replace(/^\//, ''));
    assert.ok(readFileSync(onDisk).length > 0, `SHELL lists ${p} but it is empty or missing`);
  }
});

test('the cache name was bumped past the versions that shipped broken', () => {
  const m = sw.match(/const CACHE = 'solrush-v(\d+)'/);
  assert.ok(m, 'CACHE should be a numbered solrush-vN name');
  assert.ok(Number(m[1]) >= 4, `cache is v${m[1]}; v1-v3 shipped the cache-first bug`);
});

test('index.html is valid UTF-8 with no byte-order mark', () => {
  /* A PowerShell round-trip through Get-Content/Set-Content decoded this file
     as Windows-1252 and re-encoded it as UTF-8, turning every emoji into
     mojibake and prepending a BOM. Cheap to check, and it stays broken until
     someone notices the reactions are question marks. */
  const raw = readFileSync(join(ROOT, 'public/index.html'));
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'index.html starts with a BOM');
  assert.doesNotThrow(() => new TextDecoder('utf8', { fatal: true }).decode(raw),
    'index.html is not valid UTF-8');
  assert.doesNotMatch(html, /[Â-Ã][-¿]/,
    'index.html contains mojibake (UTF-8 read as Windows-1252)');
});

/* A navigation is not always the game.

   Every navigate response used to be stored under "/index.html", the key the
   offline fallback reads. The rules pages are real documents at their own
   addresses, so a player who read them once, online, had their offline shell
   quietly replaced by a page of prose — and the next time they opened the game
   without a signal there was no board on it. Nothing in a clean profile shows
   this, and it only became reachable when the footer started linking to those
   documents at all. */
test('only the game shell is stored as the game shell', () => {
  const nav = sw.slice(sw.indexOf("req.mode === 'navigate'"));
  const put = nav.slice(0, nav.indexOf('freshFirst'));
  assert.match(put, /if\s*\(\s*shell[^)]*\)/,
    'the navigate branch must decide whether the response IS the shell before caching it as one');
  assert.match(sw, /const DOCS = \/\^/,
    'the standalone documents have to be named somewhere for that decision to be possible');
});

/* Naming them by hand is a list that goes stale the moment a document is
   added, and going stale means the new page silently overwrites the offline
   game again. So the list is checked against what is actually on disk rather
   than against a copy of itself. */
test('every standalone document is known to the service worker', () => {
  const docs = readdirSync(join(ROOT, 'public'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(ROOT, 'public', d.name, 'index.html')))
    .map((d) => d.name);

  assert.ok(docs.length >= 4, 'expected the rules and strategy documents to be found');

  const DOCS = new RegExp(sw.match(/const DOCS = (\/.+\/);/)[1].slice(1, -1));
  for (const d of docs) {
    assert.ok(DOCS.test('/' + d + '/'),
      `/${d}/ is a document but the worker would cache it as the game shell, `
      + 'which replaces the board with a page of prose for anyone offline');
  }
});

test('the standalone rules pages are reachable from the game', () => {
  // Orphaned pages are crawled as an afterthought and found by no player. These
  // two are the only documents on the site that can be read without running any
  // script, which is the whole reason they exist.
  assert.match(html, /<a[^>]*data-legal="rules"[^>]*href="\/rules\/"/,
    'the footer Rules link must carry a real address, not just an overlay handler');
});
