const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSession, sessionValid, passwordMatches, readCookie, safeNext, SESSION_MS } = require('../auth.js');

test('sessions are valid until they expire', () => {
  const now = Date.now();
  const session = makeSession('hunter2', now);
  assert.equal(sessionValid(session, 'hunter2', now), true);
  assert.equal(sessionValid(session, 'hunter2', now + SESSION_MS + 1), false);
});

test('tampered sessions and changed passwords are rejected', () => {
  const session = makeSession('hunter2');
  const [expiry, signature] = session.split('.');
  assert.equal(sessionValid(`${Number(expiry) + 1000}.${signature}`, 'hunter2'), false);
  assert.equal(sessionValid(`${expiry}.${'0'.repeat(64)}`, 'hunter2'), false);
  assert.equal(sessionValid(session, 'new-password'), false);
  assert.equal(sessionValid('garbage', 'hunter2'), false);
  assert.equal(sessionValid(session, ''), false);
});

test('password comparison and cookie parsing', () => {
  assert.equal(passwordMatches('hunter2', 'hunter2'), true);
  assert.equal(passwordMatches('hunter', 'hunter2'), false);
  assert.equal(passwordMatches('anything', ''), false);
  assert.equal(readCookie('a=1; lattice_session=abc.def; b=2'), 'abc.def');
  assert.equal(readCookie('a=1'), null);
});

test('redirects after login stay on this site', () => {
  assert.equal(safeNext('/app?ticker=AAPL'), '/app?ticker=AAPL');
  assert.equal(safeNext('//evil.example'), '/app');
  assert.equal(safeNext('/\\evil.example'), '/app');
  assert.equal(safeNext('https://evil.example'), '/app');
  assert.equal(safeNext(null), '/app');
});
