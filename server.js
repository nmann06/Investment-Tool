const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchCompany, ProviderError } = require('./provider');

const root = __dirname;
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/math.js': ['math.js', 'text/javascript; charset=utf-8'],
  '/sample-data.csv': ['sample-data.csv', 'text/csv; charset=utf-8']
};
const cache = new Map();
const cacheDurationMs = 12 * 60 * 60 * 1000;

function apiKey() {
  if (process.env.ALPHA_VANTAGE_API_KEY) return process.env.ALPHA_VANTAGE_API_KEY.trim();
  try {
    const lines = fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/);
    const line = lines.find((item) => /^ALPHA_VANTAGE_API_KEY\s*=/.test(item));
    const value = line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
    return value === 'your_key_here' ? '' : value;
  } catch { return ''; }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

function authorized(request, response) {
  if (!process.env.RENDER) return true;
  const password = process.env.APP_PASSWORD;
  if (!password) { sendJson(response, 503, { error: 'APP_PASSWORD is required on Render.' }); return false; }
  const expected = Buffer.from(`Basic ${Buffer.from(`lattice:${password}`).toString('base64')}`);
  const actual = Buffer.from(request.headers.authorization || '');
  if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return true;
  response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Lattice"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end('Enter the Lattice site username and password.');
  return false;
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(response, 200, { ok: true });
  if (!authorized(request, response)) return;
  if (url.pathname === '/api/status') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    return sendJson(response, 200, { provider: 'Alpha Vantage', configured: Boolean(apiKey()) });
  }
  if (url.pathname === '/api/company') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return sendJson(response, 400, { error: 'Enter a valid ticker.' });
    const key = apiKey();
    if (!key) return sendJson(response, 503, { error: 'Add ALPHA_VANTAGE_API_KEY to .env.local and restart the server.' });
    const saved = cache.get(symbol);
    if (saved && Date.now() - saved.time < cacheDurationMs) return sendJson(response, 200, saved.company);
    try {
      const company = await fetchCompany(symbol, key);
      cache.set(symbol, { time: Date.now(), company });
      return sendJson(response, 200, company);
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 502;
      return sendJson(response, status, { error: error instanceof ProviderError ? error.message : 'Could not load market data.' });
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
