const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSplits, buildFundamentals, valueAt, combine, fetchPrices, fetchCompany } = require('../provider.js');

// Simulated provider: `days` daily closes, newest first, served 300 per page.
function priceServer(days, price = () => 100) {
  const all = Array.from({ length: days }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 1) - index * 86400000).toISOString().slice(0, 10), close: price(index) }));
  const calls = [];
  const fetchImpl = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    calls.push(offset);
    return { ok: true, status: 200, json: async () => all.slice(offset, offset + 300) };
  };
  return { all, calls, fetchImpl };
}

test('a first price fetch pages through the full history', async () => {
  const server = priceServer(1000);
  let counted = 0;
  const records = await fetchPrices('TEST', 'key', server.fetchImpl, [], () => counted++);
  assert.equal(records.length, 1000);
  assert.deepEqual(server.calls, [0, 300, 600, 900]);
  assert.equal(counted, 4);
});

test('a refresh with stored history costs one request and merges without duplicates', async () => {
  const server = priceServer(1000);
  const known = server.all.slice(5);
  const records = await fetchPrices('TEST', 'key', server.fetchImpl, known);
  assert.deepEqual(server.calls, [0]);
  assert.equal(records.length, 1000);
  assert.equal(new Set(records.map((row) => row.date)).size, 1000);
  assert.equal(records[0].date, server.all[0].date);
});

test('a split since the last fetch discards the stored history', async () => {
  const server = priceServer(1000, () => 50);
  const known = server.all.slice(5).map((row) => ({ ...row, close: 100 }));
  const records = await fetchPrices('TEST', 'key', server.fetchImpl, known);
  assert.deepEqual(server.calls, [0, 0, 300, 600, 900]);
  assert.ok(records.every((row) => row.close === 50));
});

const fact = (start, end, val, filed, form = '10-Q') => ({ start, end, val, filed, form });
const gaap = (eps, dividends = []) => ({
  EarningsPerShareDiluted: { units: { 'USD/shares': eps } },
  ...(dividends.length ? { CommonStockDividendsPerShareDeclared: { units: { 'USD/shares': dividends } } } : {})
});

// Four quarters of 2023 reported before a 4-for-1 split, then restated in 2024 filings.
const splitHistory = [
  fact('2023-01-01', '2023-03-31', 4.0, '2023-05-01'),
  fact('2023-04-01', '2023-06-30', 4.4, '2023-08-01'),
  fact('2023-07-01', '2023-09-30', 4.8, '2023-11-01'),
  fact('2023-01-01', '2023-09-30', 13.2, '2023-11-01'),
  fact('2023-01-01', '2023-12-31', 18.4, '2024-02-01', '10-K'),
  fact('2024-01-01', '2024-03-31', 1.3, '2024-05-01'),
  fact('2023-01-01', '2023-03-31', 1.0, '2024-05-01'),
  fact('2024-04-01', '2024-06-30', 1.4, '2024-08-01'),
  fact('2023-04-01', '2023-06-30', 1.1, '2024-08-01')
];

test('restated per-share figures reveal a split and its date', () => {
  const facts = splitHistory.map((item) => ({ ...item, tag: 'EarningsPerShareDiluted', priority: 0 }));
  const splits = detectSplits(facts);
  assert.equal(splits.length, 1);
  assert.equal(splits[0].ratio, 4);
  assert.equal(splits[0].date, '2024-05-01');
});

test('a single ordinary restatement is not treated as a split', () => {
  const facts = [fact('2023-01-01', '2023-12-31', 2.0, '2024-02-01', '10-K'), fact('2023-01-01', '2023-12-31', 1.0, '2025-02-01', '10-K')]
    .map((item) => ({ ...item, tag: 'EarningsPerShareDiluted', priority: 0 }));
  assert.deepEqual(detectSplits(facts), []);
});

test('fundamentals are restated to today\'s share basis with a derived fourth quarter', () => {
  const result = buildFundamentals(gaap(splitHistory));
  const fy = result.annual.find((item) => item.end === '2023-12-31');
  assert.ok(Math.abs(fy.eps - 4.6) < 1e-9);
  const ttm = new Map(result.eps.map((point) => [point.date, point.value]));
  assert.ok(Math.abs(ttm.get('2023-12-31') - 4.6) < 1e-9);
  // Q2-2023..Q1-2024: 1.1 + 1.2 + (4.6 - 3.3) + 1.3
  assert.ok(Math.abs(ttm.get('2024-03-31') - 4.9) < 1e-9);
  assert.ok(Math.abs(ttm.get('2024-06-30') - 5.2) < 1e-9);
});

test('TTM values interpolate between quarter ends and hold after the latest report', () => {
  const series = [{ date: '2024-01-01', value: 1 }, { date: '2024-01-11', value: 2 }];
  assert.equal(valueAt(series, '2023-12-31'), null);
  assert.ok(Math.abs(valueAt(series, '2024-01-06') - 1.5) < 1e-9);
  assert.equal(valueAt(series, '2025-01-01'), 2);
});

test('companies without dividend filings show zero dividends', () => {
  const fundamentals = buildFundamentals(gaap(splitHistory));
  const prices = [{ date: '2024-01-31', close: 100 }, { date: '2024-02-29', close: 110 }, { date: '2024-06-28', close: 120 }];
  const company = combine({ symbol: 'TEST', name: 'Test Co', prices, fundamentals });
  assert.equal(company.rows.length, 3);
  assert.ok(company.rows.every((row) => row.dividend === 0 && row.eps > 0));
  assert.equal(company.hasFundamentals, true);
});

test('fetchCompany joins SEC and price responses without exposing the key', async () => {
  const calls = [];
  const respond = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('company_tickers')) return respond({ 0: { cik_str: 123, ticker: 'TEST', title: 'Test Co' } });
    if (href.includes('companyfacts')) return respond({ facts: { 'us-gaap': gaap(splitHistory) } });
    if (href.includes('submissions')) return respond({ name: 'Test Company Inc.', sicDescription: 'Software' });
    return respond([{ date: '2024-06-28', close: 120 }, { date: '2024-05-31', close: 115 }]);
  };
  const company = await fetchCompany('TEST', 'secret', { fetchImpl });
  assert.equal(company.name, 'Test Company Inc.');
  assert.equal(company.sector, 'Software');
  assert.ok(calls.some((href) => href.includes('CIK0000000123')));
  assert.ok(!JSON.stringify(company).includes('secret'));
});
