// HTTP + WebSocket entry point.
//
// One process serves the static game, the REST endpoints, and the realtime
// socket on the same port. That is deliberate: same-origin means the WebSocket
// URL is just wss://<this host>/ws, with no CORS, no second deployment, and no
// certificate to think about.

// MUST stay first: it populates process.env before db.js and auth.js are
// evaluated, both of which read it at module scope. See boot-env.js.
import './boot-env.js';

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { q, one, migrate } from './db.js';
import {
  register, login, readToken, userById, startReset, finishReset,
} from './auth.js';
import { Hub } from './game.js';
// The catalogue lives with the client because that is where it is drawn, but
// the server is what decides who may wear what — so both read the same file.
import {
  DEFAULT_SKIN, DEFAULT_BADGE, resolveSkin, resolveBadge, isPixelData,
} from '../public/js/cosmetics.js';
import { getStreak, touchStreak, restoreStreak, mergeDeviceStreak } from './streak.js';
import { checkNick, randomNick } from '../public/js/nick.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

/* ICE servers for the voice call in friend rooms.

   STUN alone is enough for most pairs: it only tells a browser what its own
   public address looks like, the two then connect directly, and no audio ever
   touches this server. It fails when both players are behind a restrictive NAT
   — two mobile networks is the common case — and then the call needs a TURN
   relay to carry the audio.

   TURN is optional and off unless configured, so the feature works out of the
   box and silently degrades rather than breaking: without it, roughly one pair
   in six or seven cannot connect and the UI says so. Set TURN_URL, TURN_USER
   and TURN_PASS to add one (coturn on any small VPS will do).

   Credentials are handed to the browser because they have to be — TURN is
   authenticated by the client. Use short-lived credentials on a real
   deployment; a static password here is a password anyone who plays can read. */
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const { TURN_URL, TURN_USER, TURN_PASS } = process.env;
  if (TURN_URL && TURN_USER && TURN_PASS) {
    list.push({ urls: TURN_URL.split(',').map(s => s.trim()).filter(Boolean), username: TURN_USER, credential: TURN_PASS });
  }
  return list;
}

/* ================= static files ================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  /* robots.txt, ads.txt and sitemap.xml. Without these two entries they fall to
     application/octet-stream, and since every response also carries
     X-Content-Type-Options: nosniff, the crawler is told in the same breath that
     it may not guess — so it declines to read the file at all. An ads.txt that
     serves but cannot be parsed is indistinguishable from a missing one. */
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function serveStatic(req, res, urlPath, versioned = false) {
  // normalize() collapses ../ before it is ever joined to PUBLIC. Without this,
  // GET /../../.env walks straight out of the public directory and serves the
  // database password.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\.]+)/, '');
  let file = join(PUBLIC, rel || 'index.html');
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info) {
    // Single-page app: unknown paths fall back to the shell so an invite link
    // like /join/ABC123 opens the game rather than a 404.
    file = join(PUBLIC, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) { res.writeHead(404).end('not found'); return; }
  }

  const ext = extname(file).toLowerCase();

  /* "immutable" is a promise that this exact URL will never return different
     bytes, and it is only true when the URL carries a version.

     The HTML references css/style.css?v=121 and js/app.js?v=121, so those two
     are safe. But app.js then imports engine.js, i18n.js, lang/en.js and the
     rest with bare specifiers, and those were being served immutable for a
     year as well — meaning an edit to a language pack or to the engine could
     never reach anybody who had already visited once. The only fix would have
     been telling people to clear their cache.

     So: versioned URLs are cached hard, everything else must revalidate. A
     conditional request costs one round trip and answers 304 almost every
     time; being unable to ship a fix costs considerably more. */
  const cache = ext === '.html' ? 'no-cache'
    : versioned ? 'public, max-age=31536000, immutable'
      : 'public, no-cache';

  /* An ETag, because "no-cache" means revalidate, not "do not store" — and a
     revalidation with nothing to compare against is just a full download every
     time. Size plus mtime is enough to tell one build from another; it is weak
     because it says the response is equivalent, not byte-identical. */
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache,
    'ETag': etag,
    'Last-Modified': info.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }

  headers['Content-Length'] = info.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}

/* ================= request helpers ================= */

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

// 64 KB is far more than any endpoint here needs; the cap is what stops a
// request body from being used to exhaust memory.
function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? readToken(h.slice(7)) : null;
}

/* Fixed-window rate limit, in memory. Enough for one process: the endpoints
   worth protecting are login and register, and the thing being stopped is a
   script trying ten thousand passwords, not a distributed attack. Behind more
   than one instance this becomes per-instance — move it to Postgres then. */
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
  if (rec.n >= max) return false;
  rec.n++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60_000).unref();

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress || '?';

/* ================= REST ================= */

async function api(req, res, path) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (req.method === 'POST' && body === null) return json(res, 400, { error: 'bad_json' });
  const auth = bearer(req);
  const ip = clientIp(req);

  switch (path) {
    /* what the client needs to know before it boots */
    case '/api/config':
      return json(res, 200, { auth: true, provider: 'neon', ice: iceServers() });

    case '/api/visit': {
      const { device, nick, game, lang, tz, installed, src } = body;
      if (!device) return json(res, 400, { error: 'no_device' });
      await q(
        `INSERT INTO devices (id, src, lang, tz, installed, visits, games)
         VALUES ($1, $2, $3, $4, $5, 1, $6)
         ON CONFLICT (id) DO UPDATE SET
           last_seen = now(),
           visits    = devices.visits + 1,
           games     = devices.games + $6,
           installed = devices.installed OR EXCLUDED.installed,
           lang      = COALESCE(EXCLUDED.lang, devices.lang),
           tz        = COALESCE(EXCLUDED.tz, devices.tz),
           -- first touch only: overwriting would turn every returning player
           -- into "direct" and make the whole acquisition table say nothing works
           src       = COALESCE(devices.src, EXCLUDED.src)`,
        [String(device).slice(0, 64), src || null, lang || null, tz || null,
          Boolean(installed), game ? 1 : 0],
      );
      return json(res, 200, { ok: true });
    }

    case '/api/event': {
      const { device, name, meta } = body;
      if (!name) return json(res, 400, { error: 'no_name' });
      await q('INSERT INTO events (device, name, meta) VALUES ($1, $2, $3)',
        [device ? String(device).slice(0, 64) : null, String(name).slice(0, 64), meta || null]);
      return json(res, 200, { ok: true });
    }

    case '/api/register': {
      if (!rateLimit('reg:' + ip, 5, 3600_000)) return json(res, 429, { error: 'too_many' });
      let nick = String(body.nick || '').trim();
      if (!nick || checkNick(nick)) nick = randomNick();
      const out = await register(body.email, body.password, nick);
      if (out.error) return json(res, 400, out);
      await mergeDeviceStreak(out.user.id, body.device);
      return json(res, 200, out);
    }

    // Named for what the client calls it. Takes an email and a password and
    // hands back a session, i.e. it is the login endpoint.
    case '/api/resolve-login': {
      if (!rateLimit('login:' + ip, 20, 900_000)) return json(res, 429, { error: 'too_many' });
      const out = await login(body.email, body.password);
      if (out.error) return json(res, 401, out);
      await mergeDeviceStreak(out.user.id, body.device);
      return json(res, 200, out);
    }

    case '/api/reset/start': {
      if (!rateLimit('reset:' + ip, 5, 3600_000)) return json(res, 429, { error: 'too_many' });
      const token = await startReset(body.email);
      // Always the same answer, whether or not the address exists — otherwise
      // this endpoint is a free tool for checking who has an account here.
      const link = token ? `${process.env.PUBLIC_ORIGIN || ''}/?reset=${token}` : null;
      if (link && process.env.RESEND_API_KEY) {
        await sendResetMail(body.email, link).catch(e => console.error('mail failed', e.message));
        return json(res, 200, { sent: true });
      }
      // No mail provider configured: hand the link back so the flow is testable.
      return json(res, 200, { sent: true, devLink: link });
    }

    case '/api/reset/finish': {
      const out = await finishReset(body.token, body.password);
      return json(res, out.error ? 400 : 200, out);
    }

    case '/api/profile': {
      if (!auth) return json(res, 401, { error: 'unauthorized' });
      const user = await userById(auth.sub);
      if (!user) return json(res, 404, { error: 'no_user' });
      const streak = await getStreak({ userId: user.id }, Number(body.tz) || 0);
      return json(res, 200, { ...user, ...streak });
    }

    case '/api/leaderboard': {
      const rows = await q(
        `SELECT nick, points, wins, losses, veteran
           FROM users WHERE wins + losses > 0
          ORDER BY points DESC, wins DESC LIMIT 100`,
      );
      return json(res, 200, { rows: rows.rows });
    }

    case '/api/streak/restore': {
      const owner = auth ? { userId: auth.sub } : { deviceId: body.device };
      if (!owner.userId && !owner.deviceId) return json(res, 400, { error: 'no_owner' });
      const out = await restoreStreak(owner, Number(body.tz) || 0, Boolean(body.watched));
      return json(res, out.error ? 400 : 200, out);
    }

    case '/api/nick-notice/ack':
      return json(res, 200, { ok: true });

    case '/api/push/subscribe': {
      const { subscription, device } = body;
      if (!subscription?.endpoint) return json(res, 400, { error: 'bad_sub' });
      await q(
        `INSERT INTO push_subs (endpoint, device_id, user_id, p256dh, auth)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET device_id = EXCLUDED.device_id,
                                              user_id  = EXCLUDED.user_id`,
        [subscription.endpoint, device || null, auth?.sub || null,
          subscription.keys?.p256dh || '', subscription.keys?.auth || ''],
      );
      return json(res, 200, { ok: true });
    }

    case '/api/push/unsubscribe': {
      if (body.endpoint) await q('DELETE FROM push_subs WHERE endpoint = $1', [body.endpoint]);
      return json(res, 200, { ok: true });
    }

    default:
      return json(res, 404, { error: 'no_route' });
  }
}

async function sendResetMail(to, link) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'noreply@example.com',
      to,
      subject: 'Reset your password',
      html: `<p>Tap the link to choose a new password. It stops working in one hour.</p>
             <p><a href="${link}">${link}</a></p>
             <p>If you did not ask for this, nothing has changed — ignore this message.</p>`,
    }),
  });
  if (!r.ok) throw new Error('resend ' + r.status);
}

/* ================= server ================= */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url.pathname).catch((e) => {
      console.error('api error', url.pathname, e);
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  // Only a URL that names a version may be cached as immutable.
  serveStatic(req, res, url.pathname, url.searchParams.has('v')).catch(() => {
    if (!res.headersSent) res.writeHead(500).end('server error');
  });
});

/* ================= WebSocket ================= */

const hub = new Hub({
  /* Not awaited by the caller — start() must not wait on a database round trip
     to put the board on screen. So the insert is kept as a promise on the room
     and the end hook waits for it.

     Without that handoff there is a race, and it is not theoretical: a game
     that ends faster than the INSERT returns finds matchId still unset, skips
     its own UPDATE, and leaves a row with a null winner. Resignations and
     hundred-millisecond test games hit it every time. */
  onMatchStart: (room) => {
    room.matchIdReady = (async () => {
      try {
        const r = await one(
          `INSERT INTO matches (mode, p0_user, p1_user, p0_nick, p1_nick)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [room.mode, room.players[0]?.userId || null, room.players[1]?.userId || null,
            room.players[0]?.nick || '?', room.players[1]?.nick || '?'],
        );
        room.matchId = r.id;
      } catch (e) { console.error('match insert failed', e.message); }
    })();
  },

  onMatchEnd: async (room, winner, reason) => {
    try {
      // Settled either way: a failed insert must not stop the points below
      // from being written.
      await room.matchIdReady;
      if (room.matchId) {
        await q(
          `UPDATE matches SET winner = $2, reason = $3, moves = $4, ended_at = now()
            WHERE id = $1`,
          [room.matchId, winner, reason, room.moves],
        );
      }
      for (const side of [0, 1]) {
        const p = room.players[side];
        if (!p) continue;
        const won = side === winner;

        if (p.userId && room.ranked) {
          await q(
            `UPDATE users
                SET points = $2,
                    wins   = wins   + $3,
                    losses = losses + $4,
                    -- twenty finished games is what separates somebody who plays
                    -- from somebody who tried it once
                    veteran = (wins + losses + 1) >= 20
              WHERE id = $1`,
            [p.userId, p.points, won ? 1 : 0, won ? 0 : 1],
          );
        }

        // The streak counts games played, not games won. Tying it to winning
        // punishes the beginner it exists to keep.
        const owner = p.userId ? { userId: p.userId } : { deviceId: p.deviceId };
        if (owner.userId || owner.deviceId) {
          const s = await touchStreak(owner, p.tz || 0);
          p.send({ t: 'streak', ...s });
        }
      }
    } catch (e) { console.error('match end failed', e.message); }
  },
});

class Client {
  constructor(ws, token) {
    this.ws = ws;
    this.token = token;
    this.nick = 'Guest';
    this.userId = null;
    this.deviceId = null;
    this.tz = 0;
    this.points = 0;
    this.veteran = false;
    /* Defaults, not blanks: a client that reconnects mid-game keeps its seat
       and everything on it, so these have to be valid before the first hello
       rather than filled in by it. */
    this.plus = false;
    this.skin = DEFAULT_SKIN;
    this.badge = DEFAULT_BADGE;
    this.pixel = '';
    this.room = null;
    this.side = -1;
    this.awaySince = 0;
    this.alive = true;
  }

  send(msg) {
    if (this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* socket died mid-write */ }
    }
  }
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let client = null;

  ws.on('pong', () => { if (client) client.alive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    /* hello is both the greeting and the reconnect. A client that comes back
       with the token it was given lands on its old Client object — and therefore
       back in its game, with its clock where it left it. */
    if (msg.t === 'hello') {
      const existing = msg.token && hub.clients.get(msg.token);
      if (existing) {
        // Take over the seat: replace the dead socket, keep everything else.
        try { existing.ws.close(); } catch { /* already gone */ }
        existing.ws = ws;
        client = existing;
      } else {
        client = new Client(ws, msg.token || randomBytes(18).toString('base64url'));
      }

      client.deviceId = msg.device ? String(msg.device).slice(0, 64) : null;
      client.tz = Number(msg.tz) || 0;

      const payload = msg.jwt ? readToken(msg.jwt) : null;
      if (payload) {
        const user = await userById(payload.sub).catch(() => null);
        if (user) {
          client.userId = user.id;
          client.nick = user.nick;
          client.points = user.points;
          client.veteran = user.veteran;
          client.plus = Boolean(user.plus);
        }
      }
      if (!client.userId) {
        const n = String(msg.nick || '').trim();
        client.nick = (!n || checkNick(n)) ? randomNick() : n.slice(0, 16);
      }

      /* Cosmetics are chosen in the browser, so they arrive as a request, not
         as a fact. Resolving them here against what the account actually owns
         is the whole enforcement: a player who edits their own copy of the
         catalogue, or types a skin id into a socket frame, gets the default
         back and their opponent's board never shows it. The pixel pawn is held
         to a fixed-length format, so a malformed one costs its owner the skin
         and cannot become a payload. */
      client.skin = resolveSkin(msg.skin, client.plus);
      client.badge = resolveBadge(msg.badge, client.plus);
      client.pixel = (client.skin === 'pixel' && isPixelData(msg.pixel)) ? msg.pixel : '';
      if (client.skin === 'pixel' && !client.pixel) client.skin = 'classic';

      hub.attach(client);

      const owner = client.userId ? { userId: client.userId } : { deviceId: client.deviceId };
      let streak = { streak: 0, streakBest: 0, streakToday: false, streakState: 'none', streakBroken: 0, streakLost: 0, streakFree: true };
      if (owner.userId || owner.deviceId) {
        streak = await getStreak(owner, client.tz).catch(() => streak);
      }

      client.send({
        t: 'hello_ok',
        token: client.token,
        online: hub.online,
        points: client.points,
        veteran: client.veteran,
        // What the client is entitled to wear, so its picker can grey out the
        // rest. Advisory only — the board is painted from what the server
        // resolved above, not from this.
        plus: client.plus,
        skin: client.skin,
        badge: client.badge,
        ...streak,
      });

      if (client.room) { client.room.markBack(client); }
      return;
    }

    if (!client) return;   // anything before hello is ignored

    switch (msg.t) {
      case 'lobby_sub': hub.lobbySubs.add(client); hub.pushLobby(); break;
      case 'lobby_unsub': hub.lobbySubs.delete(client); break;
      case 'create_room': hub.createRoom(client, msg); break;
      case 'join_room': hub.joinRoom(client, msg.roomId); break;
      case 'join_code': hub.joinRoom(client, msg.code); break;
      case 'quick': hub.quick(client); break;
      case 'leave_room': hub.leaveRoom(client); break;
      case 'move': client.room?.handleMove(client, msg.move); break;
      case 'resign':
        if (client.room?.live) client.room.finish(1 - client.side, 'resign');
        break;
      case 'rematch': client.room?.rematch(client, msg.yes !== false); break;
      case 'emoji':
        // Straight through, but only the four the client offers — this is a
        // free text field otherwise, and a free text field between strangers
        // with no moderation is a chat nobody asked to run.
        // Must stay identical to the buttons in index.html — a mismatch here
        // is an emoji the player can press that silently never arrives.
        if (['😂', '👏', '🤝', '😡'].includes(msg.e)) {
          client.room?.other(client.side)?.send({ t: 'emoji', e: msg.e });
        }
        break;
      case 'rtc':
        // The whole decision lives in Room.relayVoice so it can be unit-tested
        // without a socket. It returns a reason string; nothing is sent back on
        // refusal, because every refusal here is either a bug in our own client
        // or somebody poking at the protocol.
        client.room?.relayVoice(client, msg);
        break;
      case 'sync': if (client.room) client.room.sendState(client.side); break;
    }
  });

  // Passing ws lets detach() ignore a socket the player has already replaced.
  // See the comment there: without it, a late close event unseats a live
  // session and the player waits forever on a match that will never be made.
  ws.on('close', () => { if (client) hub.detach(client, ws); });
  ws.on('error', () => { if (client) hub.detach(client, ws); });
});

// Drop sockets that stopped answering. A phone that loses signal leaves a
// socket that looks open for a long time; without this the online count drifts
// upward all day and abandoned games never resolve.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* going away anyway */ }
  }
}, 30_000).unref();
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

/* Bring the schema up to date before taking traffic.

   This used to be a manual `npm run db:push`, and nothing in the deploy runs
   it: Render builds with npm ci and starts with npm start. So the first time a
   column was added — users.plus — the code that reads it went live against a
   database that had never heard of it, and every login answered 500 while the
   game itself carried on looking perfectly healthy. A schema change that needs
   a step nobody performs is a schema change that does not happen.

   Safe to repeat: every statement in schema.sql is guarded with IF NOT EXISTS,
   so this is a few milliseconds of no-ops on a database that is already
   current. And it must not be fatal — if the database is unreachable the game
   should still open and still play, because guests and AI games need nothing
   from it; only the parts that use accounts should suffer. */
try {
  await migrate();
} catch (err) {
  console.error('schema not applied:', err.message, '— accounts may not work');
}

server.listen(PORT, () => {
  console.log(`solrush listening on http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('shutting down');
    hub.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
