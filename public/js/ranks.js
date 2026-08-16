// The ladder. Points come from the server; this file only decides what to call
// a number and which badge to draw next to it.
//
// The gaps widen deliberately. The first three tiers are inside an evening's
// play, because a ladder whose second rung takes a week reads as "you are bad
// at this" to everyone who has just arrived. Above Gold they stretch, because
// by then the rank is the reward and reaching it should mean something.
//
// `key` is an i18n key, never a display string — the badge is read in six
// languages and Persian does not want the word "Bronze".

export const RANKS = [
  { min: 0, key: 'rank_wood', icon: '🟢' },
  { min: 100, key: 'rank_stone', icon: '⚪' },
  { min: 250, key: 'rank_bronze', icon: '🥉' },
  { min: 500, key: 'rank_silver', icon: '🥈' },
  { min: 900, key: 'rank_gold', icon: '🥇' },
  { min: 1400, key: 'rank_platinum', icon: '💎' },
  { min: 2000, key: 'rank_master', icon: '🔷' },
  { min: 2800, key: 'rank_grandmaster', icon: '👑' },
];

// Walks down, so the FIRST tier whose floor is at or below the score wins.
// Anything unexpected — a negative score, a missing one — lands on the bottom
// rung rather than on undefined, because this feeds straight into innerHTML.
export function rankOf(points) {
  const p = Number(points) || 0;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (p >= RANKS[i].min) return RANKS[i];
  }
  return RANKS[0];
}

// The tier above, or null at the top — which is what makes the profile show
// "highest rank" instead of a progress bar that can never fill.
export function nextRank(points) {
  const p = Number(points) || 0;
  return RANKS.find(r => r.min > p) || null;
}

// Did this result move the player between tiers? Used for the win screen, which
// says something quite different when a rank was just gained or lost.
export function rankDelta(before, after) {
  const a = RANKS.indexOf(rankOf(before));
  const b = RANKS.indexOf(rankOf(after));
  return b === a ? 0 : (b > a ? 1 : -1);
}
