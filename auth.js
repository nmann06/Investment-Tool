const crypto = require('node:crypto');

const COOKIE = 'lattice_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const sign = (password, expiry) => crypto.createHmac('sha256', `lattice:${password}`).update(String(expiry)).digest('hex');

function makeSession(password, now = Date.now()) {
  const expiry = now + SESSION_MS;
  return `${expiry}.${sign(password, expiry)}`;
}

function sessionValid(value, password, now = Date.now()) {
  if (!password || typeof value !== 'string') return false;
  const [expiryText, signature] = value.split('.');
  const expiry = Number(expiryText);
  if (!Number.isFinite(expiry) || expiry < now || !/^[0-9a-f]{64}$/.test(signature || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(password, expiry), 'hex'));
}

// Hashing first gives equal-length buffers, so the comparison time does not reveal the password length.
function passwordMatches(submitted, password) {
  if (!password || typeof submitted !== 'string') return false;
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(submitted), hash(password));
}

function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

// Only same-site paths are allowed after login, never another origin.
function safeNext(value) {
  return typeof value === 'string' && /^\/(?![\/\\])/.test(value) ? value : '/app';
}

module.exports = { COOKIE, SESSION_MS, makeSession, sessionValid, passwordMatches, readCookie, safeNext };
