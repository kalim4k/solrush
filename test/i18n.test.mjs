// Every key the UI asks for must exist, in every pack. A missing key does not
// throw — it renders the key name into a button — so nothing but a test will
// catch it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import EN from '../public/lang/en.js';
import FR from '../public/lang/fr.js';
import ES from '../public/lang/es.js';
import RU from '../public/lang/ru.js';
import TR from '../public/lang/tr.js';
import FA from '../public/lang/fa.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'public/js/app.js'), 'utf8');
const i18nSrc = readFileSync(join(ROOT, 'public/js/i18n.js'), 'utf8');

// English is the reference; the rest are checked against it.
const PACKS = [[FR, 'fr'], [ES, 'es'], [RU, 'ru'], [TR, 'tr'], [FA, 'fa']];
const ALL = [[EN, 'en'], ...PACKS];

// Keys the markup asks for, via data-i18n / data-i18n-ph.
const htmlKeys = [...html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map(m => m[1]);
/* Keys the code asks for. Two shapes, and the second one was added after the
   first shipped a bug to the screen.

   t('...') is the obvious one. But a key can also be handed to a helper that
   calls t() for you — daysPhrase(n, key) is the one in this codebase — and a
   pattern that only looks for t('key') is blind to it. The streak celebration
   asked daysPhrase for "streak_milestone", a key that existed in no language
   pack at all, and the overlay printed the key name at the player under a
   large "3". Every check passed while it did. */
const codeKeys = [
  ...[...app.matchAll(/\bt\('([a-z0-9_]+)'\)/g)].map(m => m[1]),
  ...[...app.matchAll(/\bdaysPhrase\([^,)]+,\s*'([a-z0-9_]+)'\)/g)].map(m => m[1]),
];

test('every key used in the markup exists in English', () => {
  const missing = [...new Set(htmlKeys)].filter(k => EN[k] === undefined);
  assert.deepEqual(missing, [], 'missing from en.js: ' + missing.join(', '));
});

test('every key used in the code exists in English', () => {
  const missing = [...new Set(codeKeys)].filter(k => EN[k] === undefined);
  assert.deepEqual(missing, [], 'missing from en.js: ' + missing.join(', '));
});

/* A sentence with a hole in it cannot be hung on data-i18n.

   That attribute is filled by one blanket pass that copies the translation into
   the element. It knows nothing about %n or %r, so a string containing one is
   rendered with the placeholder still in it — the celebration overlay showed
   "%n jours d'affilée !" to a player on their third day.

   Anything with a hole has to be built in JS, where the number is known. */
test('no placeholder string is filled by the blanket data-i18n pass', () => {
  const bad = [...new Set(htmlKeys)]
    .filter(k => typeof EN[k] === 'string' && /%[a-z]/.test(EN[k]))
    .map(k => `${k} = "${EN[k]}"`);
  assert.deepEqual(bad, [],
    'these carry a placeholder and must be set from code, not data-i18n:\n  ' + bad.join('\n  '));
});

/* The picker and the loader have to agree.

   This is the bug the language switcher shipped with: LANGS listed six
   languages, AVAILABLE listed two, and loadLang() quietly returned English for
   the other four. setLang() then stored the code and re-rendered — in English.
   No error anywhere, the feature just did nothing. Both lists live in i18n.js
   and are read from the source here so they cannot drift again. */
test('the picker only offers languages that actually load', () => {
  const langs = [...i18nSrc.matchAll(/\{\s*code:\s*'([a-z]{2})'/g)].map(m => m[1]);
  const avail = i18nSrc.match(/const AVAILABLE = new Set\(\[([^\]]+)\]\)/);
  assert.ok(avail, 'could not find AVAILABLE in i18n.js');
  const available = [...avail[1].matchAll(/'([a-z]{2})'/g)].map(m => m[1]);

  assert.ok(langs.length >= 2, 'could not parse LANGS, found ' + langs.length);
  const offeredButUnloadable = langs.filter(c => !available.includes(c));
  assert.deepEqual(offeredButUnloadable, [],
    'the picker offers these but they resolve to English: ' + offeredButUnloadable.join(', '));

  const loadableButHidden = available.filter(c => !langs.includes(c));
  assert.deepEqual(loadableButHidden, [],
    'these packs load but are not in the picker: ' + loadableButHidden.join(', '));

  // And the files have to be the ones the test imported.
  assert.deepEqual([...available].sort(), ALL.map(([, n]) => n).sort(),
    'AVAILABLE does not match the packs this test imports');
});

test('the service worker precaches every language pack', () => {
  // Otherwise the game opens offline in English whatever the player picked.
  const sw = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');
  for (const [, name] of ALL) {
    assert.ok(sw.includes(`'/lang/${name}.js'`), `sw.js does not precache /lang/${name}.js`);
  }
});

test('every pack covers everything English does', () => {
  for (const [pack, name] of PACKS) {
    const missing = Object.keys(EN).filter(k => pack[k] === undefined);
    assert.deepEqual(missing, [], `missing from ${name}.js: ` + missing.join(', '));
  }
});

test('no pack adds a key English does not have', () => {
  // A key in only one pack is a typo in that pack, not a feature.
  for (const [pack, name] of PACKS) {
    const extra = Object.keys(pack).filter(k => EN[k] === undefined);
    assert.deepEqual(extra, [], `not in en.js but in ${name}.js: ` + extra.join(', '));
  }
});

test('placeholders survive translation', () => {
  // A string that loses its %n renders "points to Gold" with no number.
  for (const [pack, name] of PACKS) {
    for (const key of Object.keys(EN)) {
      for (const ph of ['%n', '%u', '%r']) {
        if (String(EN[key]).includes(ph)) {
          assert.ok(String(pack[key]).includes(ph), `${name}.js "${key}" dropped ${ph}`);
        }
      }
    }
  }
});

test('no value is left empty', () => {
  for (const [pack, name] of ALL) {
    for (const [k, v] of Object.entries(pack)) {
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${name}.js "${k}" is empty`);
    }
  }
});

/* Keys the code BUILDS rather than writes out.

   This is the hole the footer fell through. The handler does
   `t(a.dataset.legal + '_title')`, so the literal string "rules_title" appears
   nowhere in the source, the two tests above saw nothing missing, and all four
   documents shipped as the words "rules_title" and "rules_body" printed into
   the dialog. Anything assembled at runtime has to be enumerated here by hand,
   from the same source the code reads it from. */

const legalDocs = [...new Set([...html.matchAll(/data-legal="([^"]+)"/g)].map(m => m[1]))];

test('every legal document named in the markup exists in every pack', () => {
  assert.ok(legalDocs.length >= 4, 'expected the four footer links, found ' + legalDocs.length);
  const missing = [];
  for (const doc of legalDocs) {
    for (const suffix of ['_title', '_body']) {
      for (const [pack, name] of ALL) {
        if (!pack[doc + suffix]) missing.push(`${name}.js: ${doc}${suffix}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'missing: ' + missing.join(', '));
});

test('legal documents are real documents, not placeholders', () => {
  // A key that exists but holds two words is the same failure with extra steps.
  for (const doc of legalDocs) {
    for (const [pack, name] of ALL) {
      const body = pack[doc + '_body'];
      assert.ok(body.length > 400, `${name}.js ${doc}_body is only ${body.length} chars`);
      assert.ok(body.includes('## '), `${name}.js ${doc}_body has no headings`);
    }
  }
});

test('every rank name has a translation in every pack', () => {
  // rankOf() returns a key, and the profile renders t(key) straight into the page.
  const ranks = readFileSync(join(ROOT, 'public/js/ranks.js'), 'utf8');
  const keys = [...ranks.matchAll(/key:\s*'([a-z0-9_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 8, 'expected the rank ladder, found ' + keys.length);
  for (const k of keys) {
    for (const [pack, name] of ALL) assert.ok(pack[k], `${name}.js is missing ${k}`);
  }
});

test('every nickname rejection reason has a message in every pack', () => {
  // checkNick returns a reason code that becomes t('err_' + code).
  const nick = readFileSync(join(ROOT, 'public/js/nick.js'), 'utf8');
  const codes = [...nick.matchAll(/return '(nick_[a-z]+)'/g)].map(m => m[1]);
  assert.ok(codes.length >= 4, 'expected the nick reason codes, found ' + codes.length);
  for (const c of codes) {
    // short/long/chars/spam all collapse onto the one "bad" message
    const key = /^nick_(short|long|chars|spam)$/.test(c) ? 'err_nick_bad' : 'err_' + c;
    for (const [pack, name] of ALL) assert.ok(pack[key], `${name}.js is missing ${key} (for ${c})`);
  }
});

test('the plural unit words exist wherever a count is rendered', () => {
  // plural() returns one | few | many and the caller looks up 'day_' + that.
  for (const [pack, name] of ALL) {
    for (const form of ['day_one', 'day_few', 'day_many']) {
      assert.ok(pack[form], `${name}.js is missing ${form}`);
    }
  }
});

/* Hand-written packs pick up hand-written mistakes, and a wrong letter in a
   script you do not read is invisible on review. Two got through the first
   draft of ru.js: a half-Latin "partию", and a stray CJK character sitting in
   the middle of a Russian sentence. Both render as garbage rather than failing,
   so they would have shipped. */

test('no pack contains stray CJK characters', () => {
  for (const [pack, name] of ALL) {
    for (const [k, v] of Object.entries(pack)) {
      const hit = String(v).match(/[぀-ヿ一-鿿]/);
      assert.ok(!hit, `${name}.js "${k}" contains a CJK character: ${JSON.stringify(hit?.[0])}`);
    }
  }
});

test('no word mixes Latin and Cyrillic letters', () => {
  // Legitimate Latin words (scrypt, Neon, Postgres, SolRush, the contact
  // address) stand alone; only a letter touching a Cyrillic letter is wrong.
  for (const [pack, name] of ALL) {
    for (const [k, v] of Object.entries(pack)) {
      const hit = String(v).match(/[Ѐ-ӿ][A-Za-z]|[A-Za-z][Ѐ-ӿ]/);
      assert.ok(!hit, `${name}.js "${k}" mixes scripts inside a word: ${JSON.stringify(hit?.[0])}`);
    }
  }
});

test('each pack is actually written in its own script', () => {
  // Catches a pack copy-pasted from another and half-translated.
  const expect = {
    ru: /[Ѐ-ӿ]/,          // Cyrillic
    fa: /[؀-ۿ]/,          // Arabic script
    tr: /[çğıöşüÇĞİÖŞÜ]/,           // Turkish-specific letters
    es: /[áéíóúñ¿¡]/,               // Spanish-specific
    fr: /[àâçéèêëîïôùûü]/,          // French-specific
  };
  for (const [pack, name] of ALL) {
    if (!expect[name]) continue;
    const sample = Object.values(pack).join(' ');
    assert.match(sample, expect[name], `${name}.js does not look like ${name}`);
  }
});
