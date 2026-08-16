// The AI opponent. Pure function of the position — no state of its own — so the
// same call runs on the main thread, inside the Web Worker, or on the server.
//
// It sees the board as two numbers: how many steps each player still needs.
// Everything else (which wall, which direction) falls out of trying a move and
// asking those two numbers again.

import {
  cloneState, applyMove, pawnMoves, canPlaceWall, goalRow,
  colsOf, rowsOf, buildBlocks, distToGoalB,
} from './engine.js';

const WIN = 100000;
const INF = 1e9;

/* Four opponents, and the difference between them is mostly honesty.

   Depth is what makes a bot strong, but a bot that is merely shallow plays
   *badly* in a recognisable way — it wanders. A beginner wants an opponent who
   plays sensibly and then lets something through, which is what blunder does:
   the search runs properly, and the answer is sometimes discarded for the
   second-best move. That reads as a human being careless rather than a machine
   being stupid.

   wallRate keeps the easy levels from discovering the one move that ends a
   beginner's game on the spot: a wall dropped in front of a pawn with nine
   steps to go and no idea walls could do that. */
const LEVELS = {
  easy: { depth: 1, blunder: 0.45, wallRate: 0.12, ms: 150, cand: 8 },
  normal: { depth: 2, blunder: 0.18, wallRate: 0.50, ms: 400, cand: 14 },
  hard: { depth: 3, blunder: 0.03, wallRate: 1.00, ms: 1200, cand: 22 },
  hardcore: { depth: 5, blunder: 0.00, wallRate: 1.00, ms: 2500, cand: 32 },
};

/* ================= reading the position ================= */

// Steps remaining for player p, walls only — pawns are ignored, so this is a
// lower bound. That is the right bound to use: the opponent's body is a
// one-turn obstacle, and treating it as permanent makes the AI fear pawns.
function pathLen(B, state, p) {
  const dist = distToGoalB(B, goalRow(p, state));
  const pw = state.pawns[p];
  return dist[pw.r * B.cols + pw.c];
}

// Score from `me`'s point of view. Steps dominate; spare walls are worth
// something but never enough to justify falling a step behind, which is why the
// two weights are ten and two rather than anything closer.
function evaluate(state, me) {
  const B = buildBlocks(state.walls, colsOf(state), rowsOf(state));
  const myD = pathLen(B, state, me);
  const opD = pathLen(B, state, 1 - me);
  if (myD < 0) return -WIN;   // sealed off; canPlaceWall should never allow it
  if (opD < 0) return WIN;
  let s = (opD - myD) * 10 + (state.left[me] - state.left[1 - me]) * 2;
  // Being to move is worth about a third of a step. Without it the search
  // happily trades into equal-distance positions where it is a tempo down.
  if (state.turn === me) s += 3;
  return s;
}

/* ================= which moves are worth trying ================= */

// The cells the pawn actually walks through, by stepping downhill through the
// distance map. Wall candidates are grown from this: a wall nowhere near either
// route cannot change the score, and there are 128 of them on an empty board.
function routeCells(B, state, p) {
  const dist = distToGoalB(B, goalRow(p, state));
  const { cols, rows } = B;
  let { r, c } = state.pawns[p];
  const cells = [{ r, c }];
  let d = dist[r * cols + c];
  let guard = rows * cols;
  while (d > 0 && guard-- > 0) {
    let nextR = -1, nextC = -1;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nd = dist[nr * cols + nc];
      if (nd !== d - 1) continue;
      if (r === nr) { if (B.vBlk[r * (cols - 1) + Math.min(c, nc)]) continue; }
      else if (B.hBlk[Math.min(r, nr) * cols + c]) continue;
      nextR = nr; nextC = nc;
      break;
    }
    if (nextR < 0) break;
    r = nextR; c = nextC; d--;
    cells.push({ r, c });
  }
  return cells;
}

// Every wall slot touching a cell on the given route, both orientations.
function wallsAround(cells, cols, rows) {
  const seen = new Set();
  const out = [];
  for (const { r, c } of cells) {
    for (let wr = r - 1; wr <= r; wr++) {
      for (let wc = c - 1; wc <= c; wc++) {
        if (wr < 0 || wr > rows - 2 || wc < 0 || wc > cols - 2) continue;
        for (const o of ['h', 'v']) {
          const key = wr + ',' + wc + ',' + o;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ type: 'wall', r: wr, c: wc, o });
        }
      }
    }
  }
  return out;
}

/* Moves to search, best-looking first — alpha-beta is only as good as its
   ordering, and a shortest-path-first list prunes most of the tree at once.

   Walls are scored by what they actually buy: how many steps they add to the
   opponent minus how many they add to me. A wall that lengthens both routes
   equally is a wasted wall, and this is what notices that. */
function genMoves(state, me, cfg, forRoot) {
  const cols = colsOf(state), rows = rowsOf(state);
  const p = state.turn;
  const B = buildBlocks(state.walls, cols, rows);
  const myGoalDist = distToGoalB(B, goalRow(p, state));

  const pawns = pawnMoves(state, p)
    .map(m => ({
      mv: { type: 'pawn', r: m.r, c: m.c },
      // the move that most reduces my remaining distance comes first
      score: -(myGoalDist[m.r * cols + m.c] ?? 999),
    }))
    .sort((a, b) => b.score - a.score);

  const out = pawns.map(x => x.mv);

  const wallsAllowed = state.left[p] > 0 && (forRoot ? Math.random() < cfg.wallRate : true);
  if (!wallsAllowed) return out;

  const baseMine = pathLen(B, state, p);
  const baseOpp = pathLen(B, state, 1 - p);

  const cand = wallsAround(routeCells(B, state, 1 - p), cols, rows);
  const scored = [];
  for (const w of cand) {
    if (!canPlaceWall(state, p, w)) continue;
    const B2 = buildBlocks([...state.walls, w], cols, rows);
    const oppAfter = pathLen(B2, state, 1 - p);
    const mineAfter = pathLen(B2, state, p);
    if (oppAfter < 0 || mineAfter < 0) continue;
    const gain = (oppAfter - baseOpp) - (mineAfter - baseMine);
    if (gain <= 0) continue;             // costs a wall, changes nothing
    scored.push({ mv: w, gain });
  }
  scored.sort((a, b) => b.gain - a.gain);
  for (const s of scored.slice(0, cfg.cand)) out.push(s.mv);
  return out;
}

/* ================= search ================= */

function minimax(state, me, depth, alpha, beta, cfg, deadline) {
  if (state.winner !== null) {
    // +depth so a win found sooner outranks the same win found later, and a
    // loss is postponed as long as possible instead of being walked into
    return state.winner === me ? WIN + depth : -WIN - depth;
  }
  if (depth <= 0) return evaluate(state, me);
  if (Date.now() > deadline) return evaluate(state, me);

  const maxing = state.turn === me;
  const moves = genMoves(state, me, cfg, false);
  if (!moves.length) return evaluate(state, me);

  let best = maxing ? -INF : INF;
  for (const mv of moves) {
    const ns = cloneState(state);
    if (!applyMove(ns, mv)) continue;
    const v = minimax(ns, me, depth - 1, alpha, beta, cfg, deadline);
    if (maxing) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;           // this branch is already refuted
  }
  return best === (maxing ? -INF : INF) ? evaluate(state, me) : best;
}

/* ================= entry point ================= */

// aiMove(state, level, opts) -> {type:'pawn',r,c} | {type:'wall',r,c,o} | null
// opts.ms overrides the level's thinking time (the worker passes the time the
// clock can actually spare).
export function aiMove(state, level = 'normal', opts = {}) {
  const cfg = LEVELS[level] || LEVELS.normal;
  const me = state.turn;
  if (state.winner !== null) return null;

  const budget = Number(opts.ms) > 0 ? Number(opts.ms) : cfg.ms;
  const deadline = Date.now() + budget;

  const moves = genMoves(state, me, cfg, true);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];

  /* Iterative deepening: search one ply, then two, keeping the last completed
     answer. The clock can stop this at any moment and there is always a finished
     result to hand back — searching straight to depth 5 and running out of time
     leaves nothing at all. */
  let best = moves[0], bestScore = -INF;
  let ranked = moves.map(mv => ({ mv, score: -INF }));

  for (let d = 1; d <= cfg.depth; d++) {
    let alpha = -INF;
    let localBest = null, localScore = -INF;
    let completed = true;

    for (const entry of ranked) {
      if (Date.now() > deadline) { completed = false; break; }
      const ns = cloneState(state);
      if (!applyMove(ns, entry.mv)) { entry.score = -INF; continue; }
      const v = minimax(ns, me, d - 1, alpha, INF, cfg, deadline);
      entry.score = v;
      if (v > localScore) { localScore = v; localBest = entry.mv; }
      if (v > alpha) alpha = v;
    }

    if (localBest && completed) {
      best = localBest;
      bestScore = localScore;
      // feed this depth's ordering into the next one — the whole point of ID
      ranked.sort((a, b) => b.score - a.score);
    }
    if (!completed || bestScore >= WIN) break;
  }

  /* The deliberate mistake. Second-best, not random: a beginner's opponent
     should still be walking towards the goal when it errs, and a random legal
     move on a Quoridor board looks like a bug rather than a weaker player. */
  if (cfg.blunder > 0 && Math.random() < cfg.blunder) {
    const alt = ranked.filter(e => e.mv !== best && e.score > -INF);
    if (alt.length) return alt[Math.floor(Math.random() * Math.min(3, alt.length))].mv;
  }
  return best;
}

export { LEVELS };
