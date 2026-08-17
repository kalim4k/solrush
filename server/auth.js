// Account operations: the ones that touch the database.
//
// The cryptography and the format rules live in credentials.js, which imports
// nothing and can therefore be tested on its own. This file is the half that
// needs Postgres.

import { randomBytes } from 'node:crypto';
import { q, one } from './db.js';
import {
  hashPassword, verifyPassword, issueToken, readToken, checkEmail, checkPassword,
} from './credentials.js';

// Re-exported so callers keep importing "auth" for anything account-shaped and
// do not have to know where the seam falls.
export {
  hashPassword, verifyPassword, issueToken, readToken, checkEmail, checkPassword,
};

export async function register(email, password, nick) {
  const e = checkEmail(email);
  if (!e) return { error: 'bad_email' };
  if (!checkPassword(password)) return { error: 'weak_password' };

  const hash = await hashPassword(password);
  try {
    const user = await one(
      `INSERT INTO users (email, pass_hash, nick)
       VALUES ($1, $2, $3)
       RETURNING id, email, nick, points, wins, losses, veteran`,
      [e, hash, nick],
    );
    return { user, token: issueToken(user) };
  } catch (err) {
    // 23505 = unique violation. Which column collided decides the message, and
    // guessing wrong tells someone their own email is "already taken" when it
    // was really the nickname.
    if (err.code === '23505') {
      const where = `${err.constraint || ''} ${err.detail || ''}`;
      return { error: /nick/i.test(where) ? 'nick_taken' : 'email_taken' };
    }
    throw err;
  }
}

export async function login(email, password) {
  const e = checkEmail(email);
  if (!e) return { error: 'bad_credentials' };
  const user = await one(
    `SELECT id, email, nick, pass_hash, points, wins, losses, veteran
       FROM users WHERE email = $1`,
    [e],
  );
  // Hash anyway when the account does not exist, so a missing address and a
  // wrong password take the same time to answer. Otherwise the response time
  // alone tells an attacker which emails are registered.
  if (!user) {
    await hashPassword(password);
    return { error: 'bad_credentials' };
  }
  if (!(await verifyPassword(password, user.pass_hash))) return { error: 'bad_credentials' };

  await q('UPDATE users SET last_seen = now() WHERE id = $1', [user.id]);
  delete user.pass_hash;
  return { user, token: issueToken(user) };
}

export async function userById(id) {
  return one(
    `SELECT id, email, nick, points, wins, losses, veteran, plus, skin, badge, pixel, pack, finish
       FROM users WHERE id = $1`,
    [id],
  );
}

/* ================= password reset ================= */

export async function startReset(email) {
  const e = checkEmail(email);
  if (!e) return null;
  const user = await one('SELECT id FROM users WHERE email = $1', [e]);
  if (!user) return null;   // the caller answers "sent" either way
  const token = randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO reset_tokens (token, user_id, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [token, user.id],
  );
  return token;
}

export async function finishReset(token, newPassword) {
  if (!checkPassword(newPassword)) return { error: 'weak_password' };
  const row = await one(
    `SELECT user_id FROM reset_tokens
      WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
    [token],
  );
  if (!row) return { error: 'bad_token' };
  const hash = await hashPassword(newPassword);
  await q('UPDATE users SET pass_hash = $1 WHERE id = $2', [hash, row.user_id]);
  // Burn the token, and every other outstanding one for this account: if a
  // reset was requested because the mailbox was compromised, the older links
  // must not still work.
  await q('UPDATE reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
    [row.user_id]);
  return { ok: true };
}
