// The version in the asset URLs has to move when the assets do.
//
// This exists because of a bug that shipped and looked, from a fresh browser,
// completely fine.
//
// index.html asks for css/style.css?v=N and js/app.js?v=N. The server treats a
// versioned URL as a promise that those exact bytes will never change, and
// sends `immutable, max-age=31536000` — a one-year lease during which the
// browser does not so much as ask again. index.html itself is sent `no-cache`.
//
// So editing app.js or style.css WITHOUT moving N hands a returning visitor
// today's markup with last week's script and last week's stylesheet. New
// elements appear in the page with no code to fill them and no rules to size
// them, which reads as "nothing is displayed" — while every check run in a
// clean profile passes, because a clean profile holds no lease.
//
// A test cannot see the previous commit, so it does the next best thing: it
// pins the CONTENT. Change either file and this fails, and the only way to make
// it pass is to bump the version and record the new hash — which is exactly the
// step that was forgotten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The files served under a ?v= lease, in a fixed order.
const VERSIONED = ['public/js/app.js', 'public/css/style.css'];

/* Bump BOTH of these together, or neither.
   1. change ?v= in public/index.html
   2. put the new hash here (the failure message prints it) */
const ASSET_VERSION = 146;
const ASSET_HASH = '431e9dc456e449ace56131ae8b2879be47f4199dea240030f2f2c205e9658238';

test('the versioned assets have not changed without a version bump', () => {
  const h = createHash('sha256');
  for (const f of VERSIONED) h.update(readFileSync(join(ROOT, f)));
  const actual = h.digest('hex');

  assert.equal(actual, ASSET_HASH,
    `app.js or style.css changed.\n`
    + `  Returning visitors hold "${ASSET_VERSION}" under a one-year immutable\n`
    + `  lease and will not see this edit until the URL changes.\n`
    + `  1. set ?v=${ASSET_VERSION + 1} in public/index.html (both places)\n`
    + `  2. set ASSET_VERSION = ${ASSET_VERSION + 1} and ASSET_HASH = '${actual}' here`);
});

test('the markup asks for the version this test is pinned to', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  const asked = [...html.matchAll(/\?v=(\d+)/g)].map((m) => Number(m[1]));

  assert.ok(asked.length >= 2, 'index.html should request both versioned assets with ?v=');
  for (const v of asked) {
    assert.equal(v, ASSET_VERSION,
      `index.html asks for ?v=${v} but this test is pinned to ${ASSET_VERSION}`);
  }
});

test('every ?v= in the markup is the same number', () => {
  // The stylesheet and the script were bumped separately once, which left the
  // page loading a new script against an old stylesheet — the same failure,
  // half the size, and harder to spot because most of the page looked right.
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  const asked = new Set([...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]));
  assert.equal(asked.size, 1, `mixed asset versions in index.html: ${[...asked].join(', ')}`);
});
