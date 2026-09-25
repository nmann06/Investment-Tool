const PRICE_BASE = 'https://financialdata.net/api/v1/stock-prices';
const SEC_TICKERS = 'https://www.sec.gov/files/company_tickers.json';
const SEC_FACTS = 'https://data.sec.gov/api/xbrl/companyfacts/';
const SEC_SUBMISSIONS = 'https://data.sec.gov/submissions/';
const PAGE_SIZE = 300;
const MAX_PAGES = 12;
const DAY = 86400000;
const EPS_TAGS = ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'];
const DIVIDEND_TAGS = ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'];
const SPLIT_RATIOS = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50];

class ProviderError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const time = (date) => Date.parse(`${date}T00:00:00Z`);
const days = (start, end) => Math.round((time(end) - time(start)) / DAY);

function durationKind(start, end) {
  const length = days(start, end);
  if (length >= 70 && length <= 110) return 'Q';
  if (length >= 250 && length <= 290) return '9M';
  if (length >= 340 && length <= 390) return 'FY';
  return null;
}

// Collapses daily closes to the last trading day of each month.
function monthlyPrices(records) {
  const valid = records
    .map((item) => ({ date: item.date, price: finiteNumber(item.close) }))
    .filter((item) => validDate(item.date) && item.price != null && item.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const monthly = new Map();
  for (const row of valid) monthly.set(row.date.slice(0, 7), row);
  return [...monthly.values()];
}

// Per-share facts from 10-K/10-Q filings with a usable period length.
function shareFacts(usGaap, tags) {
  const facts = [];
  tags.forEach((tag, priority) => {
    for (const item of usGaap?.[tag]?.units?.['USD/shares'] || []) {
      if (!String(item.form || '').startsWith('10-') || !validDate(item.start) || !validDate(item.end) || !validDate(item.filed) || !Number.isFinite(item.val)) continue;
      const kind = durationKind(item.start, item.end);
      if (kind) facts.push({ tag, priority, kind, start: item.start, end: item.end, val: item.val, filed: item.filed });
    }
  });
  return facts;
}

function matchingRatio(oldValue, newValue) {
  if (Math.abs(newValue) < 0.03 || Math.sign(oldValue) !== Math.sign(newValue)) return null;
  for (const base of SPLIT_RATIOS) {
    for (const ratio of [base, 1 / base]) {
      // EPS is reported to the cent, so allow rounding error on both values.
      const tolerance = 0.006 * (ratio + 1) + 0.01 * Math.abs(oldValue);
      if (Math.abs(oldValue - ratio * newValue) <= tolerance && Math.abs(oldValue / newValue - ratio) / ratio < 0.12) return ratio;
    }
  }
  return null;
}

// Filers restate prior-period per-share figures after a split. A clean ratio between consecutive
// reports of the same period reveals the split and brackets its date between the two filings.
function detectSplits(facts) {
  const byPeriod = new Map();
  for (const fact of facts) {
    const key = `${fact.tag}|${fact.start}|${fact.end}`;
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push(fact);
  }
  const events = [];
  for (const reports of byPeriod.values()) {
    reports.sort((a, b) => a.filed.localeCompare(b.filed));
    for (let i = 1; i < reports.length; i++) {
      const before = reports[i - 1], after = reports[i];
      if (before.filed === after.filed || before.val === after.val) continue;
      const ratio = matchingRatio(before.val, after.val);
      if (ratio) events.push({ ratio, after: before.filed, by: after.filed, period: `${after.start}|${after.end}` });
    }
  }
  const splits = [];
  for (const ratio of new Set(events.map((event) => event.ratio))) {
    const group = events.filter((event) => event.ratio === ratio).sort((a, b) => a.by.localeCompare(b.by));
    let cluster = null;
    const finish = () => { if (cluster && cluster.periods.size >= 2) splits.push({ ratio, date: cluster.by, after: cluster.after }); };
    for (const event of group) {
      if (cluster && event.after < cluster.by) {
        cluster.after = event.after > cluster.after ? event.after : cluster.after;
        cluster.periods.add(event.period);
      } else {
        finish();
        cluster = { after: event.after, by: event.by, periods: new Set([event.period]) };
      }
    }
    finish();
  }
  return splits.sort((a, b) => a.date.localeCompare(b.date));
}

// Restates each fact to the current share basis and keeps the latest filing for each period.
function adjustedPeriods(facts, splits) {
  const periods = new Map();
  for (const fact of facts) {
    const factor = splits.filter((split) => split.date > fact.filed).reduce((product, split) => product * split.ratio, 1);
    const value = fact.val / factor;
    const key = `${fact.start}|${fact.end}`;
    const saved = periods.get(key);
    if (!saved || fact.priority < saved.priority || (fact.priority === saved.priority && fact.filed > saved.filed)) {
      periods.set(key, { kind: fact.kind, start: fact.start, end: fact.end, value, filed: fact.filed, priority: fact.priority });
    }
  }
  return [...periods.values()];
}

const near = (a, b, tolerance = 10) => Math.abs(days(a, b)) <= tolerance;

// Builds trailing-twelve-month values at each fiscal quarter end.
function trailingSeries(periods) {
  const annual = periods.filter((item) => item.kind === 'FY').sort((a, b) => a.end.localeCompare(b.end));
  const quarters = new Map(periods.filter((item) => item.kind === 'Q').map((item) => [item.end, item]));
  for (const year of annual) {
    if (quarters.has(year.end)) continue;
    const nine = periods.find((item) => item.kind === '9M' && item.start === year.start);
    if (nine) { quarters.set(year.end, { start: nine.end, end: year.end, value: year.value - nine.value }); continue; }
    const inside = [...quarters.values()].filter((item) => item.start >= year.start && item.end < year.end).sort((a, b) => a.start.localeCompare(b.start));
    if (inside.length === 3 && near(inside[0].start, year.start)) quarters.set(year.end, { start: inside[2].end, end: year.end, value: year.value - inside.reduce((sum, item) => sum + item.value, 0) });
  }
  const ordered = [...quarters.values()].sort((a, b) => a.end.localeCompare(b.end));
  const points = new Map();
  for (let i = 3; i < ordered.length; i++) {
    const run = ordered.slice(i - 3, i + 1);
    const contiguous = run.every((item, index) => index === 0 || near(run[index - 1].end, item.start, 12));
    if (contiguous && near(run[0].start, new Date(time(run[3].end) - 365 * DAY).toISOString().slice(0, 10), 20)) {
      points.set(run[3].end, run.reduce((sum, item) => sum + item.value, 0));
    }
  }
  for (const year of annual) points.set(year.end, year.value);
  return [...points].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

// Linear interpolation between quarter-end TTM points, held flat after the latest report.
function valueAt(series, date) {
  if (!series.length || date < series[0].date) return null;
  const nextIndex = series.findIndex((point) => point.date > date);
  if (nextIndex === -1) return series.at(-1).value;
  const previous = series[nextIndex - 1], next = series[nextIndex];
  if (days(previous.date, next.date) > 200) return previous.value;
  const weight = (time(date) - time(previous.date)) / (time(next.date) - time(previous.date));
  return previous.value + (next.value - previous.value) * weight;
}

function fiscalYear(end) {
  const [year, month, day] = end.split('-').map(Number);
  return month === 1 && day <= 7 ? year - 1 : year;
}

function buildFundamentals(usGaap) {
  const epsFacts = shareFacts(usGaap, EPS_TAGS);
  if (!epsFacts.length) throw new ProviderError('SEC filings for this company do not include U.S. GAAP earnings per share.', 422);
  const dividendFacts = shareFacts(usGaap, DIVIDEND_TAGS);
  const splits = detectSplits([...epsFacts, ...dividendFacts]);
  const epsPeriods = adjustedPeriods(epsFacts, splits);
  const dividendPeriods = adjustedPeriods(dividendFacts, splits);
  const eps = trailingSeries(epsPeriods);
  const dividends = trailingSeries(dividendPeriods);
  const dividendByEnd = new Map(dividendPeriods.filter((item) => item.kind === 'FY').map((item) => [item.end, item.value]));
  const firstDividend = dividendPeriods.map((item) => item.start).sort()[0];
  const annualDividend = (end) => dividendByEnd.has(end) ? +dividendByEnd.get(end).toFixed(4) : !firstDividend || end < firstDividend ? 0 : null;
  const annual = epsPeriods
    .filter((item) => item.kind === 'FY')
    .sort((a, b) => a.end.localeCompare(b.end))
    .map((item) => ({ year: fiscalYear(item.end), end: item.end, eps: +item.value.toFixed(4), dividend: annualDividend(item.end) }));
  return { eps, dividends, annual, splits, paysDividends: dividendFacts.length > 0 };
}

function combine({ symbol, name, sector, prices, fundamentals, fetchedAt = new Date().toISOString() }) {
  const monthly = monthlyPrices(prices);
  if (monthly.length < 2) throw new ProviderError(`Not enough price history was found for ${symbol}. Check the ticker.`, 404);
  const { eps, dividends, annual, splits, paysDividends } = fundamentals;
  const rows = monthly.map((row) => {
    const ttmEps = valueAt(eps, row.date);
    const ttmDividend = paysDividends ? valueAt(dividends, row.date) : 0;
    return { date: row.date, price: row.price, eps: ttmEps == null ? null : +ttmEps.toFixed(4), dividend: ttmDividend == null ? 0 : +Math.max(0, ttmDividend).toFixed(4) };
  });
  if (!rows.some((row) => row.eps != null)) throw new ProviderError(`SEC earnings history for ${symbol} does not overlap the available price history.`, 422);
  const first = rows[0].date;
  const splitNote = splits.length ? ` Detected splits: ${splits.map((split) => `${split.ratio >= 1 ? `${+split.ratio.toFixed(2)}-for-1` : `1-for-${+(1 / split.ratio).toFixed(2)}`} (by ${split.date})`).join(', ')}.` : '';
  return {
    ticker: symbol,
    name,
    sector: sector || 'Unclassified',
    source: 'api',
    provider: 'FinancialData.net + SEC EDGAR',
    currency: 'USD',
    hasFundamentals: true,
    rows,
    annual: annual.filter((item) => item.end >= first),
    splits,
    fetchedAt,
    methodologyNote: `Month-end closing prices (split-adjusted) from FinancialData.net. Trailing diluted EPS and dividends per share from SEC 10-K/10-Q filings, restated to today's share basis and interpolated between quarter ends.${splitNote}`
  };
}

async function fetchJson(url, options, label) {
  let response;
  try { response = await options.fetchImpl(url, { headers: options.headers, signal: AbortSignal.timeout(20000) }); }
  catch { throw new ProviderError(`Could not reach ${label}. Try again shortly.`); }
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) throw new ProviderError(label === 'FinancialData.net' ? 'FinancialData.net rejected the API key. Check the key and plan.' : `${label} refused the request.`, 502);
  if (response.status === 429) throw new ProviderError(`${label} request limit reached. Try again later.`, 429);
  if (!response.ok) throw new ProviderError(`${label} returned HTTP ${response.status}.`);
  try { return await response.json(); }
  catch { throw new ProviderError(`${label} returned invalid JSON.`); }
}

async function fetchPrices(symbol, key, fetchImpl) {
  const records = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(PRICE_BASE);
    url.searchParams.set('identifier', symbol);
    url.searchParams.set('offset', String(page * PAGE_SIZE));
    url.searchParams.set('key', key);
    const batch = await fetchJson(url, { fetchImpl }, 'FinancialData.net');
    if (batch != null && !Array.isArray(batch)) throw new ProviderError('FinancialData.net returned an unexpected price response.');
    if (!batch || !batch.length) break;
    records.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return records;
}

let tickerCache = null;
async function lookupCik(symbol, options) {
  if (!tickerCache || Date.now() - tickerCache.time > DAY) {
    const data = await fetchJson(SEC_TICKERS, options, 'SEC EDGAR');
    if (!data) throw new ProviderError('Could not load the SEC ticker list.');
    tickerCache = { time: Date.now(), map: new Map(Object.values(data).map((item) => [String(item.ticker).toUpperCase(), item])) };
  }
  return tickerCache.map.get(symbol.replace(/\./g, '-')) || null;
}

async function fetchCompany(symbol, key, { fetchImpl = fetch, userAgent } = {}) {
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) throw new ProviderError('Invalid ticker.', 400);
  if (!key) throw new ProviderError('Set FINANCIALDATA_API_KEY on the server.', 503);
  const sec = { fetchImpl, headers: { 'User-Agent': userAgent || 'Lattice investment research (nathanielmann.ca)', Accept: 'application/json' } };
  const entry = await lookupCik(symbol, sec);
  if (!entry) throw new ProviderError(`${symbol} was not found in SEC filings. Lattice supports U.S.-listed companies that file 10-K and 10-Q reports.`, 404);
  const cik = String(entry.cik_str).padStart(10, '0');
  const [facts, submissions, prices] = await Promise.all([
    fetchJson(`${SEC_FACTS}CIK${cik}.json`, sec, 'SEC EDGAR'),
    fetchJson(`${SEC_SUBMISSIONS}CIK${cik}.json`, sec, 'SEC EDGAR').catch(() => null),
    fetchPrices(symbol, key, fetchImpl)
  ]);
  if (!facts?.facts?.['us-gaap']) throw new ProviderError(`SEC filings for ${symbol} do not include U.S. GAAP financial data.`, 422);
  if (!prices.length) throw new ProviderError(`No price history was found for ${symbol}. Check the ticker.`, 404);
  const filedName = submissions?.name || entry.title || symbol;
  return combine({
    symbol,
    name: /[a-z]/.test(filedName) ? filedName : filedName.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase()),
    sector: submissions?.sicDescription,
    prices,
    fundamentals: buildFundamentals(facts.facts['us-gaap'])
  });
}

module.exports = { ProviderError, monthlyPrices, detectSplits, adjustedPeriods, trailingSeries, valueAt, buildFundamentals, combine, fetchCompany };
