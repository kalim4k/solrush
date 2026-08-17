// Grant or revoke SolRush Plus on an account, by email.
//
//   node scripts/set-plus.mjs someone@example.com          -> grant
//   node scripts/set-plus.mjs someone@example.com off      -> revoke
//
// Until a payment processor is wired in, this is how a buyer gets what they
// paid for. It prints the row before and after, and refuses an address that
// does not exist rather than reporting a cheerful "0 rows updated" — the usual
// way this goes wrong is a typo in the address, which looks identical to
// success from the outside.

import './../server/boot-env.js';
import { one, close } from '../server/db.js';

const email = process.argv[2];
const on = process.argv[3] !== 'off';

if (!email) {
  console.error('usage: node scripts/set-plus.mjs <email> [off]');
  process.exit(1);
}

const before = await one('SELECT id, email, nick, plus FROM users WHERE email = $1', [email]);
if (!before) {
  console.error(`no account with that address: ${email}`);
  console.error('the player has to register first — Plus is a flag on a user row.');
  await close();
  process.exit(1);
}

console.log(`before: ${before.nick} <${before.email}> plus=${before.plus}`);
const after = await one(
  'UPDATE users SET plus = $2 WHERE id = $1 RETURNING id, email, nick, plus',
  [before.id, on],
);
console.log(`after:  ${after.nick} <${after.email}> plus=${after.plus}`);
await close();
