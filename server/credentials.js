// Password hashing, token signing, and the two format rules — everything that
// is pure computation over its arguments.
//
// Split out of auth.js because that file talks to Postgres, and a module that
// opens a connection pool at import time cannot be unit-tested: checking that
// scrypt produces a hash would have required a database. It also happens to be
// the right seam — this is the part with no I/O and the part most worth being
// sure about.
//
// No bcrypt or argon2 dependency: both are native modules that need a compiler
// on Windows, and scrypt is in Node's own crypto, is memory-hard, and is what
// you would reach for anyway. No jsonwebtoken either — an HS256 token is a
// hundred lines of nothing and one fewer supply-chain risk.

import {
  randomBytes, scrypt as _scrypt, timingSafeEqual, createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

const SECRET = process.env.JWT_SECRET || '';
if (!SECRET || SECRET.length < 24) {
  console.error('JWT_SECRET is missing or too short (need 24+ chars). See .env.example.');
  process.exit(1);
}
const TOKEN_DAYS = 30;

/* ================= passwords ================= */

/* N=2^15 is about 100 ms per hash on a small server: slow enough to make a
   stolen table worthless, fast enough that logging in feels instant.

   maxmem is not optional here. scrypt needs 128 * N * r bytes — with these
   parameters exactly 32 MiB — and Node's default ceiling is also 32 MiB, so
   the allocation lands a hair over it and every single call throws
   ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Nothing catches that in development
   because nothing registers in development; it surfaces as "server_error" on
   the first real signup. Raised to 64 MiB, which leaves room to increase N
   later without meeting the same wall. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(keyB64, 'base64url');
    if (!expected.length) return false;
    // The parameters come from the stored hash so that old rows keep verifying
    // after SCRYPT is tuned — but maxmem is ours, not theirs, and must be at
    // least as generous as the ceiling those parameters were written under.
    const actual = await scrypt(plain, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    // Length-safe: timingSafeEqual throws on a mismatch rather than returning
    // false, and a thrown error here would read as a server fault, not a wrong
    // password.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ================= tokens ================= */

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function sign(data) {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function issueToken(user) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    sub: user.id,
    nick: user.nick,
    iat: now,
    exp: now + TOKEN_DAYS * 86400,
  });
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

// Returns the payload, or null. Never throws — it is fed raw input from every
// request and from every WebSocket hello.
export function readToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const want = Buffer.from(sign(`${h}.${p}`));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ================= validation ================= */

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

export function checkEmail(email) {
  const e = String(email || '').trim();
  if (!EMAIL_RE.test(e) || e.length > 254) return null;
  return e.toLowerCase();
}

// Deliberately permissive on characters and firm on length: a password rule
// that demands a symbol mostly produces "Password1!" everywhere.
export function checkPassword(pw) {
  const s = String(pw || '');
  return s.length >= 8 && s.length <= 200;
}
