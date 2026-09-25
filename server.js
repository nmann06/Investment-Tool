const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fetchCompany, ProviderError } = require('./provider');

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
const cache = new Map();
const inFlight = new Map();
const cacheDurationMs = 24 * 60 * 60 * 1000;
const lookups = [];
const ipLookups = new Map();

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

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

function allowLookup(request) {
  const now = Date.now();
  while (lookups.length && lookups[0] < now - 86400000) lookups.shift();
  if (lookups.length >= 20) return false;
  const ip = process.env.RENDER ? String(request.headers['x-forwarded-for'] || request.socket.remoteAddress).split(',')[0].trim() : request.socket.remoteAddress;
  const previous = (ipLookups.get(ip) || []).filter((time) => time > now - 3600000);
  if (previous.length >= 6) return false;
  previous.push(now);
  ipLookups.set(ip, previous);
  lookups.push(now);
  return true;
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(response, 200, { ok: true });
  if (url.pathname === '/api/status') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    return sendJson(response, 200, { provider: 'FinancialData.net + SEC EDGAR', configured: Boolean(apiKey()), fundamentals: true });
  }
  if (url.pathname === '/api/company') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return sendJson(response, 400, { error: 'Enter a valid ticker.' });
    const key = apiKey();
    if (!key) return sendJson(response, 503, { error: 'Add FINANCIALDATA_API_KEY to the server configuration.' });
    const saved = cache.get(symbol);
    if (saved && Date.now() - saved.time < cacheDurationMs) return sendJson(response, 200, saved.company);
    if (!inFlight.has(symbol) && !allowLookup(request)) return sendJson(response, 429, { error: 'The public demo’s live-data allowance has been used. Try again later.' });
    try {
      if (!inFlight.has(symbol)) inFlight.set(symbol, fetchCompany(symbol, key, { userAgent: setting('SEC_USER_AGENT') }));
      const company = await inFlight.get(symbol);
      cache.set(symbol, { time: Date.now(), company });
      return sendJson(response, 200, company);
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 502;
      return sendJson(response, status, { error: error instanceof ProviderError ? error.message : 'Could not load market data.' });
    } finally {
      inFlight.delete(symbol);
    }
  }
  const file = files[url.pathname];
  if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') { response.end(); return; }
  fs.createReadStream(path.join(root, file[0])).pipe(response);
}).listen(Number(process.env.PORT) || 4173, process.env.RENDER ? '0.0.0.0' : '127.0.0.1', () => console.log(`Lattice listening on port ${Number(process.env.PORT) || 4173}`));
