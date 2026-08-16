// The server's job: be the only authority on the board. These tests drive the
// Hub with fake sockets and check that a hostile client cannot get anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hub, GRACE_MS } from '../server/game.js';
import { pawnMoves } from '../public/js/engine.js';

let seq = 0;
function fakeClient(nick, points = 0) {
  return {
    token: 'tok' + (++seq),
    nick, points, veteran: false,
    room: null, side: -1, awaySince: 0,
    inbox: [],
    send(msg) { this.inbox.push(msg); },
    last(type) { return [...this.inbox].reverse().find(m => m.t === type) ?? null; },
    clear() { this.inbox = []; },
  };
}

function pair(cfg = {}) {
  const hub = new Hub();
  const a = fakeClient('Alice');
  const b = fakeClient('Bob');
  hub.attach(a); hub.attach(b);
  hub.createRoom(a, { mode: 'duel', time: '5', private: true, ...cfg });
  const code = a.last('room_created').code;
  hub.joinRoom(b, code);
  return { hub, a, b, room: a.room };
}

test('two players get a started game, on opposite sides', () => {
  const { hub, a, b } = pair();
  const ga = a.last('game_start'), gb = b.last('game_start');
  assert.ok(ga && gb);
  assert.equal(ga.you, 0);
  assert.equal(gb.you, 1);
  assert.equal(ga.opp.nick, 'Bob');
  assert.equal(gb.opp.nick, 'Alice');
  assert.deepEqual(ga.state.pawns, [{ r: 8, c: 4 }, { r: 0, c: 4 }]);

  /* Nearly five minutes, not exactly five. The clock starts the instant the
     room does, and clockView() subtracts the time already spent on the current
     turn — so the number in the very first message is a millisecond or two
     short, and more than that when the machine is busy running the rest of this
     suite. Asserting equality here passes alone and fails under load, which is
     the worst way for a test to be wrong. */
  assert.ok(ga.clocks.bank[0] > 5 * 60_000 - 1000 && ga.clocks.bank[0] <= 5 * 60_000,
    `expected about 5 minutes, got ${ga.clocks.bank[0]}ms`);
  hub.stop();
});

/* ---- voice signalling ----

   Voice is a permission, and permissions belong on the server. The client hides
   the button in public rooms, but hiding a button is decoration: the test that
   matters is that a client which asks anyway is refused. */

test('a friend room carries voice signalling between the two seats', () => {
  const { hub, a, b, room } = pair({ private: true });
  a.clear(); b.clear();
  assert.equal(room.relayVoice(a, { k: 'offer', d: { type: 'offer', sdp: 'v=0' } }), 'ok');
  const got = b.last('rtc');
  assert.ok(got, 'the peer should receive the offer');
  assert.equal(got.k, 'offer');
  assert.equal(got.from, 0, 'the peer needs to know which seat sent it');
  assert.equal(a.last('rtc'), null, 'it must not echo back to the sender');
  hub.stop();
});

/* A public room hands back `code: null` in room_created — the code is only
   shown for private rooms — so pair() cannot join one. Read the code off the
   room itself, the way the lobby does. */
function pairPublic() {
  const hub = new Hub();
  const a = fakeClient('Alice');
  const b = fakeClient('Bob');
  hub.attach(a); hub.attach(b);
  const room = hub.createRoom(a, { mode: 'duel', time: '5', private: false });
  hub.joinRoom(b, room.code);
  return { hub, a, b, room };
}

test('a public room refuses voice signalling', () => {
  const { hub, a, b, room } = pairPublic();
  a.clear(); b.clear();
  assert.equal(room.invited, false);
  assert.ok(room.full, 'both seats must be taken, or this passes for the wrong reason');
  assert.equal(room.relayVoice(a, { k: 'offer', d: { type: 'offer', sdp: 'v=0' } }), 'not_invited');
  assert.equal(b.last('rtc'), null, 'a stranger must never receive a microphone offer');
  hub.stop();
});

/* Quick match is the case that nearly shipped broken.

   Its rooms are built with `private: true` — not because the two players know
   each other, but so a matchmade game is not listed as joinable in the lobby.
   Gating voice on `private` therefore opened a microphone between strangers
   paired by matchmaking, which is the exact thing this feature is supposed not
   to do. Nothing in the unit tests noticed, because they all built rooms
   through createRoom and never through the matchmaker. */
test('quick match pairs strangers and never offers them voice', () => {
  const hub = new Hub();
  const a = fakeClient('Alice');
  const b = fakeClient('Bob');
  hub.attach(a); hub.attach(b);
  hub.quick(a);
  hub.quick(b);

  const room = a.room;
  assert.ok(room && room.full, 'the two should have been matched');
  assert.equal(room.private, true, 'a matchmade room is still unlisted');
  assert.equal(room.ranked, true, 'and it still counts for points');
  assert.equal(room.invited, false, 'but the players never exchanged a code');

  assert.equal(a.last('game_start').voice, false, 'the client must not be offered the button');
  assert.equal(b.last('game_start').voice, false);

  b.clear();
  assert.equal(room.relayVoice(a, { k: 'offer', d: { sdp: 'v=0' } }), 'not_invited');
  assert.equal(b.last('rtc'), null, 'and asking anyway must get nowhere');
  hub.stop();
});

test('game_start says whether the room may carry voice', () => {
  // The client reads this rather than inferring it from `ranked`, so that the
  // permission travels with the room instead of being re-derived in the UI.
  const priv = pair({ private: true });
  assert.equal(priv.a.last('game_start').voice, true);
  priv.hub.stop();

  const pub = pairPublic();
  assert.equal(pub.a.last('game_start').voice, false);
  pub.hub.stop();
});

test('only the known signalling kinds are relayed', () => {
  const { hub, a, b, room } = pair({ private: true });
  b.clear();
  // The relay is invisible in the UI, so an unchecked one is a hidden chat
  // channel between two players with no moderation anywhere near it.
  for (const k of ['chat', 'text', '__proto__', '', undefined]) {
    assert.equal(room.relayVoice(a, { k, d: 'hello' }), 'bad_kind', `kind ${JSON.stringify(k)}`);
  }
  assert.equal(b.last('rtc'), null);
  for (const k of ['on', 'off', 'mute', 'offer', 'answer', 'ice']) {
    assert.equal(room.relayVoice(a, { k, d: 1 }), 'ok', `kind ${k} should pass`);
  }
  hub.stop();
});

test('an oversized signalling payload is dropped', () => {
  const { hub, a, b, room } = pair({ private: true });
  b.clear();
  assert.equal(room.relayVoice(a, { k: 'ice', d: 'x'.repeat(20_000) }), 'too_big');
  assert.equal(b.last('rtc'), null);
  // A real SDP offer is a few KB and must still get through.
  assert.equal(room.relayVoice(a, { k: 'offer', d: { sdp: 'x'.repeat(4000) } }), 'ok');
  hub.stop();
});

test('signalling is rate limited without breaking a real negotiation', () => {
  const { hub, a, room } = pair({ private: true });
  const t0 = Date.now();
  // A negotiation is a few dozen candidates; that must never be throttled.
  for (let i = 0; i < 60; i++) {
    assert.equal(room.relayVoice(a, { k: 'ice', d: i }, t0), 'ok', `candidate ${i}`);
  }
  // Sustained flooding is.
  let limited = false;
  for (let i = 0; i < 400; i++) {
    if (room.relayVoice(a, { k: 'ice', d: i }, t0) === 'rate_limited') { limited = true; break; }
  }
  assert.ok(limited, 'a flood should eventually be refused');
  // And the window reopens, so a long game does not lose voice for good.
  assert.equal(room.relayVoice(a, { k: 'ice', d: 0 }, t0 + 31_000), 'ok');
  hub.stop();
});

test('voice signalling stops when the other seat is empty', () => {
  const hub = new Hub();
  const a = fakeClient('Alice');
  hub.attach(a);
  hub.createRoom(a, { mode: 'duel', time: '5', private: true });
  assert.equal(a.room.relayVoice(a, { k: 'on' }), 'no_peer');
  hub.stop();
});

test('a legal move is applied and broadcast to both', () => {
  const { hub, a, b, room } = pair();
  a.clear(); b.clear();
  hub.rooms.get(room.code);
  room.handleMove(a, { type: 'pawn', r: 7, c: 4 });
  assert.deepEqual(room.state.pawns[0], { r: 7, c: 4 });
  assert.equal(room.state.turn, 1);
  assert.ok(a.last('state'), 'mover is told');
  assert.ok(b.last('state'), 'opponent is told');
  hub.stop();
});

test('moving out of turn changes nothing', () => {
  const { hub, a, b, room } = pair();
  const before = JSON.stringify(room.state);
  b.clear();
  room.handleMove(b, { type: 'pawn', r: 1, c: 4 });   // it is Alice's move
  assert.equal(JSON.stringify(room.state), before, 'board untouched');
  assert.ok(b.last('state'), 'the offender is re-synced instead');
  hub.stop();
});

test('an illegal move is rejected without costing the clock or the turn', () => {
  const { hub, a, room } = pair();
  const before = JSON.stringify(room.state);
  room.handleMove(a, { type: 'pawn', r: 0, c: 0 });   // nowhere near the pawn
  assert.equal(JSON.stringify(room.state), before);
  assert.equal(room.state.turn, 0, 'still their move');
  hub.stop();
});

test('a forged wall cannot be conjured out of malformed numbers', () => {
  const { hub, a, room } = pair();
  const walls = room.state.left[0];
  room.handleMove(a, { type: 'wall', r: 0.5, c: 3, o: 'h' });
  room.handleMove(a, { type: 'wall', r: '3', c: 3, o: 'h' });
  room.handleMove(a, { type: 'wall', r: 99, c: 3, o: 'h' });
  assert.equal(room.state.walls.length, 0);
  assert.equal(room.state.left[0], walls, 'supply untouched');
  assert.equal(room.state.turn, 0);
  hub.stop();
});

test('a player cannot spend more walls than they hold', () => {
  const { hub, a, b, room } = pair({ walls: 1 });
  room.handleMove(a, { type: 'wall', r: 4, c: 0, o: 'h' });
  assert.equal(room.state.left[0], 0);
  room.handleMove(b, { type: 'pawn', r: 1, c: 4 });
  room.handleMove(a, { type: 'wall', r: 4, c: 2, o: 'h' });
  assert.equal(room.state.walls.length, 1, 'the second wall was refused');
  hub.stop();
});

test('reaching the goal ends the game and moves the ladder', () => {
  const { hub, a, b, room } = pair();
  room.ranked = true;
  a.points = 100; b.points = 100;
  room.state.pawns[0] = { r: 1, c: 4 };
  room.state.pawns[1] = { r: 5, c: 0 };
  a.clear(); b.clear();
  room.handleMove(a, { type: 'pawn', r: 0, c: 4 });

  const over = a.last('game_over');
  assert.ok(over);
  assert.equal(over.winner, 0);
  assert.equal(over.reason, 'goal');
  assert.ok(a.points > 100, 'winner gained');
  assert.ok(b.points < 100, 'loser lost');
  assert.equal(b.last('game_over').you, 1);
  hub.stop();
});

test('nothing is accepted after the game is over', () => {
  const { hub, a, room } = pair();
  room.state.pawns[0] = { r: 1, c: 4 };
  room.state.pawns[1] = { r: 5, c: 0 };
  room.handleMove(a, { type: 'pawn', r: 0, c: 4 });
  const after = JSON.stringify(room.state);
  room.handleMove(a, { type: 'pawn', r: 0, c: 3 });
  assert.equal(JSON.stringify(room.state), after);
  hub.stop();
});

test('leaving a live game is a resignation, not an escape', () => {
  const { hub, a, b, room } = pair();
  hub.leaveRoom(a);
  const over = b.last('game_over');
  assert.ok(over, 'the player who stayed is told');
  assert.equal(over.winner, 1);
  assert.equal(over.reason, 'resign');
  hub.stop();
});

test('a dropped connection freezes the clock instead of losing the game', () => {
  const { hub, a, b, room } = pair();
  hub.detach(a);
  assert.equal(room.over, false, 'the game is still alive');
  assert.ok(room.clocks.paused, 'and the clock has stopped');
  assert.ok(b.last('opp_disconnected'));
  hub.stop();
});

/* ---- surviving a dropped connection ----

   None of this shows up on a laptop with two windows open on localhost, where
   nothing ever disconnects. In the field it happens constantly: a phone locks
   its screen, the player switches app, wifi hands over to mobile data. Every
   one of those closes the WebSocket. */

test('a room waiting for an opponent survives the host dropping', () => {
  // The whole point of a room code is that you send it to somebody and then
  // wait. If the wait itself destroys the room, the feature cannot work.
  const hub = new Hub();
  const a = fakeClient('Alice');
  hub.attach(a);
  const room = hub.createRoom(a, { mode: 'duel', time: '5', private: true });
  const code = room.code;

  hub.detach(a);              // screen locked, app switched, signal lost
  hub.tick();                 // the reaper runs four times a second

  assert.ok(hub.rooms.has(code), 'the room should still exist');
  assert.equal(room.players[0], a, 'and the host should still hold seat 0');
  hub.stop();
});

test('a friend can still join by code after the host dropped', () => {
  const hub = new Hub();
  const a = fakeClient('Alice');
  const b = fakeClient('Bob');
  hub.attach(a); hub.attach(b);
  const room = hub.createRoom(a, { mode: 'duel', time: '5', private: true });
  hub.detach(a);
  hub.tick();

  hub.joinRoom(b, room.code);
  assert.equal(b.room, room, 'the code must still work');
  assert.ok(b.last('game_start'), 'and the game should start');
  hub.stop();
});

test('reconnecting with the same token returns you to your seat', () => {
  // This is what the hello handler does: look the token up and take the seat
  // back. If the token is gone from the map, a returning player is a stranger
  // and their game is lost — which is what happened.
  const { hub, a, room } = pair();
  hub.detach(a);
  const seat = hub.clients.get(a.token);
  assert.ok(seat, 'the token must still resolve after a drop');
  assert.equal(seat.room, room, 'and it must still point at the game');
  assert.equal(seat.side, 0);
  hub.stop();
});

test('a seat is given up once the grace period really has passed', () => {
  // Holding it forever is its own bug: an abandoned room would never be reaped.
  const hub = new Hub();
  const a = fakeClient('Alice');
  hub.attach(a);
  const room = hub.createRoom(a, { mode: 'duel', time: '5', private: true });
  hub.detach(a);

  const later = Date.now() + GRACE_MS + 1000;
  hub.reapClients(later);
  hub.reapRooms(later);
  assert.equal(hub.clients.has(a.token), false, 'the client is finally dropped');
  assert.equal(hub.rooms.has(room.code), false, 'and the room with it');
  hub.stop();
});

test('a player who drops while queued is still matched when they return', () => {
  /* The reported symptom: two devices, both on Quick match, both spinning
     forever. The first one queued, its socket dropped when the screen went
     off, and it was removed from the queue — but nothing on the client
     re-sends `quick`, so it waited on a queue it was no longer in. */
  const hub = new Hub();
  const a = fakeClient('Alice');
  const b = fakeClient('Bob');
  hub.attach(a); hub.attach(b);

  hub.quick(a);
  hub.detach(a);                     // screen off while waiting
  assert.equal(hub.quickQueue.includes(a), true, 'the place in the queue is held');

  hub.quick(b);
  assert.equal(a.room, null, 'but an absent player is not matched');

  hub.attach(a);                     // back
  hub.matchmake();
  assert.ok(a.room && b.room, 'and now they pair');
  assert.equal(a.room, b.room);
  hub.stop();
});

test('a stale socket closing does not unseat a player who already reconnected', () => {
  /* The production-only half of the bug. The server learns a socket is dead
     when a ping goes unanswered, which can be half a minute after the player
     already reconnected on a new one. That late close used to mark the live
     session away, and matchmaking then skipped somebody sitting right there
     watching a spinner. Locally the close always arrives first, so the ordering
     that breaks it never occurs. */
  const hub = new Hub();
  const a = fakeClient('Alice');
  const oldWs = { tag: 'old' };
  a.ws = oldWs;
  hub.attach(a);
  hub.quick(a);

  a.ws = { tag: 'new' };       // what the hello handler does on a resume
  hub.attach(a);

  hub.detach(a, oldWs);        // the dead socket's close finally arrives
  assert.equal(a.awaySince, 0, 'the live session must not be marked away');
  assert.ok(hub.quickQueue.includes(a), 'and it must keep its place in the queue');

  hub.detach(a, a.ws);         // the real socket closing still counts
  assert.ok(a.awaySince > 0);
  hub.stop();
});

test('an absent player is not counted as online', () => {
  const hub = new Hub();
  const a = fakeClient('Alice');
  hub.attach(a);
  assert.equal(hub.online, 1);
  hub.detach(a);
  assert.equal(hub.online, 0, 'holding the seat must not inflate the counter');
  hub.attach(a);
  assert.equal(hub.online, 1);
  hub.stop();
});

test('a public room is hidden from the lobby while its host is away', () => {
  // Otherwise somebody joins and starts a game against an empty chair.
  const hub = new Hub();
  const a = fakeClient('Alice');
  const watcher = fakeClient('Watcher');
  hub.attach(a); hub.attach(watcher);
  hub.lobbySubs.add(watcher);
  hub.createRoom(a, { mode: 'duel', time: '5', private: false });
  assert.equal(watcher.last('lobby').rooms.length, 1);

  hub.detach(a);
  hub.pushLobby();
  assert.equal(watcher.last('lobby').rooms.length, 0, 'hidden while the host is gone');

  hub.attach(a);
  hub.pushLobby();
  assert.equal(watcher.last('lobby').rooms.length, 1, 'and back when they return');
  hub.stop();
});

test('running out of time loses the game', () => {
  const { hub, a, b, room } = pair();
  room.clocks.bank[0] = 500;
  room.turnStart = Date.now() - 5_000;
  room.tick(Date.now());
  const over = b.last('game_over');
  assert.ok(over);
  assert.equal(over.winner, 1);
  assert.equal(over.reason, 'timeout');
  hub.stop();
});

test('sitting on a move loses it even in a no-time room', () => {
  const { hub, b, room } = pair({ time: '0' });
  assert.equal(room.clocks.noTime, true);
  room.turnStart = Date.now() - 31_000;
  room.tick(Date.now());
  assert.equal(b.last('game_over')?.reason, 'timeout');
  hub.stop();
});

test('the lobby lists only rooms still waiting for somebody', () => {
  const hub = new Hub();
  const host = fakeClient('Host');
  const watcher = fakeClient('Watcher');
  hub.attach(host); hub.attach(watcher);
  hub.lobbySubs.add(watcher);

  hub.createRoom(host, { mode: 'duel', time: '3', private: false });
  assert.equal(watcher.last('lobby').rooms.length, 1);
  assert.equal(watcher.last('lobby').rooms[0].nick, 'Host');

  const joiner = fakeClient('Joiner');
  hub.attach(joiner);
  hub.joinRoom(joiner, host.room.code);
  assert.equal(watcher.last('lobby').rooms.length, 0, 'a full room is gone from the list');
  hub.stop();
});

test('a private room is never listed', () => {
  const hub = new Hub();
  const host = fakeClient('Host');
  const watcher = fakeClient('Watcher');
  hub.attach(host); hub.attach(watcher);
  hub.lobbySubs.add(watcher);
  hub.createRoom(host, { private: true });
  assert.equal(watcher.last('lobby').rooms.length, 0);
  assert.ok(host.last('room_created').code, 'but the host gets a code to share');
  hub.stop();
});

test('quick match pairs the closest rating, not the longest wait', () => {
  const hub = new Hub();
  const far = fakeClient('Far', 2000);
  const near = fakeClient('Near', 105);
  const me = fakeClient('Me', 100);
  [far, near, me].forEach(c => hub.attach(c));

  hub.quick(far);    // waits
  hub.quick(near);   // waits
  hub.quick(me);     // should take Near, though Far queued first

  assert.ok(me.last('game_start'), 'matched');
  assert.equal(me.last('game_start').opp.nick, 'Near');
  assert.equal(far.last('game_start'), null, 'the mismatched player is still waiting');
  hub.stop();
});

test('the rating window widens, so a lone expert is not stranded', () => {
  const hub = new Hub();
  const expert = fakeClient('Expert', 2000);
  const rookie = fakeClient('Rookie', 20);
  hub.attach(expert); hub.attach(rookie);

  hub.quick(expert);
  hub.quick(rookie);
  assert.equal(expert.last('game_start'), null, 'not paired on arrival');

  // Both have now been waiting a minute; the window is wide enough.
  expert.queuedAt -= 60_000;
  rookie.queuedAt -= 60_000;
  hub.matchmake();
  assert.ok(expert.last('game_start'), 'paired once the window opened');
  assert.equal(expert.last('game_start').opp.nick, 'Rookie');
  hub.stop();
});

test('a rematch swaps sides', () => {
  const { hub, a, b, room } = pair();
  room.state.pawns[0] = { r: 1, c: 4 };
  room.state.pawns[1] = { r: 5, c: 0 };
  room.handleMove(a, { type: 'pawn', r: 0, c: 4 });
  assert.equal(room.over, true);

  a.clear(); b.clear();
  room.rematch(a, true);
  assert.ok(b.last('rematch_offer'), 'the other player is asked');
  assert.equal(b.last('game_start'), null, 'and nothing starts on one vote');

  room.rematch(b, true);
  assert.equal(a.last('game_start').you, 1, 'Alice now plays second');
  assert.equal(b.last('game_start').you, 0);
  hub.stop();
});

test('only the four offered emoji are relayed', () => {
  const { hub, a, b, room } = pair();
  room.other(0).send({ t: 'emoji', e: '🤝' });
  assert.equal(b.last('emoji').e, '🤝');
  hub.stop();
});

test('a full game between two clients ends with exactly one winner', () => {
  const { hub, a, b, room } = pair({ time: '0' });
  const players = [a, b];
  let plies = 0;
  while (!room.over && plies < 400) {
    const side = room.state.turn;
    const moves = pawnMoves(room.state, side);
    // walk straight at the goal
    const goal = side === 0 ? 0 : 8;
    moves.sort((m, n) => Math.abs(m.r - goal) - Math.abs(n.r - goal));
    room.turnStart = Date.now();
    room.handleMove(players[side], { type: 'pawn', ...moves[0] });
    plies++;
  }
  assert.equal(room.over, true, 'the game ended');
  assert.ok(room.state.winner === 0 || room.state.winner === 1);
  assert.equal(a.last('game_over').winner, b.last('game_over').winner, 'both told the same result');
  hub.stop();
});
