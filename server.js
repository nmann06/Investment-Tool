const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fetchCompany, ProviderError, MAX_PAGES } = require('./provider');
const auth = require('./auth');

const root = __dirname;
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/about': ['index.html', 'text/html; charset=utf-8'],
  '/portfolio': ['index.html', 'text/html; charset=utf-8'],
  '/app': ['research.html', 'text/html; charset=utf-8'],
  '/research.html': ['research.html', 'text/html; charset=utf-8'],
  '/site.css': ['site.css', 'text/css; charset=utf-8'],
  '/site.js': ['site.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/math.js': ['math.js', 'text/javascript; charset=utf-8'],
  '/sample-data.csv': ['sample-data.csv', 'text/csv; charset=utf-8']
};
// The investment tool and its API sit behind the password; the personal site stays public.
const protectedFiles = new Set(['/app', '/research.html', '/styles.css', '/app.js', '/math.js', '/sample-data.csv']);
const cache = new Map();
const inFlight = new Map();
const priceHistory = new Map();
const cacheDurationMs = 24 * 60 * 60 * 1000;
const DAILY_PROVIDER_BUDGET = 280;
const MAX_PRICE_HISTORIES = 150;
const providerCalls = [];
const ipLookups = new Map();
const failedLogins = new Map();

function setting(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const lines = fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/);
    const line = lines.find((item) => new RegExp(`^${name}\\s*=`).test(item));
    const value = line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
    return value === 'your_key_here' ? '' : value;
  } catch { return ''; }
}
const apiKey = () => setting('FINANCIALDATA_API_KEY');
const appPassword = () => setting('APP_PASSWORD');
// Locally the tool is open unless a password is set. On Render it always requires one.
const authRequired = () => Boolean(appPassword()) || Boolean(process.env.RENDER);
const signedIn = (request) => !authRequired() || auth.sessionValid(auth.readCookie(request.headers.cookie), appPassword());

function clientIp(request) {
  return process.env.RENDER ? String(request.headers['x-forwarded-for'] || request.socket.remoteAddress).split(',')[0].trim() : request.socket.remoteAddress;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  response.end();
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function sendLogin(response, status, next, error = '') {
  const html = fs.readFileSync(path.join(root, 'login.html'), 'utf8').replace('{{NEXT}}', escapeHtml(next)).replace('{{ERROR}}', escapeHtml(error));
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
  response.end(html);
}

function readForm(request, limit = 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; if (body.length > limit) { reject(Error('Too large')); request.destroy(); } });
    request.on('end', () => resolve(new URLSearchParams(body)));
    request.on('error', reject);
  });
}

function recentFailures(ip, now = Date.now()) {
  const recent = (failedLogins.get(ip) || []).filter((time) => time > now - 15 * 60000);
  failedLogins.set(ip, recent);
  return recent;
}

async function handleLogin(request, response, url) {
  if (request.method === 'GET') {
    const next = auth.safeNext(url.searchParams.get('next'));
    return signedIn(request) ? redirect(response, next) : sendLogin(response, 200, next);
  }
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
  let form;
  try { form = await readForm(request); } catch { return sendJson(response, 413, { error: 'Request too large.' }); }
  const next = auth.safeNext(form.get('next'));
  const password = appPassword();
  if (!password) return sendLogin(response, 503, next, 'The site password has not been configured on the server.');
  const ip = clientIp(request);
  const failures = recentFailures(ip);
  if (failures.length >= 10) return sendLogin(response, 429, next, 'Too many attempts. Try again in 15 minutes.');
  if (!auth.passwordMatches(form.get('password') || '', password)) {
    failures.push(Date.now());
    return sendLogin(response, 401, next, 'That password is not correct.');
  }
  failedLogins.delete(ip);
  const cookie = `${auth.COOKIE}=${auth.makeSession(password)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.SESSION_MS / 1000}${process.env.RENDER ? '; Secure' : ''}`;
  return redirect(response, next, { 'Set-Cookie': cookie });
}

function providerBudgetLeft(now = Date.now()) {
  while (providerCalls.length && providerCalls[0] < now - 86400000) providerCalls.shift();
  return DAILY_PROVIDER_BUDGET - providerCalls.length;
}

// A new ticker costs up to MAX_PAGES provider calls; refreshing one with stored history usually costs 1.
function allowLookup(request, cost) {
  const now = Date.now();
  if (providerBudgetLeft(now) < cost) return false;
  const ip = clientIp(request);
  const previous = (ipLookups.get(ip) || []).filter((time) => time > now - 3600000);
  if (previous.length >= 6) return false;
  previous.push(now);
  ipLookups.set(ip, previous);
  return true;
}

function keepPrices(symbol, records) {
  priceHistory.delete(symbol);
  priceHistory.set(symbol, records.map((row) => ({ date: row.date, close: row.close })));
  while (priceHistory.size > MAX_PRICE_HISTORIES) priceHistory.delete(priceHistory.keys().next().value);
}

async function handleCompany(request, response, url) {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return sendJson(response, 400, { error: 'Enter a valid ticker.' });
  const key = apiKey();
  if (!key) return sendJson(response, 503, { error: 'Add FINANCIALDATA_API_KEY to the server configuration.' });
  const saved = cache.get(symbol);
  if (saved && Date.now() - saved.time < cacheDurationMs) return sendJson(response, 200, saved.company);
  const known = priceHistory.get(symbol) || [];
  if (!inFlight.has(symbol) && !allowLookup(request, known.length ? 1 : MAX_PAGES)) {
    if (saved) return sendJson(response, 200, { ...saved.company, stale: true });
    return sendJson(response, 429, { error: 'Today’s live-data allowance has been used. Try again tomorrow.' });
  }
  try {
    if (!inFlight.has(symbol)) {
      inFlight.set(symbol, fetchCompany(symbol, key, {
        userAgent: setting('SEC_USER_AGENT'),
        knownPrices: known,
        onRequest: () => providerCalls.push(Date.now()),
        onPrices: (records) => keepPrices(symbol, records)
      }));
    }
    const company = await inFlight.get(symbol);
    cache.set(symbol, { time: Date.now(), company });
    return sendJson(response, 200, company);
  } catch (error) {
    if (saved) return sendJson(response, 200, { ...saved.company, stale: true });
    const status = error instanceof ProviderError ? error.status : 502;
    return sendJson(response, status, { error: error instanceof ProviderError ? error.message : 'Could not load market data.' });
  } finally {
    inFlight.delete(symbol);
  }
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(response, 200, { ok: true });
  if (url.pathname === '/login') return handleLogin(request, response, url);
  if (url.pathname === '/logout') return redirect(response, '/', { 'Set-Cookie': `${auth.COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  const isApi = url.pathname.startsWith('/api/');
  if ((isApi || protectedFiles.has(url.pathname)) && !signedIn(request)) {
    if (isApi) return sendJson(response, 401, { error: 'Your session has ended. Reload the page to sign in again.' });
    return redirect(response, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  if (url.pathname === '/api/status') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    return sendJson(response, 200, { provider: 'FinancialData.net + SEC EDGAR', configured: Boolean(apiKey()), fundamentals: true, signOut: authRequired() });
  }
  if (url.pathname === '/api/company') return handleCompany(request, response, url);
  const file = files[url.pathname];
  if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') { response.end(); return; }
  fs.createReadStream(path.join(root, file[0])).pipe(response);
}).listen(Number(process.env.PORT) || 4173, process.env.RENDER ? '0.0.0.0' : '127.0.0.1', () => console.log(`Lattice listening on port ${Number(process.env.PORT) || 4173}`));
