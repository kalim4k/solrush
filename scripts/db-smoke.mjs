// Full-stack check against the REAL database: create two accounts, play a
// ranked game to a finish over WebSocket, then read the rows back out of Neon
// and confirm the points, the win/loss and the streak actually landed.
//
// Everything it creates is removed at the end, so it is safe to run against a
// live database. Run with the server up:  node scripts/db-smoke.mjs [port]
import '../server/boot-env.js';
import { WebSocket } from 'ws';
import { q, close } from '../server/db.js';

const PORT = process.argv[2] || 3000;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const users = [
  { email: `smoke-a-${stamp}@example.test`, password: 'smoke-password-1', nick: `SmokeA${stamp % 100000}` },
  { email: `smoke-b-${stamp}@example.test`, password: 'smoke-password-2', nick: `SmokeB${stamp % 100000}` },
];

const ok = (m) => console.log('  ok  ' + m);
let failed = false;

const post = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

function connect(nick, jwt, device) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const inbox = [], waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].t === msg.t) waiters.splice(i, 1)[0].resolve(msg);
      }
    });
    const api = {
      ws, inbox,
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (t, ms = 20000) => new Promise((res, rej) => {
        const hit = inbox.find(m => m.t === t);
        if (hit) return res(hit);
        const timer = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${nick})`)), ms);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); res(m); } });
      }),
      drop: (t) => { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === t) inbox.splice(i, 1); },
    };
    ws.on('open', () => { api.send({ t: 'hello', nick, jwt, device, tz: 0 }); resolve(api); });
  });
}

try {
  /* ---- accounts ---- */
  const reg = [];
  for (const u of users) {
    const r = await post('/api/register', { ...u, device: `smoke-dev-${u.nick}` });
    if (r.status !== 200 || !r.data.token) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
    reg.push(r.data);
  }
  ok(`two accounts created in Neon (${users[0].nick}, ${users[1].nick})`);

  const dup = await post('/api/register', { ...users[0], device: 'x' });
  if (dup.data.error !== 'email_taken') throw new Error('a duplicate email was accepted');
  ok('a duplicate email is refused');

  const bad = await post('/api/resolve-login', { email: users[0].email, password: 'wrong-password' });
  if (bad.status !== 401) throw new Error('a wrong password was accepted');
  ok('a wrong password is refused');

  const good = await post('/api/resolve-login', { email: users[0].email, password: users[0].password });
  if (good.status !== 200 || !good.data.token) throw new Error('login failed');
  ok('login returns a token');

  /* Two profile calls at once, on an account whose streak row does not exist
     yet. This is not a contrived case — it is what opening the game does, once
     through /api/profile and once through the socket's hello, and both used to
     INSERT the same row. The loser hit streaks_user_id_key, /api/profile
     answered 500, and the browser read that as a refused token and showed the
     login form to somebody who had just registered.

     Probabilistic, and said out loud: the window between the SELECT and the
     INSERT is small, and with the bug in place this passed on the first try.
     Six calls widen it, but the assertion that cannot pass by luck is the one
     in test/streak.test.mjs, which reads the statement itself. This is here for
     what that one cannot see — that the whole round trip really does survive
     it. */
  const many = await Promise.all(Array.from({ length: 6 },
    () => post('/api/profile', { tz: -120 }, reg[1].token)));
  if (many.some((r) => r.status !== 200)) {
    throw new Error(`simultaneous profile loads raced: ${many.map((r) => r.status).join(', ')}`);
  }
  ok('six profile loads at once all succeed on a brand-new account');

  const prof = await post('/api/profile', { tz: 0 }, good.data.token);
  if (prof.data.nick !== users[0].nick) throw new Error('profile returned the wrong account');
  ok(`profile reads back: ${prof.data.nick}, ${prof.data.points} points`);

  const noAuth = await post('/api/profile', { tz: 0 }, 'not.a.token');
  if (noAuth.status !== 401) throw new Error('a forged token was accepted');
  ok('a forged token is refused');

  /* ---- a ranked game, played to a real finish ---- */
  const a = await connect(users[0].nick, reg[0].token, `smoke-dev-${users[0].nick}`);
  const b = await connect(users[1].nick, reg[1].token, `smoke-dev-${users[1].nick}`);
  const helloA = await a.wait('hello_ok');
  await b.wait('hello_ok');
  if (helloA.points === undefined) throw new Error('hello_ok carried no points');
  ok('both clients authenticated on the socket under their account nicks');

  a.send({ t: 'create_room', private: false, mode: 'duel', walls: 10, time: '0' });
  const code = (await a.wait('room_created')).code || a.room;
  // a public room announces itself in the lobby rather than handing back a code
  const roomCode = code || (await (async () => {
    a.send({ t: 'lobby_sub' });
    const lob = await a.wait('lobby');
    return lob.rooms[0]?.id;
  })());
  b.send({ t: 'join_code', code: roomCode });
  const startA = await a.wait('game_start');
  await b.wait('game_start');
  if (startA.ranked !== true) throw new Error('a public room was not ranked');
  ok(`ranked game started in room ${roomCode}`);

  // Player A walks straight up the board; B shuffles sideways so A gets there.
  const sides = [a, b];
  let state = startA.state;
  for (let ply = 0; ply < 40 && state.winner === null; ply++) {
    const turn = state.turn;
    const me = state.pawns[turn];
    const move = turn === 0
      ? { type: 'pawn', r: me.r - 1, c: me.c }
      : { type: 'pawn', r: me.r, c: me.c === 4 ? 3 : 4 };
    sides[turn].drop('state');
    sides[turn].send({ t: 'move', move });
    state = (await sides[turn].wait('state')).state;
  }
  const over = await a.wait('game_over');
  if (over.winner !== 0) throw new Error('the expected player did not win');
  if (!over.points || over.points.delta <= 0) throw new Error('no points were awarded');
  ok(`game finished: ${users[0].nick} won, +${over.points.delta} points`);

  /* ---- and it is actually in the database ---- */
  await new Promise(r => setTimeout(r, 1200));   // the write is fire-and-forget

  const rows = await q(
    'SELECT nick, points, wins, losses FROM users WHERE email = ANY($1) ORDER BY wins DESC',
    [users.map(u => u.email)],
  );
  const winner = rows.rows[0], loser = rows.rows[1];
  if (winner.wins !== 1 || winner.points <= 0) throw new Error(`winner row wrong: ${JSON.stringify(winner)}`);
  if (loser.losses !== 1) throw new Error(`loser row wrong: ${JSON.stringify(loser)}`);
  ok(`Neon rows updated — ${winner.nick}: ${winner.points} pts / ${winner.wins}W, ${loser.nick}: ${loser.losses}L`);

  const m = await q('SELECT winner, reason, moves FROM matches ORDER BY id DESC LIMIT 1');
  if (m.rows[0]?.winner !== 0 || m.rows[0]?.reason !== 'goal') throw new Error('the match row is wrong');
  ok(`match row written: winner ${m.rows[0].winner}, "${m.rows[0].reason}", ${m.rows[0].moves} moves`);

  const s = await q(
    `SELECT days FROM streaks WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
    [users[0].email],
  );
  if (s.rows[0]?.days !== 1) throw new Error(`streak not started: ${JSON.stringify(s.rows)}`);
  ok('daily streak started at 1');

  const lb = await fetch(BASE + '/api/leaderboard').then(r => r.json());
  if (!lb.rows.some(r => r.nick === users[0].nick)) throw new Error('winner missing from the leaderboard');
  ok(`leaderboard lists the winner (${lb.rows.length} ranked players)`);

  a.ws.close(); b.ws.close();
} catch (e) {
  failed = true;
  console.error('  FAIL  ' + e.message);
} finally {
  // Leave the database as it was found.
  try {
    await q('DELETE FROM matches WHERE p0_nick LIKE $1 OR p1_nick LIKE $1', ['Smoke%']);
    const del = await q('DELETE FROM users WHERE email LIKE $1 RETURNING id', ['smoke-%@example.test']);
    await q('DELETE FROM devices WHERE id LIKE $1', ['smoke-dev-%']);
    await q('DELETE FROM streaks WHERE device_id LIKE $1', ['smoke-dev-%']);
    console.log(`\n  cleaned up: ${del.rowCount} test accounts removed`);
  } catch (e) { console.error('  cleanup failed:', e.message); }
  await close();
}

console.log(failed ? '\ndb smoke FAILED' : '\ndb smoke passed');
process.exit(failed ? 1 : 0);
