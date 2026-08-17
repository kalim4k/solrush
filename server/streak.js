// The daily streak — the reason to come back tomorrow.
//
// Two rules decide everything: a day counts once, and a gap of more than one day
// breaks it. Everything below is those two rules plus the wording problem: "4
// days" shown to somebody who missed yesterday reads as a broken counter, so the
// state is named and the client picks its sentence from the name.
//
// Guests have streaks too, keyed by device. Logging in later carries it over,
// because losing a nine-day streak by creating an account is the worst possible
// moment to ask someone to create an account.

import { one, q } from './db.js';

// Days are counted in the player's own timezone. The server is in UTC and the
// player may not be: without this, someone in Tehran playing at 2am loses a
// streak they extended twenty minutes ago.
function localDay(tzOffsetMin = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() - tzOffsetMin * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

// Below this there is nothing worth buying back: "get 1 day back" reads as a
// joke, and the day is quicker to replay than to think about.
const MIN_RESTORE_DAYS = 3;
// After a week the streak is not a lapse, it is a different era.
const RESTORE_WINDOW_DAYS = 7;

async function load(owner) {
  const where = owner.userId ? 'user_id = $1' : 'device_id = $1';
  const key = owner.userId || owner.deviceId;
  let row = await one(`SELECT * FROM streaks WHERE ${where}`, [key]);
  if (!row) {
    row = await one(
      owner.userId
        ? `INSERT INTO streaks (user_id) VALUES ($1) RETURNING *`
        : `INSERT INTO streaks (device_id) VALUES ($1) RETURNING *`,
      [key],
    );
  }
  return row;
}

// Exported for the tests. Everything interesting about a streak is decided
// here, from a row and a clock, with no database in the way.
export function view(row, tzOffsetMin) {
  const today = localDay(tzOffsetMin);
  const last = row.last_day ? new Date(row.last_day).toISOString().slice(0, 10) : null;
  const gap = last ? daysBetween(last, today) : null;

  let state = 'none', days = row.days, lost = 0;
  if (!last || row.days === 0) {
    state = 'none';
  } else if (gap === 0) {
    state = 'today';               // already extended; nothing at stake
  } else if (gap === 1) {
    state = 'risk';                // alive, but today has not counted yet
  } else {
    state = 'lost';
    lost = row.days;               // what a restore would hand back
    days = 0;
  }

  const freeMonth = row.free_used_month
    ? new Date(row.free_used_month).toISOString().slice(0, 7)
    : null;
  const free = freeMonth !== today.slice(0, 7);

  return {
    streak: days,
    streakBest: row.best,
    streakToday: state === 'today',
    streakState: state,
    /* What just broke, whatever its size — separate from what is worth selling
       back. The client used to read the offer below for both, so a two-day
       streak breaking made the flame vanish from the home screen with no word
       of explanation, which is precisely the "the count has been lost" reading
       the flame is supposed to prevent. A streak too short to buy back should
       still be visible; it just has nothing to tap. */
    streakBroken: state === 'lost' ? lost : 0,
    // only offered when it is both recent enough and big enough to matter
    streakLost: (state === 'lost' && lost >= MIN_RESTORE_DAYS
      && gap <= RESTORE_WINDOW_DAYS + 1) ? lost : 0,
    streakFree: free,
  };
}

export async function getStreak(owner, tzOffsetMin = 0) {
  return view(await load(owner), tzOffsetMin);
}

// Called when a match finishes. Returns the view plus what just changed, so the
// client knows whether to play the flame animation.
export async function touchStreak(owner, tzOffsetMin = 0) {
  const row = await load(owner);
  const today = localDay(tzOffsetMin);
  const last = row.last_day ? new Date(row.last_day).toISOString().slice(0, 10) : null;
  const gap = last ? daysBetween(last, today) : null;

  let days;
  if (gap === 0) {
    return { ...view(row, tzOffsetMin), advanced: false };   // already counted today
  } else if (gap === 1) {
    days = row.days + 1;
  } else {
    days = 1;                                                // fresh start
  }

  const updated = await one(
    `UPDATE streaks SET days = $2, best = GREATEST(best, $2), last_day = $3
      WHERE id = $1 RETURNING *`,
    [row.id, days, today],
  );
  return {
    ...view(updated, tzOffsetMin),
    advanced: true,
    milestone: [3, 7, 14, 30, 50, 100, 200, 365].includes(days) ? days : 0,
  };
}

// Buy a broken streak back: one free restore per calendar month, otherwise the
// client has to have watched an ad (which it confirms by calling with paid).
export async function restoreStreak(owner, tzOffsetMin = 0, paid = false) {
  const row = await load(owner);
  const v = view(row, tzOffsetMin);
  if (v.streakLost <= 0) return { error: 'nothing_to_restore' };

  const today = localDay(tzOffsetMin);
  if (!paid && !v.streakFree) return { error: 'no_free_restore' };

  // Restoring sets last_day to today, so the restored streak is also extended —
  // otherwise it breaks again at midnight and the restore bought nothing.
  const updated = await one(
    `UPDATE streaks
        SET days = $2, best = GREATEST(best, $2), last_day = $3,
            free_used_month = CASE WHEN $4 THEN free_used_month ELSE $3::date END
      WHERE id = $1 RETURNING *`,
    [row.id, v.streakLost + 1, today, paid],
  );
  return { ok: true, ...view(updated, tzOffsetMin) };
}

// Logging in on a device that has a guest streak: keep the better of the two.
export async function mergeDeviceStreak(userId, deviceId) {
  if (!userId || !deviceId) return;
  const dev = await one('SELECT * FROM streaks WHERE device_id = $1', [deviceId]);
  if (!dev || dev.days === 0) return;
  const usr = await load({ userId });
  if (dev.days > usr.days || dev.best > usr.best) {
    await q(
      `UPDATE streaks
          SET days = GREATEST(days, $2), best = GREATEST(best, $3),
              last_day = GREATEST(COALESCE(last_day, '1970-01-01'::date), $4::date)
        WHERE id = $1`,
      [usr.id, dev.days, dev.best, dev.last_day],
    );
  }
}

export { MIN_RESTORE_DAYS };
