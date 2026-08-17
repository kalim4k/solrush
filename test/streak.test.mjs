// What the flame is allowed to say.
//
// The regression this exists for: the client read one field, streakLost, for
// two different questions — "what broke?" and "what can they buy back?".
// streakLost is deliberately gated at three days, because offering to restore
// one day is a joke. So a two-day streak breaking answered 0 to both, and the
// flame disappeared from the home screen without a word. The player who had
// come back two days running saw the counter simply cease to exist, which is
// the exact reading the flame was built to prevent.
//
// view() is pure — a row and a timezone in, the numbers out — so it can be
// checked directly. The Pool in db.js is created on import but never dialled.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://user:pw@localhost:5432/none';

const { view } = await import('../server/streak.js');

// A row as the database holds one. Days are compared as local dates, so these
// are built from today rather than hard-coded.
function rowFrom(daysAgo, length, best = length) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return { id: 1, days: length, best, last_day: d.toISOString().slice(0, 10), free_used_month: null };
}

test('a streak extended today is alive and has nothing broken', () => {
  const v = view(rowFrom(0, 4), 0);
  assert.equal(v.streakState, 'today');
  assert.equal(v.streak, 4);
  assert.equal(v.streakBroken, 0);
  assert.equal(v.streakLost, 0);
});

test('a streak last played yesterday is at risk, not broken', () => {
  const v = view(rowFrom(1, 4), 0);
  assert.equal(v.streakState, 'risk');
  assert.equal(v.streak, 4, 'the days are still the player\'s until midnight passes');
  assert.equal(v.streakBroken, 0);
});

test('a SHORT broken streak is still reported as broken', () => {
  // The regression, stated as a test. Two days is under MIN_RESTORE_DAYS, so
  // there is nothing to sell back — but there is certainly something to show.
  const v = view(rowFrom(2, 2), 0);
  assert.equal(v.streakState, 'lost');
  assert.equal(v.streak, 0);
  assert.equal(v.streakBroken, 2, 'the flame needs a number to keep showing');
  assert.equal(v.streakLost, 0, 'and still nothing worth offering to restore');
});

test('a long broken streak is both shown and offered back', () => {
  const v = view(rowFrom(2, 6), 0);
  assert.equal(v.streakBroken, 6);
  assert.equal(v.streakLost, 6);
});

test('a break older than the restore window is shown but not offered', () => {
  // Past the window the offer lapses. The number does not: a player opening the
  // game after a month should still be told what they had, not shown a blank.
  const v = view(rowFrom(30, 9), 0);
  assert.equal(v.streakState, 'lost');
  assert.equal(v.streakBroken, 9);
  assert.equal(v.streakLost, 0);
});

test('a player who has never finished a game has nothing at all', () => {
  const v = view({ id: 1, days: 0, best: 0, last_day: null, free_used_month: null }, 0);
  assert.equal(v.streakState, 'none');
  assert.equal(v.streak, 0);
  assert.equal(v.streakBroken, 0);
  assert.equal(v.streakLost, 0);
});

test('the free monthly restore is spent only for the month it was used in', () => {
  const now = new Date();
  const thisMonth = { ...rowFrom(2, 5), free_used_month: now.toISOString().slice(0, 10) };
  assert.equal(view(thisMonth, 0).streakFree, false);

  const old = new Date(now);
  old.setUTCMonth(old.getUTCMonth() - 1);
  const lastMonth = { ...rowFrom(2, 5), free_used_month: old.toISOString().slice(0, 10) };
  assert.equal(view(lastMonth, 0).streakFree, true);
});
