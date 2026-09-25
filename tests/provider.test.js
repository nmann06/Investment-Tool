const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCompany, fetchCompany, splitFactorAfter } = require('../provider');

const monthly = { 'Monthly Adjusted Time Series': {
  '2024-12-31': { '4. close': '100' },
  '2025-01-31': { '4. close': '100' },
  '2025-02-28': { '4. close': '55' },
  '2025-03-31': { '4. close': '60' }
} };
const earnings = { quarterlyEarnings: [
  { fiscalDateEnding: '2024-12-31', reportedDate: '2025-01-15', reportedEPS: '1' },
  { fiscalDateEnding: '2024-09-30', reportedDate: '2024-10-15', reportedEPS: '1' },
  { fiscalDateEnding: '2024-06-30', reportedDate: '2024-07-15', reportedEPS: '1' },
  { fiscalDateEnding: '2024-03-31', reportedDate: '2024-04-15', reportedEPS: '1' }
] };
const splits = { data: [{ effective_date: '2025-02-15', split_factor: '2' }] };
const overview = { Name: 'Example Corp', Sector: 'Technology', Currency: 'USD' };

test('matches only published EPS and adjusts price and earnings for splits', () => {
  const company = normalizeCompany('EXM', monthly, earnings, splits, overview);
  assert.equal(company.name, 'Example Corp');
  assert.equal(company.rows.length, 3);
  assert.equal(company.rows[0].date, '2025-01-31');
  assert.equal(company.rows[0].price, 50);
  assert.equal(company.rows[0].eps, 2);
  assert.equal(company.rows[2].price, 60);
  assert.equal(company.rows[2].eps, 2);
  assert.equal(splitFactorAfter('2025-02-15', [{ date: '2025-02-15', factor: 2 }]), 1);
});

test('rejects missing split history rather than silently mixing share bases', () => {
  assert.throws(() => normalizeCompany('EXM', monthly, earnings, {}, overview), /split history/);
});

test('does not sum nonconsecutive quarters into trailing earnings', () => {
  const sparse = { quarterlyEarnings: [
    ...earnings.quarterlyEarnings.filter((item) => item.fiscalDateEnding !== '2024-09-30'),
    { fiscalDateEnding: '2023-12-31', reportedDate: '2024-01-15', reportedEPS: '1' }
  ] };
  assert.throws(() => normalizeCompany('EXM', monthly, sparse, splits, overview), /Not enough matched/);
});

test('does not call provider without a configured key', async () => {
  await assert.rejects(fetchCompany('EXM', '', () => { throw Error('Called provider'); }), /ALPHA_VANTAGE_API_KEY/);
});

test('loads the four documented provider datasets and returns chart rows', async () => {
  const fixtures = {
    TIME_SERIES_MONTHLY_ADJUSTED: monthly,
    EARNINGS: earnings,
    SPLITS: splits,
    OVERVIEW: overview
  };
  const called = [];
  const fetchMock = async (url) => {
    called.push(url.searchParams.get('function'));
    assert.equal(url.searchParams.get('symbol'), 'EXM');
    assert.equal(url.searchParams.get('apikey'), 'test-key');
    return { ok: true, json: async () => fixtures[url.searchParams.get('function')] };
  };
  const company = await fetchCompany('EXM', 'test-key', fetchMock);
  assert.deepEqual(called.sort(), Object.keys(fixtures).sort());
  assert.equal(company.rows.at(-1).price, 60);
});
