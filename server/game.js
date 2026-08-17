// The authoritative game server: rooms, matchmaking, clocks, and the only copy
// of the board that counts.
//
// The client is treated as a display and an input device, never as a source of
// truth. It sends "I want to move here"; the server re-runs the move through the
// shared engine and broadcasts the resulting position to both players. A client
// that sends an illegal move gets its own position echoed back and nothing else
// happens — no way to place a wall you do not have, move on your opponent's
// turn, or teleport.

import { randomInt } from 'node:crypto';
import {
  initialState, applyMove, cloneState, mustPass, MODES,
} from '../public/js/engine.js';

/* Time control. The bank is the room's setting; the per-move cap is on top of it
   and always applies, no-time rooms included. Without it, "∞" rooms hang forever
   on someone who walked away and never closed the tab — which the opponent
   experiences as the game being broken. */
const MOVE_LIMIT_MS = 30_000;

// How long a disconnected player's seat is held. Long enough to survive a train
// tunnel or a phone switching from wifi to data, short enough that the person
// still at the table is not held hostage.
const GRACE_MS = 60_000;

// Ambiguous glyphs removed: these codes get read aloud and typed by hand, and
// O/0 and I/1 account for most of the "the code doesn't work" reports.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* Voice signalling. See Room.relayVoice.

   'on' / 'off' announce that a player has joined or left the call, 'mute' says
   whether their microphone is currently open, and the other three are the
   WebRTC handshake itself. Nothing here carries free text. */
const VOICE_KINDS = new Set(['on', 'off', 'mute', 'offer', 'answer', 'ice']);
const VOICE_MAX_BYTES = 16 * 1024;   // an SDP offer is a few KB; a candidate is tiny
const VOICE_BURST = 200;             // one negotiation is a few dozen messages
const VOICE_WINDOW_MS = 30_000;

function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/* ================= ladder ================= */
// Chess-style expectation, but gentler: a loss costs less than a win pays, and
// points never go below zero. This is a casual game; a ladder that can grind you
// backwards for an evening is a reason to stop playing.
function pointsFor(winnerPts, loserPts) {
  const expected = 1 / (1 + 10 ** ((loserPts - winnerPts) / 400));
  const gain = Math.max(8, Math.round(32 * (1 - expected)));
  const loss = Math.max(4, Math.round(gain * 0.6));
  return { gain, loss };
}

/* ================= room ================= */

class Room {
  constructor(hub, host, cfg) {
    this.hub = hub;
    this.code = makeCode();
    this.mode = MODES[cfg.mode] ? cfg.mode : 'duel';
    this.walls = Number(cfg.walls) || MODES[this.mode].walls;
    // 'time' arrives as a string from the create dialog: '0' | '3' | '5'
    this.minutes = Math.max(0, Math.min(30, Number(cfg.time) || 0));
    /* Two different ideas that used to be one flag.

       `private` means "not listed in the lobby". Quick match builds its rooms
       private too, precisely so a matchmade game does not show up as joinable —
       which makes `private` useless as a test for "these two players know each
       other". It is off by a whole category: every stranger paired by
       matchmaking is sitting in a private room.

       `invited` means the second seat was filled by somebody who typed a code
       the first player sent them. That is the only situation where voice is
       offered, so it gets its own flag instead of borrowing one that already
       means something else. matchmake() clears it explicitly. */
    this.private = Boolean(cfg.private);
    this.ranked = !this.private;   // a room made for a friend does not move the ladder
    this.invited = Boolean(cfg.private);

    this.players = [host, null];
    this.state = null;
    this.clocks = null;
    this.turnStart = 0;
    this.over = false;
    this.moves = 0;
    this.matchId = null;
    this.rematchVotes = [false, false];
    this.startedAt = null;

    host.room = this;
    host.side = 0;
  }

  get full() { return Boolean(this.players[0] && this.players[1]); }
  get live() { return this.state !== null && !this.over; }

  other(side) { return this.players[1 - side]; }

  /* Relay one WebRTC signalling message to the other seat.

     The server never sees or carries the audio — the two browsers negotiate a
     direct connection and the sound goes between them. All that passes through
     here is the handshake: an SDP offer, its answer, ICE candidates, and the
     small on/off/mute notices the UI needs.

     Three rules, all enforced here rather than in the client:

     1. Private rooms only. Voice exists so friends who swapped a code can talk;
        it is deliberately not available to strangers paired by matchmaking,
        where an open microphone is a moderation problem nobody is staffed to
        answer. A client can ask in a public room — the answer is no.
     2. Known message kinds only, same reasoning as the emoji allowlist above:
        an unchecked relay between two players is a chat channel, and this one
        would be invisible because it does not appear anywhere in the UI.
     3. Rate limited. A real negotiation is a burst of a few dozen candidates;
        anything beyond that is somebody using the handshake as a data pipe. */
  relayVoice(from, msg, now = Date.now()) {
    if (!this.invited) return 'not_invited';
    if (!VOICE_KINDS.has(msg?.k)) return 'bad_kind';

    const peer = this.other(from.side);
    if (!peer) return 'no_peer';

    // SDP is the big one, a few KB; candidates are tiny. Anything larger is not
    // a handshake.
    if (msg.d !== undefined) {
      let size = 0;
      try { size = JSON.stringify(msg.d).length; } catch { return 'unserialisable'; }
      if (size > VOICE_MAX_BYTES) return 'too_big';
    }

    from.voiceHits = (from.voiceHits || []).filter(t => now - t < VOICE_WINDOW_MS);
    if (from.voiceHits.length >= VOICE_BURST) return 'rate_limited';
    from.voiceHits.push(now);

    peer.send({ t: 'rtc', k: msg.k, d: msg.d, from: from.side });
    return 'ok';
  }

  send(side, msg) {
    const p = this.players[side];
    if (p) p.send(msg);
  }

  broadcast(msg) {
    for (const p of this.players) if (p) p.send(msg);
  }

  /* ---- lifecycle ---- */

  start() {
    this.state = initialState(this.mode, { walls: this.walls });
    const bankMs = this.minutes > 0 ? this.minutes * 60_000 : Number.MAX_SAFE_INTEGER / 4;
    this.clocks = {
      bank: [bankMs, bankMs],
      turn: 0,
      moveLimit: MOVE_LIMIT_MS,
      noTime: this.minutes === 0,
      paused: false,
    };
    this.turnStart = Date.now();
    this.startedAt = new Date();
    this.over = false;
    this.moves = 0;
    this.rematchVotes = [false, false];

    for (const side of [0, 1]) {
      const me = this.players[side];
      const opp = this.players[1 - side];
      me.send({
        t: 'game_start',
        you: side,
        state: this.state,
        ranked: this.ranked,
        /* Whether this room may carry voice. Sent by the server rather than
           inferred from `ranked` on the client, because it is a permission:
           the UI must not be the thing that decides who is allowed to open a
           microphone to whom. relayVoice() enforces the same rule again.
           `invited`, not `private` — see the constructor for why that
           distinction exists and what happens if you use the wrong one. */
        voice: this.invited,
        clocks: this.clockView(),
        me: { points: me.points, veteran: me.veteran, plus: Boolean(me.plus) },
        // The cosmetics are the point of the cosmetics: they travel to the
        // other player, already resolved against what their owner may wear.
        opp: {
          nick: opp.nick, points: opp.points,
          skin: opp.skin, badge: opp.badge, pixel: opp.pixel, pack: opp.pack,
        },
      });
    }
    this.hub.onMatchStart?.(this);
    this.hub.pushLobby();
  }

  // What the client needs to run its own countdown: the banks, whose turn it is,
  // and whether the clock is running at all. It re-bases against its own
  // Date.now() on arrival, so no clock skew between machines matters.
  clockView() {
    if (!this.clocks) return null;
    const c = this.clocks;
    const spent = c.paused ? 0 : Date.now() - this.turnStart;
    const bank = [...c.bank];
    bank[c.turn] = Math.max(0, bank[c.turn] - spent);
    return {
      bank, turn: c.turn, moveLimit: c.moveLimit,
      noTime: c.noTime, paused: c.paused,
    };
  }

  sendState(side) {
    const msg = { t: 'state', state: this.state, clocks: this.clockView() };
    if (side === undefined) this.broadcast(msg);
    else this.send(side, msg);
  }

  /* ---- moves ---- */

  handleMove(player, move) {
    if (!this.live) return;
    const side = player.side;
    // Not your turn is the single most common thing a lagging client does, and
    // it is not an error worth a message — the state echo below re-syncs it.
    if (this.state.turn !== side) { this.sendState(side); return; }

    const before = cloneState(this.state);
    if (!applyMove(this.state, move)) {
      // Illegal. Put the client's board back the way the server sees it; do not
      // charge the clock, do not pass the turn.
      this.state = before;
      this.sendState(side);
      return;
    }

    this.chargeClock(side);
    this.moves++;

    if (this.state.winner !== null) {
      this.sendState();
      this.finish(this.state.winner, 'goal');
      return;
    }

    // Vanishingly rare, but the alternative is a room that never moves again.
    if (mustPass(this.state)) {
      this.state.turn = 1 - this.state.turn;
      this.turnStart = Date.now();
      this.clocks.turn = this.state.turn;
    }

    this.sendState();
  }

  chargeClock(side) {
    const c = this.clocks;
    if (!c.paused) c.bank[side] = Math.max(0, c.bank[side] - (Date.now() - this.turnStart));
    c.turn = this.state.turn;
    this.turnStart = Date.now();
  }

  // Called from the hub's single ticker rather than a timer per room: a few
  // hundred rooms would otherwise be a few hundred interleaved intervals.
  tick(now) {
    if (!this.live || this.clocks.paused) return;
    const c = this.clocks;
    const spent = now - this.turnStart;
    const active = c.turn;
    if (spent >= c.moveLimit) { this.finish(1 - active, 'timeout'); return; }
    if (!c.noTime && c.bank[active] - spent <= 0) { this.finish(1 - active, 'timeout'); return; }

    // The seat has been empty too long; award the game rather than hold the
    // person who stayed.
    for (const side of [0, 1]) {
      const p = this.players[side];
      if (p?.awaySince && now - p.awaySince > GRACE_MS) {
        this.finish(1 - side, 'disconnect');
        return;
      }
    }
  }

  finish(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.clocks.paused = true;

    const award = this.ranked ? this.applyPoints(winner) : null;
    for (const side of [0, 1]) {
      this.send(side, {
        t: 'game_over',
        winner, you: side, reason,
        points: award ? award[side] : null,
      });
    }
    this.hub.onMatchEnd?.(this, winner, reason);
    this.hub.pushLobby();
  }

  applyPoints(winner) {
    const w = this.players[winner];
    const l = this.players[1 - winner];
    if (!w || !l) return null;
    const { gain, loss } = pointsFor(w.points, l.points);
    w.points += gain;
    l.points = Math.max(0, l.points - loss);
    const out = [];
    out[winner] = { total: w.points, delta: gain, won: true };
    out[1 - winner] = { total: l.points, delta: -loss, won: false };
    return out;
  }

  /* ---- presence ---- */

  markAway(player) {
    if (!this.live) return;
    player.awaySince = Date.now();
    this.clocks.paused = true;
    // Freeze the clock at the moment they vanished: charging someone for a
    // dropped connection is the one thing that makes a rejoin pointless.
    this.chargeClock(this.state.turn);
    this.clocks.turn = this.state.turn;
    this.other(player.side)?.send({ t: 'opp_disconnected' });
  }

  markBack(player) {
    player.awaySince = 0;
    if (!this.live) return;
    if (!this.players.some(p => p?.awaySince)) {
      this.clocks.paused = false;
      this.turnStart = Date.now();
    }
    this.other(player.side)?.send({ t: 'opp_reconnected' });
    this.sendState();
  }

  /* ---- rematch ---- */

  rematch(player, yes) {
    if (!this.over || !this.full) return;
    if (!yes) {
      this.other(player.side)?.send({ t: 'rematch_declined' });
      return;
    }
    this.rematchVotes[player.side] = true;
    if (this.rematchVotes.every(Boolean)) {
      // Swap sides so nobody keeps the first-move advantage over a whole session.
      this.players.reverse();
      this.players.forEach((p, i) => { if (p) p.side = i; });
      this.start();
    } else {
      this.other(player.side)?.send({ t: 'rematch_offer' });
    }
  }

  // Public rooms in the lobby list. Only rooms still waiting for a second
  // player: a full room in the list is a join that fails.
  lobbyView() {
    const host = this.players[0];
    if (!host) return null;
    return {
      id: this.code,
      nick: host.nick,
      points: host.points,
      mode: this.mode,
      walls: this.walls,
      time: String(this.minutes),
    };
  }
}

/* ================= hub ================= */

export class Hub {
  constructor(hooks = {}) {
    this.clients = new Map();     // token -> client
    this.rooms = new Map();       // code -> Room
    this.lobbySubs = new Set();
    this.quickQueue = [];
    Object.assign(this, hooks);   // onMatchStart, onMatchEnd, loadPlayer, saveStreak
    this.ticker = setInterval(() => this.tick(), 250);
    // Node keeps the process alive for any live interval. This one runs for the
    // life of the server, so it must not be the reason a shutdown hangs.
    this.ticker.unref?.();
  }

  stop() { clearInterval(this.ticker); }

  // Seats held for a player who dropped are still in the map; they are not
  // people looking at the game, so they do not belong in the counter.
  get online() {
    let n = 0;
    for (const c of this.clients.values()) if (!c.awaySince) n++;
    return n;
  }

  tick() {
    const now = Date.now();
    for (const room of this.rooms.values()) room.tick(now);
    // Windows widen with time, so a queue that could not pair a second ago may
    // pair now. Without this, two lone players sit waiting forever.
    if (this.quickQueue.length > 1) this.matchmake();
    this.reapClients(now);
    this.reapRooms(now);
  }

  /* Give up a seat that nobody came back for.

     detach() no longer throws a player away the instant their socket closes —
     see the comment there — so something has to, eventually, or an abandoned
     room is never reaped and the queue fills with ghosts. GRACE_MS is the same
     window a disconnected player already gets mid-game. */
  reapClients(now) {
    for (const [token, c] of this.clients) {
      if (!c.awaySince || now - c.awaySince <= GRACE_MS) continue;
      this.clients.delete(token);
      this.dequeue(c);
      this.lobbySubs.delete(c);
      // A live game hands the win to the opponent through its own timer; this
      // only clears out rooms that never started.
      if (c.room && !c.room.live) this.leaveRoom(c);
    }
  }

  // A room with nobody left in it, or an abandoned finished one, is dropped.
  reapRooms(now) {
    for (const [code, room] of this.rooms) {
      const anyone = room.players.some(p => p && this.clients.has(p.token));
      if (!anyone) { this.rooms.delete(code); continue; }
      if (room.over && room.players.every(p => !p || p.awaySince)) {
        if (!room.deadSince) room.deadSince = now;
        else if (now - room.deadSince > GRACE_MS) this.rooms.delete(code);
      } else {
        room.deadSince = 0;
      }
    }
  }

  pushLobby() {
    if (!this.lobbySubs.size) return;
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (room.private || room.full || room.state) continue;
      // Its host is holding a seat but is not there. Listing it invites
      // somebody into a game against an empty chair.
      if (room.players[0]?.awaySince) continue;
      const v = room.lobbyView();
      if (v) rooms.push(v);
    }
    const msg = { t: 'lobby', online: this.online, rooms };
    for (const c of this.lobbySubs) c.send(msg);
  }

  /* ---- rooms ---- */

  createRoom(client, cfg) {
    this.leaveRoom(client);
    const room = new Room(this, client, cfg);
    this.rooms.set(room.code, room);
    // A private room shows its code; a public one is announced in the lobby.
    client.send({ t: 'room_created', code: room.private ? room.code : null });
    this.pushLobby();
    return room;
  }

  joinRoom(client, code) {
    const room = this.rooms.get(String(code || '').toUpperCase().trim());
    if (!room) { client.send({ t: 'error', code: 'no_room' }); return; }
    if (room.full || room.state) { client.send({ t: 'error', code: 'room_full' }); return; }
    if (room.players[0] === client) return;   // joining your own room
    this.leaveRoom(client);
    room.players[1] = client;
    client.room = room;
    client.side = 1;
    room.start();
  }

  leaveRoom(client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    const side = client.side;
    client.side = -1;
    if (room.players[side] === client) room.players[side] = null;

    if (room.live) {
      // Walking out of a live game is a resignation; anything else lets a losing
      // player escape by pressing Back.
      room.finish(1 - side, 'resign');
    }
    if (room.players.every(p => !p)) this.rooms.delete(room.code);
    this.dequeue(client);
    this.pushLobby();
  }

  /* ---- quick match ---- */

  /* Pairing on rating, with the window opening as the wait goes on.

     A plain "take whoever is waiting" queue hands a first-day player to the top
     of the ladder, and that player does not come back. A strict rating window
     has the opposite failure: at four in the morning, nobody matches at all.

     So the window starts narrow and widens by the second. Two players of
     similar strength pair instantly; a lone expert waits half a minute and then
     gets whoever is there, which is the right trade in that order. */
  quick(client) {
    this.leaveRoom(client);
    this.dequeue(client);
    client.queuedAt = Date.now();
    this.quickQueue.push(client);
    client.send({ t: 'room_created', code: null });   // shows the waiting screen
    this.matchmake();
  }

  // 150 points apart is roughly one rank; after a minute of waiting the window
  // is wide enough to accept anybody still online.
  static gapAllowed(client, now) {
    const waited = (now - (client.queuedAt || now)) / 1000;
    return 150 + waited * 40;
  }

  matchmake() {
    const now = Date.now();
    // Drop anyone whose seat has been collected, then pair from the front.
    // Someone merely away keeps their place — reapClients() removes them if
    // they never come back — but must not be matched while absent, or their
    // opponent starts a game alone.
    this.quickQueue = this.quickQueue.filter(c => this.clients.has(c.token) && !c.room);
    const ready = (c) => !c.awaySince;

    for (let i = 0; i < this.quickQueue.length; i++) {
      const a = this.quickQueue[i];
      if (a.room || !ready(a)) continue;
      let bestJ = -1, bestGap = Infinity;
      for (let j = i + 1; j < this.quickQueue.length; j++) {
        const b = this.quickQueue[j];
        if (b.room || !ready(b)) continue;
        const gap = Math.abs(a.points - b.points);
        // The longer-waiting of the two sets the window: one player's patience
        // is enough to justify the match.
        const allowed = Math.max(Hub.gapAllowed(a, now), Hub.gapAllowed(b, now));
        if (gap <= allowed && gap < bestGap) { bestGap = gap; bestJ = j; }
      }
      if (bestJ < 0) continue;

      const b = this.quickQueue[bestJ];
      const room = new Room(this, a, { mode: 'duel', time: '5', private: true });
      room.ranked = true;    // quick match counts; private only hides it from the lobby
      room.invited = false;  // and these two are strangers: never voice. See relayVoice.
      this.rooms.set(room.code, room);
      room.players[1] = b;
      b.room = room;
      b.side = 1;
      room.start();
    }

    this.quickQueue = this.quickQueue.filter(c => !c.room);
  }

  dequeue(client) {
    const i = this.quickQueue.indexOf(client);
    if (i >= 0) this.quickQueue.splice(i, 1);
    client.queuedAt = 0;
  }

  /* ---- connections ---- */

  attach(client) {
    client.awaySince = 0;          // back, whether this is a first hello or a return
    this.clients.set(client.token, client);
    this.pushLobby();
  }

  /* A closed socket is not a player leaving.

     This used to delete the client from the map and, for any room that had not
     started yet, remove them from it — which meant a room died the moment its
     host's connection blinked. On a laptop with two windows on localhost that
     never happens. On a phone it happens every time the screen locks or the
     player switches app, so the sequence "make a room, send the code to a
     friend, wait" destroyed the room before the friend could type it. The
     symptoms were a code that did not work, a room missing from the lobby, and
     Quick match spinning on two devices at once.

     Deleting from the map broke the other half too: the hello handler resumes a
     session by looking the token up, so a player who reconnected mid-game was
     handed a brand-new seat and lost the game they were in.

     Now the seat is held, marked away, and reapClients() collects it after
     GRACE_MS if nobody comes back. */
  detach(client, ws = null) {
    /* Ignore a socket that has already been replaced.

       Over a real network the server often learns a socket is dead LONG after
       the player reconnected on a new one — the close only surfaces when a ping
       goes unanswered, up to half a minute later. By then the client has been
       resumed by token and is live again, and this stale close would mark the
       live session away: matchmaking then skips a player who is sitting right
       there watching a spinner, until the grace period finally collects them.

       On localhost the close lands instantly, in the right order, every time.
       This only appears once there is latency between the two events. */
    if (ws && client.ws !== ws) return;

    client.awaySince = Date.now();
    this.lobbySubs.delete(client);
    // Deliberately still queued: matchmake() skips absent players, so the place
    // is kept for a few seconds rather than lost. Nothing on the client
    // re-sends `quick`, so losing it here strands them on the waiting screen.
    if (client.room?.live) client.room.markAway(client);
    this.pushLobby();
  }
}

export { Room, MOVE_LIMIT_MS, GRACE_MS, pointsFor };
