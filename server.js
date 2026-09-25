const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fetchCompanyData, fetchQuote, fetchProfile, combine, fetchFredSeries, fetchFredLatest, monthlyPrices, ProviderError } = require('./provider');
const auth = require('./auth');

const root = __dirname;
// The personal homepage is a separate site (github.com/nmann06/homepage).
const HOMEPAGE = 'https://nathanielmann.ca/';
const files = {
  '/app': ['research.html', 'text/html; charset=utf-8'],
  '/research.html': ['research.html', 'text/html; charset=utf-8'],
  '/login.css': ['login.css', 'text/css; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/math.js': ['math.js', 'text/javascript; charset=utf-8'],
  '/sample-data.csv': ['sample-data.csv', 'text/csv; charset=utf-8']
};
// The investment tool and its API sit behind the password; only the sign-in page is public.
const protectedFiles = new Set(['/app', '/research.html', '/styles.css', '/app.js', '/math.js', '/sample-data.csv']);
const cache = new Map();
const inFlight = new Map();
let market = null;
let marketInFlight = null;
const profiles = new Map();
const MAX_PROFILES = 200;
const quotes = new Map();
const quoteFlights = new Map();
const cacheDurationMs = 24 * 60 * 60 * 1000;
const QUOTE_MS = 60 * 1000;
const MAX_QUOTES = 500;
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

// Cboe and the SEC have no quota, but uncached company loads are still limited to 60 per visitor per hour
// so one visitor can't hammer either service. Quote refreshes are cached and not counted.
function allowLookup(request) {
  const now = Date.now();
  const ip = clientIp(request);
  const previous = (ipLookups.get(ip) || []).filter((time) => time > now - 3600000);
  if (previous.length >= 60) return false;
  previous.push(now);
  ipLookups.set(ip, previous);
  return true;
}

// Every visitor shares one Cboe quote request per symbol per minute. On failure the last quote is reused.
async function latestQuote(symbol) {
  const saved = quotes.get(symbol);
  if (saved && Date.now() - saved.time < QUOTE_MS) return saved.quote;
  if (!quoteFlights.has(symbol)) quoteFlights.set(symbol, fetchQuote(symbol).catch(() => null).finally(() => quoteFlights.delete(symbol)));
  const quote = await quoteFlights.get(symbol);
  if (!quote) return saved?.quote || null;
  quotes.delete(symbol);
  quotes.set(symbol, { time: Date.now(), quote });
  while (quotes.size > MAX_QUOTES) quotes.delete(quotes.keys().next().value);
  return quote;
}

// Risk-free rate and a market proxy for beta, both from FRED's keyless CSV downloads. Refreshed daily.
// Month-end S&P 500 values are sent so the browser can calculate beta; the tool never displays the index itself.
async function loadMarket() {
  const options = { userAgent: setting('SEC_USER_AGENT') };
  const [treasury, index] = await Promise.all([
    fetchFredLatest('DGS10', options).catch(() => null),
    fetchFredSeries('SP500', options).catch(() => null)
  ]);
  const riskFree = treasury ? { rate: treasury.value / 100, date: treasury.date, source: 'FRED DGS10 (10-year Treasury)' } : market?.riskFree || null;
  const benchmark = index ? { name: 'S&P 500', rows: monthlyPrices(index.map((item) => ({ date: item.date, close: item.value }))) } : market?.benchmark || null;
  return { time: Date.now(), riskFree, benchmark };
}

async function handleMarket(request, response) {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
  if (!market || Date.now() - market.time > cacheDurationMs) {
    if (!marketInFlight) marketInFlight = loadMarket().finally(() => { marketInFlight = null; });
    market = await marketInFlight;
  }
  return sendJson(response, 200, { riskFree: market.riskFree, benchmark: market.benchmark });
}

// Two levels of data per ticker:
//   sec  — SEC filings only
//   full — plus Cboe's daily price history and the latest delayed quote
// Filings and history are cached for a day; the quote is refreshed at most once a minute per symbol.
const DEPTHS = { sec: 0, full: 1 };

// Combining is cheap, so each response is rebuilt from the cached data with the latest quote.
async function respondWithCompany(response, symbol, data, extra = {}) {
  const quote = data.depth === 'full' ? await latestQuote(symbol) : null;
  return sendJson(response, 200, { ...combine({ ...data, quote }), ...extra });
}

async function handleCompany(request, response, url) {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return sendJson(response, 400, { error: 'Enter a valid ticker.' });
  let depth = url.searchParams.get('depth') || 'full';
  // Older clients ask for 'price' or 'peer'; the full history now costs the same single request.
  if (depth === 'price' || depth === 'peer') depth = 'full';
  if (!(depth in DEPTHS)) return sendJson(response, 400, { error: 'Unknown data depth.' });
  const saved = cache.get(symbol);
  const deepEnough = saved && DEPTHS[saved.data.depth] >= DEPTHS[depth];
  try {
    if (deepEnough && Date.now() - saved.time < cacheDurationMs) return await respondWithCompany(response, symbol, saved.data);
    const flight = `${symbol}:${depth}`;
    if (!inFlight.has(flight)) {
      if (!allowLookup(request)) {
        if (deepEnough) return await respondWithCompany(response, symbol, saved.data, { stale: true });
        return sendJson(response, 429, { error: 'Too many new tickers in the last hour. Try again shortly.' });
      }
      inFlight.set(flight, fetchCompanyData(symbol, { userAgent: setting('SEC_USER_AGENT'), withPrices: depth === 'full' }).finally(() => inFlight.delete(flight)));
    }
    const data = await inFlight.get(flight);
    const current = cache.get(symbol);
    if (!current || Date.now() - current.time >= cacheDurationMs || DEPTHS[data.depth] >= DEPTHS[current.data.depth]) cache.set(symbol, { time: Date.now(), data });
    return await respondWithCompany(response, symbol, data);
  } catch (error) {
    if (deepEnough) return respondWithCompany(response, symbol, saved.data, { stale: true }).catch(() => sendJson(response, 502, { error: 'Could not load market data.' }));
    const status = error instanceof ProviderError ? error.status : 502;
    return sendJson(response, status, { error: error instanceof ProviderError ? error.message : 'Could not load market data.' });
  }
}

// The business description from the latest 10-K. It changes once a year, so it is cached for a day like company data.
async function handleProfile(request, response, url) {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return sendJson(response, 400, { error: 'Enter a valid ticker.' });
  const saved = profiles.get(symbol);
  if (saved && Date.now() - saved.time < cacheDurationMs) return sendJson(response, 200, saved.profile);
  const flight = `${symbol}:profile`;
  if (!inFlight.has(flight)) {
    if (!allowLookup(request)) return saved ? sendJson(response, 200, saved.profile) : sendJson(response, 429, { error: 'Too many lookups in the last hour. Try again shortly.' });
    inFlight.set(flight, fetchProfile(symbol, { userAgent: setting('SEC_USER_AGENT') }).finally(() => inFlight.delete(flight)));
  }
  try {
    const profile = await inFlight.get(flight);
    profiles.delete(symbol);
    profiles.set(symbol, { time: Date.now(), profile });
    while (profiles.size > MAX_PROFILES) profiles.delete(profiles.keys().next().value);
    return sendJson(response, 200, profile);
  } catch (error) {
    if (saved) return sendJson(response, 200, saved.profile);
    const status = error instanceof ProviderError ? error.status : 502;
    return sendJson(response, status, { error: error instanceof ProviderError ? error.message : 'Could not load the company description.' });
  }
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(response, 200, { ok: true });
  if (url.pathname === '/login') return handleLogin(request, response, url);
  if (url.pathname === '/') return redirect(response, `/app${url.search}`);
  if (url.pathname === '/logout') return redirect(response, HOMEPAGE, { 'Set-Cookie': `${auth.COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  const isApi = url.pathname.startsWith('/api/');
  if ((isApi || protectedFiles.has(url.pathname)) && !signedIn(request)) {
    if (isApi) return sendJson(response, 401, { error: 'Your session has ended. Reload the page to sign in again.' });
    return redirect(response, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  if (url.pathname === '/api/status') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    return sendJson(response, 200, { provider: 'Cboe + SEC EDGAR', configured: true, fundamentals: true, signOut: authRequired() });
  }
  if (url.pathname === '/api/company') return handleCompany(request, response, url);
  if (url.pathname === '/api/market') return handleMarket(request, response);
  if (url.pathname === '/api/profile') return handleProfile(request, response, url);
  const file = files[url.pathname];
  if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') { response.end(); return; }
  fs.createReadStream(path.join(root, file[0])).pipe(response);
}).listen(Number(process.env.PORT) || 4173, process.env.RENDER ? '0.0.0.0' : '127.0.0.1', () => console.log(`Lettuce listening on port ${Number(process.env.PORT) || 4173}`));
