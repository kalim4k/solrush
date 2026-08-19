// Rules the engine must never get wrong. Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialState, applyMove, pawnMoves, canPlaceWall, goalRow, cloneState,
  isBlocked, buildBlocks, blockedAt, hasPath, distToGoal, wallShapeOk, mustPass,
} from '../public/js/engine.js';
import { aiMove } from '../public/js/ai.js';

test('duel: opening position', () => {
  const s = initialState('duel');
  assert.deepEqual(s.pawns, [{ r: 8, c: 4 }, { r: 0, c: 4 }]);
  assert.deepEqual(s.left, [10, 10]);
  assert.equal(goalRow(0, s), 0);
  assert.equal(goalRow(1, s), 8);
  assert.equal(pawnMoves(s, 0).length, 3); // up, left, right — the wall is behind
});

test('race: both pawns start at the bottom and both run to the top', () => {
  const s = initialState('race');
  assert.equal(s.rows, 13);
  assert.equal(s.pawns[0].r, 12);
  assert.equal(s.pawns[1].r, 12);
  assert.equal(goalRow(0, s), 0);
  assert.equal(goalRow(1, s), 0);
  assert.deepEqual(s.left, [15, 15]);
});

test('a wall blocks the step it straddles and nothing else', () => {
  const walls = [{ r: 4, c: 3, o: 'h' }];   // between rows 4 and 5, over cols 3 and 4
  assert.equal(isBlocked(walls, 4, 3, 5, 3), true);
  assert.equal(isBlocked(walls, 4, 4, 5, 4), true);
  assert.equal(isBlocked(walls, 4, 5, 5, 5), false);  // one column past the end
  assert.equal(isBlocked(walls, 4, 3, 4, 4), false);  // sideways is unaffected

  // the fast table must agree with the scan, on every edge of the board
  const B = buildBlocks(walls, 9, 9);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (c < 8) assert.equal(blockedAt(B, r, c, r, c + 1), isBlocked(walls, r, c, r, c + 1));
      if (r < 8) assert.equal(blockedAt(B, r, c, r + 1, c), isBlocked(walls, r, c, r + 1, c));
    }
  }
});

test('vertical wall blocks sideways movement on both its rows', () => {
  const walls = [{ r: 2, c: 3, o: 'v' }];   // between cols 3 and 4, over rows 2 and 3
  assert.equal(isBlocked(walls, 2, 3, 2, 4), true);
  assert.equal(isBlocked(walls, 3, 3, 3, 4), true);
  assert.equal(isBlocked(walls, 4, 3, 4, 4), false);
  assert.equal(isBlocked(walls, 2, 3, 3, 3), false);
});

test('pawns facing each other: straight jump', () => {
  const s = initialState('duel');
  s.pawns = [{ r: 5, c: 4 }, { r: 4, c: 4 }];
  const moves = pawnMoves(s, 0);
  assert.ok(moves.some(m => m.r === 3 && m.c === 4), 'jumps over to r3');
  assert.ok(!moves.some(m => m.r === 4 && m.c === 4), 'never lands on the opponent');
});

test('jump walled off: the two diagonals open up', () => {
  const s = initialState('duel');
  s.pawns = [{ r: 5, c: 4 }, { r: 4, c: 4 }];
  s.walls = [{ r: 3, c: 4, o: 'h' }];       // stops the landing square
  const moves = pawnMoves(s, 0);
  assert.ok(!moves.some(m => m.r === 3 && m.c === 4), 'straight jump is shut');
  assert.ok(moves.some(m => m.r === 4 && m.c === 3), 'diagonal left');
  assert.ok(moves.some(m => m.r === 4 && m.c === 5), 'diagonal right');
});

test('a wall may not seal a player off completely', () => {
  const s = initialState('duel');
  s.pawns[1] = { r: 0, c: 0 };
  s.walls = [{ r: 0, c: 0, o: 'h' }];       // roof over the corner
  // the last brick of the box: legal shape, illegal because it traps p1
  assert.equal(canPlaceWall(s, 0, { r: 0, c: 0, o: 'v' }), false);
});

test('walls may not overlap or cross', () => {
  const s = initialState('duel');
  s.walls = [{ r: 4, c: 4, o: 'h' }];
  assert.equal(canPlaceWall(s, 0, { r: 4, c: 4, o: 'h' }), false, 'same slot');
  assert.equal(canPlaceWall(s, 0, { r: 4, c: 5, o: 'h' }), false, 'half-overlap');
  assert.equal(canPlaceWall(s, 0, { r: 4, c: 4, o: 'v' }), false, 'crossing');
  assert.equal(canPlaceWall(s, 0, { r: 4, c: 6, o: 'h' }), true, 'clear of it');
});

test('malformed wall coordinates are rejected', () => {
  const s = initialState('duel');
  assert.equal(wallShapeOk({ r: 0.5, c: 3, o: 'h' }, 9, 9), false, 'fractional');
  assert.equal(wallShapeOk({ r: '3', c: 3, o: 'h' }, 9, 9), false, 'string');
  assert.equal(wallShapeOk({ r: 3, c: 3, o: 'x' }, 9, 9), false, 'bad orientation');
  assert.equal(wallShapeOk({ r: 8, c: 3, o: 'h' }, 9, 9), false, 'off the board');
  assert.equal(wallShapeOk({ r: 3, c: 3, o: 'h' }, 9, 9), true);

  // and the engine must not charge a wall for one
  const before = s.left[0];
  assert.equal(applyMove(s, { type: 'wall', r: 0.5, c: 3, o: 'h' }), false);
  assert.equal(s.left[0], before, 'a rejected wall costs nothing');
  assert.equal(s.walls.length, 0);
});

/* Whose wall is it?

   This is a rule, not decoration. A player reads the board by seeing which
   walls are theirs, and the board can only paint them if the engine says who
   put them there. It did not: applyMove pushed { r, c, o } and the owner was
   patched on afterwards by the client, for its own moves only — so an online
   game, whose walls come from the server's copy of this same engine, drew every
   wall in the unowned dark grey and neither player could tell them apart. */
test('a wall records who placed it', () => {
  const s = initialState('duel');
  assert.equal(s.turn, 0);
  assert.equal(applyMove(s, { type: 'wall', r: 3, c: 3, o: 'h' }), true);
  assert.equal(s.walls[0].by, 0, 'seat 0 placed the first wall');

  assert.equal(s.turn, 1);
  assert.equal(applyMove(s, { type: 'wall', r: 5, c: 5, o: 'v' }), true);
  assert.equal(s.walls[1].by, 1, 'seat 1 placed the second');

  // and it has to survive the copy the server sends and the replay stores
  const copy = cloneState(s);
  assert.deepEqual(copy.walls.map(w => w.by), [0, 1]);
});

test('reaching the goal row ends the game', () => {
  const s = initialState('duel');
  s.pawns[0] = { r: 1, c: 4 };
  s.pawns[1] = { r: 0, c: 0 };   // clear of the landing square
  assert.equal(applyMove(s, { type: 'pawn', r: 0, c: 4 }), true);
  assert.equal(s.winner, 0);
  assert.equal(applyMove(s, { type: 'pawn', r: 0, c: 3 }), false, 'game is over');
});

test('an illegal move changes nothing', () => {
  const s = initialState('duel');
  const before = JSON.stringify(s);
  assert.equal(applyMove(s, { type: 'pawn', r: 0, c: 0 }), false);
  assert.equal(applyMove(s, { type: 'nonsense' }), false);
  assert.equal(applyMove(s, null), false);
  assert.equal(JSON.stringify(s), before);
});

test('distance map matches a hand-counted board', () => {
  const d = distToGoal([], 0, 9, 9);
  assert.equal(d[8 * 9 + 4], 8, 'eight steps from the far row');
  assert.equal(d[0 * 9 + 4], 0);
  assert.equal(hasPath([], { r: 8, c: 4 }, 0, 9, 9), true);
});

test('mustPass is false in any ordinary position', () => {
  assert.equal(mustPass(initialState('duel')), false);
});

/* ---- the AI ---- */

test('every level returns a legal move, in both modes', () => {
  for (const mode of ['duel', 'race']) {
    for (const level of ['easy', 'normal', 'hard', 'hardcore']) {
      const s = initialState(mode);
      const mv = aiMove(s, level, { ms: 200 });
      assert.ok(mv, `${mode}/${level} produced a move`);
      assert.equal(applyMove(cloneState(s), mv), true, `${mode}/${level} move is legal`);
    }
  }
});

/* hardcore, not hard, and that matters: every level below hardcore has a
   blunder rate — 'hard' throws away its own best move 3% of the time on
   purpose. A test written against it passes thirty-two times out of
   thirty-three and then fails for no reason anybody can reproduce. Only the
   level with blunder: 0 makes a deterministic assertion legitimate. */
test('the AI takes a win that is one step away', () => {
  const s = initialState('duel');
  s.pawns[0] = { r: 1, c: 4 };
  s.pawns[1] = { r: 6, c: 0 };   // out of the way, so row 0 is a plain step
  const mv = aiMove(s, 'hardcore', { ms: 500 });
  assert.deepEqual(mv, { type: 'pawn', r: 0, c: 4 });
});

// With the opponent standing on the goal square, the win is a diagonal jump
// around them — the case that broke the first draft of this test.
test('the AI wins by jumping around the opponent', () => {
  const s = initialState('duel');
  s.pawns[0] = { r: 1, c: 4 };
  s.pawns[1] = { r: 0, c: 4 };
  const mv = aiMove(s, 'hardcore', { ms: 500 });   // the only level that never blunders
  assert.equal(mv.type, 'pawn');
  assert.equal(mv.r, 0, 'lands on the goal row');
  assert.ok(mv.c === 3 || mv.c === 5, 'via one of the two diagonals');
});

test('hardcore beats easy over a full game', () => {
  const s = initialState('duel');
  let plies = 0;
  while (s.winner === null && plies < 300) {
    const mv = aiMove(s, s.turn === 0 ? 'hardcore' : 'easy', { ms: 300 });
    assert.ok(mv, 'a move exists at ply ' + plies);
    assert.equal(applyMove(s, mv), true, 'ply ' + plies + ' was legal');
    plies++;
  }
  assert.equal(s.winner, 0, 'the stronger level won');
});

/* Replays are stored as MOVES, not as positions, so a shared game is only as
   good as the engine's ability to replay them in order. This is the property
   the whole feature rests on: the board is a pure function of its moves. */
test('a game replays from its move log to the same position', () => {
  const s = initialState('duel');
  const log = [];
  // A short, legal game: both pawns walk forward, one wall goes down.
  const moves = [
    { type: 'pawn', r: 7, c: 4 },
    { type: 'pawn', r: 1, c: 4 },
    { type: 'wall', r: 3, c: 3, o: 'h' },
    { type: 'pawn', r: 2, c: 4 },
    { type: 'pawn', r: 6, c: 4 },
  ];
  for (const m of moves) {
    assert.ok(applyMove(s, m), `move should be legal: ${JSON.stringify(m)}`);
    log.push(m);
  }

  const rebuilt = initialState('duel');
  for (const m of log) assert.ok(applyMove(rebuilt, m), 'the recorded move replays');

  assert.deepEqual(rebuilt.pawns, s.pawns, 'both pawns end where they ended');
  assert.equal(rebuilt.walls.length, s.walls.length, 'the same walls are standing');
  assert.deepEqual(rebuilt.left, s.left, 'the same wall supplies remain');
  assert.equal(rebuilt.turn, s.turn, 'and it is the same player to move');
});

test('a replay stops at a move the engine will not accept', () => {
  // A corrupt or truncated log must not be applied around: everything after a
  // rejected move was played against a board this one changed, so continuing
  // replays a different game while still looking like a valid one.
  const s = initialState('duel');
  assert.ok(applyMove(s, { type: 'pawn', r: 7, c: 4 }));
  assert.equal(applyMove(s, { type: 'pawn', r: 0, c: 0 }), false,
    'a teleport is refused rather than silently applied');
});
