// The daily streak, client side. The count itself lives on the server — this
// file is only about how it looks: which flame, and which days are worth a
// celebration.
//
// The tiers exist so the flame changes on its own. A number that only goes up
// stops being noticed around day four; a flame that visibly turns from orange
// to blue at day thirty is a thing players screenshot.
//
// `cls` matches the .fl-* rules in style.css. Adding a tier here without adding
// the rule there gives an unstyled flame, not an error, so the two lists have
// to be changed together.

export const FLAMES = [
  { min: 1, cls: 'fl-1' },
  { min: 7, cls: 'fl-7' },
  { min: 30, cls: 'fl-30' },
  { min: 50, cls: 'fl-50' },
  { min: 100, cls: 'fl-100' },
  { min: 200, cls: 'fl-200' },
  { min: 365, cls: 'fl-365' },
];

// Days worth interrupting the player for. Close together at the start, where
// the habit is still forming, then rare enough to stay special.
// Kept identical to the list in server/streak.js — the server decides that a
// milestone happened, this decides what it looks like, and the two disagreeing
// means a celebration that fires with no banner or a banner with no reason.
export const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

// Day 0 has no flame of its own; it borrows the first tier and is drawn with
// the extra "unlit" class by the caller.
export function flameClass(days) {
  const d = Number(days) || 0;
  let cls = FLAMES[0].cls;
  for (const f of FLAMES) if (d >= f.min) cls = f.cls;
  return cls;
}

export function isMilestone(days) {
  return MILESTONES.includes(Number(days) || 0);
}

// The next thing to aim for, or null once every milestone is behind them.
export function nextMilestone(days) {
  const d = Number(days) || 0;
  return MILESTONES.find(m => m > d) ?? null;
}
