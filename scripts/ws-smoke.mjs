// End-to-end over a real socket: two clients, a private room, a real move.
// Run against a running server:  node test/ws-smoke.mjs [port]
import { WebSocket } from 'ws';

const PORT = process.argv[2] || 3111;
const URL = `ws://localhost:${PORT}/ws`;

function connect(nick, device) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].t === msg.t) { waiters.splice(i, 1)[0].resolve(msg); }
      }
    });
    ws.on('error', reject);
    const api = {
      ws, inbox,
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (t, ms = 15000) => new Promise((res, rej) => {
        const hit = inbox.find(m => m.t === t);
        if (hit) return res(hit);
        const timer = setTimeout(() => rej(new Error(`timeout waiting for "${t}" (${nick})`)), ms);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); res(m); } });
      }),
    };
    ws.on('open', () => {
      api.send({ t: 'hello', nick, device, tz: 0 });
      resolve(api);
    });
  });
}

const ok = (label) => console.log('  ok  ' + label);
let failed = false;

try {
  const a = await connect('Alice', 'dev-a');
  const b = await connect('Bob', 'dev-b');

  const helloA = await a.wait('hello_ok');
  await b.wait('hello_ok');
  if (!helloA.token) throw new Error('hello_ok carried no token');
  ok('both clients greeted, tokens issued');

  a.send({ t: 'create_room', private: true, mode: 'duel', walls: 10, time: '5' });
  const created = await a.wait('room_created');
  if (!created.code || created.code.length !== 6) throw new Error('no room code');
  ok(`private room created: ${created.code}`);

  b.send({ t: 'join_code', code: created.code });
  const startA = await a.wait('game_start');
  const startB = await b.wait('game_start');
  if (startA.you !== 0 || startB.you !== 1) throw new Error('sides are wrong');
  if (startA.opp.nick !== 'Bob' || startB.opp.nick !== 'Alice') throw new Error('names are wrong');
  ok('game started, sides and names correct');

  // Alice opens; the pawn starts on row 8 and steps to row 7.
  a.send({ t: 'move', move: { type: 'pawn', r: 7, c: 4 } });
  const stateB = await b.wait('state');
  if (stateB.state.pawns[0].r !== 7) throw new Error('the move did not land');
  if (stateB.state.turn !== 1) throw new Error('the turn did not pass');
  ok('legal move applied and broadcast to the opponent');

  // Bob tries to move on Alice's behalf, out of turn, from across the board.
  const before = JSON.stringify(stateB.state);
  b.inbox.length = 0;
  b.send({ t: 'move', move: { type: 'pawn', r: 0, c: 0 } });
  const echo = await b.wait('state');
  if (JSON.stringify(echo.state) !== before) throw new Error('an illegal move changed the board');
  ok('illegal move rejected, server state re-sent unchanged');

  // A wall forged out of a fractional coordinate.
  b.inbox.length = 0;
  b.send({ t: 'move', move: { type: 'wall', r: 0.5, c: 3, o: 'h' } });
  const echo2 = await b.wait('state');
  if (echo2.state.walls.length !== 0 || echo2.state.left[1] !== 10) {
    throw new Error('a malformed wall got through');
  }
  ok('malformed wall rejected without costing a wall');

  a.send({ t: 'resign' });
  const overB = await b.wait('game_over');
  if (overB.winner !== 1 || overB.reason !== 'resign') throw new Error('resign result is wrong');
  ok('resignation ends the game for both sides');

  a.ws.close(); b.ws.close();
} catch (e) {
  failed = true;
  console.error('  FAIL  ' + e.message);
}

console.log(failed ? '\nsmoke test FAILED' : '\nsmoke test passed');
process.exit(failed ? 1 : 0);
