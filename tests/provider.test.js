const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSplits, buildFundamentals, valueAt, withQuote, weeklyPrices, combine, fetchPrices, fetchQuote, fetchCompany, htmlText, businessSection, businessSummary } = require('../provider.js');

const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('price history comes from one Cboe request and drops unusable rows', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return respond({ data: [{ date: '2024-01-02', close: 10 }, { date: 'bad', close: 11 }, { date: '2024-01-03', close: 0 }, { date: '2024-01-04', close: 12 }] }); };
  const records = await fetchPrices('BRK.B', fetchImpl);
  assert.deepEqual(calls, ['https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/BRK.B.json']);
  assert.deepEqual(records, [{ date: '2024-01-02', close: 10 }, { date: '2024-01-04', close: 12 }]);
});

test('a symbol Cboe does not carry (403) means no history rather than an error', async () => {
  assert.deepEqual(await fetchPrices('ZZZZQ', async () => respond({}, 403)), []);
  assert.equal(await fetchQuote('ZZZZQ', async () => respond({}, 403)), null);
});

test('the quote takes its trading date from the New York last-trade time', async () => {
  const quote = await fetchQuote('AAPL', async () => respond({ timestamp: '2026-09-25 18:41:31', data: { current_price: 339.93, prev_day_close: 335.92, last_trade_time: '2026-09-25T14:26:29' } }));
  assert.deepEqual(quote, { price: 339.93, date: '2026-09-25', time: '2026-09-25T14:26:29', previousClose: 335.92 });
});

test('the quote replaces today\'s bar and never rewrites older history', () => {
  const history = [{ date: '2026-09-23', close: 337 }, { date: '2026-09-24', close: 335.92 }];
  assert.deepEqual(withQuote(history, { date: '2026-09-25', price: 340 }).at(-1), { date: '2026-09-25', close: 340 });
  assert.deepEqual(withQuote(history, { date: '2026-09-24', price: 336 }), [{ date: '2026-09-23', close: 337 }, { date: '2026-09-24', close: 336 }]);
  assert.equal(withQuote(history, { date: '2026-09-20', price: 1 }), history);
  assert.equal(withQuote(history, null), history);
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

test('daily closes collapse to the last trading day of each week and month', () => {
  // Thu 2024-02-29 ends February mid-week; Fri 2024-03-08 ends the next full week; the history stops on Tue 2024-03-12.
  const daily = ['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-04', '2024-03-05', '2024-03-08', '2024-03-11', '2024-03-12']
    .map((date, index) => ({ date, close: 100 + index }));
  assert.deepEqual(weeklyPrices(daily).map((row) => row.date), ['2024-02-29', '2024-03-01', '2024-03-08', '2024-03-12']);
  assert.deepEqual(weeklyPrices(daily).at(-1), { date: '2024-03-12', price: 109 });
  assert.deepEqual(weeklyPrices([{ date: '2024-01-01', close: 0 }, { date: 'bad', close: 5 }]), []);
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

// Simulated SEC EDGAR plus Cboe. `history` null makes Cboe answer 403.
function secAndCboe(history, quote = null) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('company_tickers')) return respond({ 0: { cik_str: 123, ticker: 'TEST', title: 'Test Co' } });
    if (href.includes('companyfacts')) return respond({ facts: { 'us-gaap': gaap(splitHistory) } });
    if (href.includes('submissions')) return respond({ name: 'Test Company Inc.', sicDescription: 'Software' });
    if (href.includes('charts/historical')) return history ? respond({ data: history }) : respond({}, 403);
    if (href.includes('delayed_quotes/quotes')) return quote ? respond({ data: quote }) : respond({}, 403);
    throw Error(`unexpected ${href}`);
  };
  return { calls, fetchImpl };
}

test('SEC-only loads make no Cboe requests', async () => {
  const server = secAndCboe([]);
  const company = await fetchCompany('TEST', { fetchImpl: server.fetchImpl, withPrices: false });
  assert.equal(company.depth, 'sec');
  assert.deepEqual(company.rows, []);
  assert.ok(company.annual.length > 0);
  assert.ok(!server.calls.some((href) => href.includes('cboe')));
});

test('fetchCompany joins SEC filings, Cboe history and the latest quote', async () => {
  const server = secAndCboe([{ date: '2024-05-31', close: 115 }, { date: '2024-06-27', close: 120 }], { current_price: 125, prev_day_close: 120, last_trade_time: '2024-06-28T15:00:00' });
  const company = await fetchCompany('TEST', { fetchImpl: server.fetchImpl });
  assert.equal(company.name, 'Test Company Inc.');
  assert.equal(company.sector, 'Software');
  assert.equal(company.depth, 'full');
  assert.equal(company.provider, 'Cboe + SEC EDGAR');
  assert.deepEqual(company.rows.at(-1).date, '2024-06-28');
  assert.equal(company.rows.at(-1).price, 125);
  assert.equal(company.quote.price, 125);
  assert.ok(server.calls.some((href) => href.includes('CIK0000000123')));
});

test('a ticker Cboe does not carry still returns its SEC data with a notice', async () => {
  const server = secAndCboe(null);
  const company = await fetchCompany('TEST', { fetchImpl: server.fetchImpl });
  assert.equal(company.depth, 'sec');
  assert.ok(company.annual.length > 0);
  assert.match(company.priceError, /Cboe has no price history for TEST/);
});

// Shaped like real filings: a table of contents, headings split across lines and words split across spans.
const filing = `<html><head><title>10-K</title></head><body>
<table><tr><td><span>Item 1.</span></td><td>Business</td><td>1</td></tr><tr><td>Item 1A.</td><td>Risk Factors</td><td>5</td></tr></table>
<p><span>PART I</span></p><p><span>ITEM 1. B</span><span>USINESS</span></p><p>General</p>
<p>In this report, the terms &#8220;Company&#8221; and &#8220;we&#8221; mean Test Co and its subsidiaries.</p>
<p>Test Co designs and sells industrial widgets and related software to manufacturers in more than 40&#160;countries.</p>
<p>Test Co | 2025 Form 10-K | 1</p>
<p>Our services segment installs and maintains widgets under multi-year contracts &amp; subscriptions.</p>
<p><span>Item 1A.</span></p><p>Risk Factors</p><p>Widgets may fall out of fashion, which would be bad for the business.</p></body></html>`;

test('the business section is found past the table of contents, with split words rejoined', () => {
  const section = businessSection(htmlText(filing));
  assert.deepEqual(section, [
    'General',
    'In this report, the terms “Company” and “we” mean Test Co and its subsidiaries.',
    'Test Co designs and sells industrial widgets and related software to manufacturers in more than 40 countries.',
    'Our services segment installs and maintains widgets under multi-year contracts & subscriptions.'
  ]);
  assert.deepEqual(businessSummary(section), section.slice(2));
});

test('a filing without an Item 1 heading gives an empty section', () => {
  assert.deepEqual(businessSection(htmlText('<p>Annual report</p><p>Item 7. Management discussion</p>')), []);
});
