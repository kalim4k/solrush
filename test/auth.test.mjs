// Password hashing and token signing, with no database in sight.
//
// These exist because of a bug that nothing else would have caught: the scrypt
// parameters needed exactly Node's default memory ceiling, so every hash threw
// and the first real signup came back "server_error". It was invisible until a
// live registration hit it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// credentials.js exits the process without a secret, so it has to be set before
// the module is evaluated — which, imports being hoisted, means a dynamic
// import after the assignment rather than a static one at the top.
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-to-pass';

const { hashPassword, verifyPassword, issueToken, readToken, checkEmail, checkPassword } =
  await import('../server/credentials.js');

test('a password can actually be hashed', async () => {
  // The regression. Without maxmem this throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
});

test('the right password verifies and the wrong one does not', async () => {
  const hash = await hashPassword('hunter2-hunter2');
  assert.equal(await verifyPassword('hunter2-hunter2', hash), true);
  assert.equal(await verifyPassword('hunter2-hunter3', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('two hashes of one password differ', async () => {
  // Same output twice would mean the salt is not doing its job, and the table
  // becomes searchable by frequency.
  const a = await hashPassword('same-password-twice');
  const b = await hashPassword('same-password-twice');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password-twice', a), true);
  assert.equal(await verifyPassword('same-password-twice', b), true);
});

test('a malformed hash is refused rather than crashing', async () => {
  for (const junk of ['', 'nonsense', 'scrypt$x$y$z$q$r', '$$$$$', null, undefined]) {
    assert.equal(await verifyPassword('anything', junk), false);
  }
});

test('a token round-trips', () => {
  const token = issueToken({ id: 'abc-123', nick: 'Tester' });
  const payload = readToken(token);
  assert.equal(payload.sub, 'abc-123');
  assert.equal(payload.nick, 'Tester');
});

test('a tampered token is refused', () => {
  const token = issueToken({ id: 'abc-123', nick: 'Tester' });
  const [h, p, s] = token.split('.');

  // Swap the subject for somebody else's and re-encode — the signature no
  // longer matches, which is the whole point of signing it.
  const forged = Buffer.from(JSON.stringify({
    sub: 'somebody-else', nick: 'Tester',
    iat: 0, exp: Math.floor(Date.now() / 1000) + 999,
  })).toString('base64url');

  assert.equal(readToken(`${h}.${forged}.${s}`), null, 'payload swap');
  assert.equal(readToken(`${h}.${p}.${s}x`), null, 'signature edit');
  assert.equal(readToken('not.a.token'), null);
  assert.equal(readToken(''), null);
  assert.equal(readToken(null), null);
});

test('an expired token is refused', () => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: 'x', exp: 1 })).toString('base64url');
  // Signed correctly, but stale — expiry is checked after the signature, and
  // both have to fail it.
  assert.equal(readToken(`${h}.${p}.whatever`), null);
});

test('email and password rules', () => {
  assert.equal(checkEmail('Someone@Example.COM'), 'someone@example.com');
  assert.equal(checkEmail('no-at-sign'), null);
  assert.equal(checkEmail('a@b'), null, 'needs a dot in the domain');
  assert.equal(checkEmail(''), null);

  assert.equal(checkPassword('12345678'), true);
  assert.equal(checkPassword('1234567'), false);
  assert.equal(checkPassword(''), false);
});
