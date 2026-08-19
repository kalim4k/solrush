// Quoridor game engine. Shared verbatim between the browser and the Node server —
// the server re-runs every move through applyMove() and is the only authority on
// the result, so this file must never trust its own caller.
//
// Two modes:
//   duel (classic): 9x9, players start on opposite sides and race to the other
//     side; 10 walls each.
//   race: 9x13, BOTH players start on the bottom row and race to the top row;
//     15 walls each.
//
// Walls are {r, c, o} with r in 0..rows-2, c in 0..cols-2.
//   o='h' — horizontal wall between rows r and r+1, spanning columns c and c+1
//   o='v' — vertical wall between columns c and c+1, spanning rows r and r+1

export const N = 9; // classic board size (legacy callers)
export const WALLS_PER_PLAYER = 10;

export const MODES = {
  duel: { cols: 9, rows: 9, walls: 10 },
  race: { cols: 9, rows: 13, walls: 15 },
};

// opts.walls lets a room choose the wall count (the create-room dialog offers
// 10 or 15). Clamped, because this value arrives from a client.
export function initialState(mode = 'duel', opts = {}) {
  const m = MODES[mode] || MODES.duel;
  let w = Number(opts.walls);
  if (!Number.isInteger(w) || w < 0 || w > 20) w = m.walls;
  if (mode === 'race') {
    return {
      mode: 'race', cols: m.cols, rows: m.rows,
      pawns: [{ r: m.rows - 1, c: 2 }, { r: m.rows - 1, c: m.cols - 3 }],
      walls: [],
      left: [w, w],
      turn: 0,
      winner: null,
    };
  }
  return {
    mode: 'duel', cols: 9, rows: 9,
    pawns: [{ r: 8, c: 4 }, { r: 0, c: 4 }],
    walls: [],
    left: [w, w],
    turn: 0,
    winner: null,
  };
}

export const colsOf = (s) => s.cols || 9;
export const rowsOf = (s) => s.rows || 9;

// Where player p is heading. In race mode everyone runs to the top row.
// Legacy calls without a state assume the classic 9x9 duel.
export function goalRow(p, state) {
  if (state && state.mode === 'race') return 0;
  return p === 0 ? 0 : (state ? rowsOf(state) - 1 : 8);
}

export function cloneState(s) {
  return {
    mode: s.mode || 'duel', cols: colsOf(s), rows: rowsOf(s),
    pawns: s.pawns.map(p => ({ ...p })),
    walls: s.walls.map(w => ({ ...w })),
    left: [...s.left],
    turn: s.turn,
    winner: s.winner,
  };
}

/* ================= blocked edges ================= */
/* The original scanned the whole wall array on every single edge test, so one
   path search cost cells x 4 x walls comparisons. The AI runs thousands of
   searches per move, which made that the hot loop of the entire program.
   Walls are turned into two flat lookup tables once, and every search after
   that reads a single byte. */

// vBlk[r * (cols-1) + c] — the step between (r,c) and (r,c+1) is blocked
// hBlk[r * cols + c]     — the step between (r,c) and (r+1,c) is blocked
export function buildBlocks(walls, cols, rows) {
  const vBlk = new Uint8Array(rows * (cols - 1));
  const hBlk = new Uint8Array((rows - 1) * cols);
  for (const w of walls) {
    if (w.o === 'v') {
      // spans rows w.r and w.r+1, sitting between columns w.c and w.c+1
      vBlk[w.r * (cols - 1) + w.c] = 1;
      vBlk[(w.r + 1) * (cols - 1) + w.c] = 1;
    } else {
      // spans columns w.c and w.c+1, sitting between rows w.r and w.r+1
      hBlk[w.r * cols + w.c] = 1;
      hBlk[w.r * cols + w.c + 1] = 1;
    }
  }
  return { vBlk, hBlk, cols, rows };
}

// Is the edge between two ADJACENT cells blocked, given a prepared table?
export function blockedAt(B, r1, c1, r2, c2) {
  if (r1 === r2) return B.vBlk[r1 * (B.cols - 1) + (c1 < c2 ? c1 : c2)] === 1;
  return B.hBlk[(r1 < r2 ? r1 : r2) * B.cols + c1] === 1;
}

// Same question from a raw wall list. Kept because the renderer asks about one
// edge at a time, where building a table would cost more than it saves.
export function isBlocked(walls, r1, c1, r2, c2) {
  if (r1 === r2) {
    const c = Math.min(c1, c2);
    for (const w of walls) {
      if (w.o === 'v' && w.c === c && (w.r === r1 || w.r === r1 - 1)) return true;
    }
  } else {
    const r = Math.min(r1, r2);
    for (const w of walls) {
      if (w.o === 'h' && w.r === r && (w.c === c1 || w.c === c1 - 1)) return true;
    }
  }
  return false;
}

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/* ================= pawn movement ================= */

// Legal pawn destinations for player p: the four steps, plus the jump over an
// adjacent opponent (straight, or diagonal when the straight jump is stopped by
// a wall or the board edge). Never through a wall.
export function pawnMoves(state, p) {
  const cols = colsOf(state), rows = rowsOf(state);
  const B = buildBlocks(state.walls, cols, rows);
  const inB = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;
  const me = state.pawns[p];
  const opp = state.pawns[1 - p];
  const out = [];
  for (const [dr, dc] of DIRS) {
    const r1 = me.r + dr, c1 = me.c + dc;
    if (!inB(r1, c1) || blockedAt(B, me.r, me.c, r1, c1)) continue;
    if (r1 !== opp.r || c1 !== opp.c) {
      out.push({ r: r1, c: c1 });
      continue;
    }
    // opponent adjacent: try the straight jump over them first
    const r2 = r1 + dr, c2 = c1 + dc;
    if (inB(r2, c2) && !blockedAt(B, r1, c1, r2, c2)) {
      out.push({ r: r2, c: c2 });
    } else {
      // straight jump stopped: the two diagonal side-steps become legal
      const perps = dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
      for (const [pr, pc] of perps) {
        const r3 = r1 + pr, c3 = c1 + pc;
        if (!inB(r3, c3)) continue;
        if (blockedAt(B, r1, c1, r3, c3)) continue;
        out.push({ r: r3, c: c3 });
      }
    }
  }
  return out;
}

/* ================= paths ================= */

function wallsConflict(a, b) {
  if (a.o === b.o) {
    if (a.o === 'h') return a.r === b.r && Math.abs(a.c - b.c) <= 1;
    return a.c === b.c && Math.abs(a.r - b.r) <= 1;
  }
  // an h and a v cross at the same centre point
  return a.r === b.r && a.c === b.c;
}

// Can the pawn still reach its goal row? Pawns do not block paths.
// Depth-first is enough here: the question is reachability, not distance.
export function hasPathB(B, pawn, goal) {
  const { cols, rows } = B;
  const seen = new Uint8Array(rows * cols);
  const stack = [pawn.r * cols + pawn.c];
  seen[stack[0]] = 1;
  while (stack.length) {
    const cur = stack.pop();
    const r = (cur / cols) | 0, c = cur % cols;
    if (r === goal) return true;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr * cols + nc;
      if (seen[k]) continue;
      if (blockedAt(B, r, c, nr, nc)) continue;
      seen[k] = 1;
      stack.push(k);
    }
  }
  return false;
}

export function hasPath(walls, pawn, goal, cols = 9, rows = 9) {
  return hasPathB(buildBlocks(walls, cols, rows), pawn, goal);
}

// Breadth-first distance from every cell to the goal row. Cells are r*cols+c,
// unreachable cells stay -1. This is the AI's whole view of the board.
export function distToGoalB(B, goal) {
  const { cols, rows } = B;
  const dist = new Int16Array(rows * cols).fill(-1);
  const q = new Int32Array(rows * cols);
  let head = 0, tail = 0;
  for (let c = 0; c < cols; c++) {
    dist[goal * cols + c] = 0;
    q[tail++] = goal * cols + c;
  }
  while (head < tail) {
    const cur = q[head++];
    const r = (cur / cols) | 0, c = cur % cols;
    const d = dist[cur] + 1;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr * cols + nc;
      if (dist[k] !== -1) continue;
      if (blockedAt(B, r, c, nr, nc)) continue;
      dist[k] = d;
      q[tail++] = k;
    }
  }
  return dist;
}

export function distToGoal(walls, goal, cols = 9, rows = 9) {
  return distToGoalB(buildBlocks(walls, cols, rows), goal);
}

/* ================= walls ================= */

// Shape check, kept apart because it is the one thing a hostile client can lie
// about freely. The original compared r and c with < and >, which a fractional
// or string coordinate slips straight through: 0.5 is neither below 0 nor above
// rows-2, so the wall was accepted, stored, charged to the player's supply — and
// then matched nothing on the board, because every lookup uses ===. A wall that
// costs a wall and blocks nothing.
export function wallShapeOk(w, cols, rows) {
  if (!w || (w.o !== 'h' && w.o !== 'v')) return false;
  if (!Number.isInteger(w.r) || !Number.isInteger(w.c)) return false;
  return w.r >= 0 && w.r <= rows - 2 && w.c >= 0 && w.c <= cols - 2;
}

// Can player p legally place wall w?
export function canPlaceWall(state, p, w) {
  const cols = colsOf(state), rows = rowsOf(state);
  if (state.left[p] <= 0) return false;
  if (!wallShapeOk(w, cols, rows)) return false;
  for (const e of state.walls) if (wallsConflict(e, w)) return false;
  // neither player may be sealed off from their goal
  const B = buildBlocks([...state.walls, w], cols, rows);
  return hasPathB(B, state.pawns[0], goalRow(0, state))
    && hasPathB(B, state.pawns[1], goalRow(1, state));
}

/* ================= moves ================= */

// Apply a move for the player whose turn it is.
// move: {type:'pawn', r, c} | {type:'wall', r, c, o}
// Returns true when the move was legal and has been applied.
export function applyMove(state, move) {
  if (!move || state.winner !== null) return false;
  const p = state.turn;
  if (move.type === 'pawn') {
    const ok = pawnMoves(state, p).some(m => m.r === move.r && m.c === move.c);
    if (!ok) return false;
    state.pawns[p] = { r: move.r, c: move.c };
    if (move.r === goalRow(p, state)) {
      state.winner = p;
      return true;
    }
  } else if (move.type === 'wall') {
    /* `by` is who placed it, and it belongs here rather than anywhere else.

       The board paints each wall in its owner's colour, which is the only way
       to read whose walls are whose — and the engine used to push { r, c, o }
       with no owner at all. The client patched the field on after applyMove for
       its own moves, so a wall looked right for the instant before the server's
       authoritative state replaced it; every wall in an online game then fell
       back to the unowned dark grey, which reads as black. The rendering was
       correct the whole time and had nothing to render.

       The engine is the only place that knows: `p` is whose turn it is at the
       moment the wall goes down. Both the browser and the server run this file,
       so recording it once fixes both. */
    const w = { r: move.r, c: move.c, o: move.o, by: p };
    if (!canPlaceWall(state, p, w)) return false;
    state.walls.push(w);
    state.left[p]--;
  } else {
    return false;
  }
  state.turn = 1 - p;
  return true;
}

// A player with no pawn move and no walls left cannot move at all. The
// keep-a-path rule makes this vanishingly rare — it needs the opponent's pawn
// corking a one-cell corridor with both jump and side-steps walled — but the
// server has to answer "whose turn is it" every tick, and without this it would
// answer forever. Treated as a pass rather than a loss: the player did nothing
// wrong.
export function mustPass(state) {
  const p = state.turn;
  return state.winner === null && state.left[p] <= 0 && pawnMoves(state, p).length === 0;
}
