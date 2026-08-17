// The victory signature runs between the last move and the result screen, on
// both players' devices, and the loser is one of them. Two things about it are
// promises rather than preferences, and both are checked here.
//
//   1. It is short. Every millisecond is a millisecond somebody who just lost
//      waits to find out what it cost them.
//   2. It animates transform and opacity and nothing else. Those are the two
//      properties the compositor owns; anything else repaints the board every
//      frame, and a celebration that stutters on a cheap Android is worse than
//      no celebration at all — it makes the game look broken at the exact
//      moment the player is deciding whether to pay for it.
//
// The second one is the reason this file exists. It is invisible in every
// screenshot, invisible in a headless run on a desktop GPU, and obvious on the
// phones most of these players actually own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FINISHES, DEFAULT_FINISH, resolveFinish } from '../public/js/cosmetics.js';
import { FINISH_MS, FINISH_TINT, FINISH_GLYPH } from '../public/js/finish.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'public/css/style.css'), 'utf8');

test('every finish in the catalogue can actually be played', () => {
  for (const f of FINISHES) {
    assert.ok(f.id in FINISH_MS, `${f.id} has no duration`);
    assert.ok(f.id in FINISH_TINT, `${f.id} has no colour`);
    assert.ok(f.id in FINISH_GLYPH, `${f.id} has nothing to draw in the picker`);
  }
});

test('nobody waits more than a second and a half for their own result', () => {
  for (const [id, ms] of Object.entries(FINISH_MS)) {
    assert.ok(ms <= 1500, `${id} holds the result screen for ${ms}ms`);
  }
});

test('the free finish is the one that costs no time', () => {
  const free = FINISHES.filter((f) => f.free);
  assert.equal(free.length, 1);
  assert.equal(free[0].id, DEFAULT_FINISH);
  // A free player must never be made to sit through anything, and must never
  // find their own result screen slower than it was before any of this existed.
  assert.equal(FINISH_MS[DEFAULT_FINISH], 0);
});

test('a paid finish falls back to the free one without Plus', () => {
  assert.equal(resolveFinish('stamp', false), DEFAULT_FINISH);
  assert.equal(resolveFinish('stamp', true), 'stamp');
  assert.equal(resolveFinish('not-a-finish', true), DEFAULT_FINISH);
  assert.equal(resolveFinish(undefined, true), DEFAULT_FINISH);
});

test('the finish keyframes animate only transform and opacity', () => {
  const allowed = new Set(['transform', 'opacity', 'animation-timing-function']);
  const names = [...css.matchAll(/@keyframes\s+(fin[A-Za-z]*)\s*\{/g)];
  assert.ok(names.length >= 5, 'the finish keyframes are missing from the stylesheet');

  for (const m of names) {
    // brace-match from the opening brace, because the steps are nested blocks
    let depth = 0, i = m.index + m[0].length - 1, end = -1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { end = i; break; }
    }
    assert.ok(end > 0, `unbalanced braces in @keyframes ${m[1]}`);

    const body = css.slice(m.index + m[0].length, end);
    for (const decl of body.matchAll(/([a-z-]+)\s*:/g)) {
      assert.ok(allowed.has(decl[1]),
        `@keyframes ${m[1]} animates "${decl[1]}" — only transform and opacity `
        + 'stay on the compositor; anything else repaints the board every frame');
    }
  }
});
