// Cboe's public site data: keyless, split-adjusted daily bars from 2004, and a ~15-minute delayed quote.
const CBOE_HISTORY = 'https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/';
const CBOE_QUOTE = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/';
const SEC_TICKERS = 'https://www.sec.gov/files/company_tickers.json';
const SEC_FACTS = 'https://data.sec.gov/api/xbrl/companyfacts/';
const SEC_SUBMISSIONS = 'https://data.sec.gov/submissions/';
const SEC_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data/';
const ANNUAL_FORMS = new Set(['10-K', '10-K405', '10-KT']);
// FRED's graph CSV download needs no API key. DGS10 is the 10-year Treasury constant-maturity yield.
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const DAY = 86400000;
const EPS_TAGS = ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'];
const DIVIDEND_TAGS = ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'];
// Filers switch tags over time, so each line item lists alternatives in priority order.
const FLOW_TAGS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet'],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  pretaxIncome: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  incomeTax: ['IncomeTaxExpenseBenefit'],
  interestExpense: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt'],
  depreciation: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndOther', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'Depreciation'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']
};
const INSTANT_TAGS = {
  cashAndShortTerm: ['CashCashEquivalentsAndShortTermInvestments'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'],
  shortTermInvestments: ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  longTermDebt: ['LongTermDebt'],
  longTermDebtNoncurrent: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
  longTermDebtCurrent: ['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'],
  commercialPaper: ['CommercialPaper'],
  shortTermBorrowings: ['ShortTermBorrowings'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']
};
const SHARE_TAGS = ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'];
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
  if (length >= 160 && length <= 200) return 'H';
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

// Duration facts (income statement, cash flow, per-share) from 10-K/10-Q filings with a usable period length.
function periodFacts(usGaap, tags, unit = 'USD/shares') {
  const facts = [];
  tags.forEach((tag, priority) => {
    for (const item of usGaap?.[tag]?.units?.[unit] || []) {
      if (!String(item.form || '').startsWith('10-') || !validDate(item.start) || !validDate(item.end) || !validDate(item.filed) || !Number.isFinite(item.val)) continue;
      const kind = durationKind(item.start, item.end);
      if (kind) facts.push({ tag, priority, kind, start: item.start, end: item.end, val: item.val, filed: item.filed });
    }
  });
  return facts;
}
const shareFacts = (usGaap, tags) => periodFacts(usGaap, tags, 'USD/shares');

// Point-in-time balance-sheet facts; the latest filing wins for each date.
function instantValues(usGaap, tags, unit = 'USD') {
  const values = new Map();
  tags.forEach((tag, priority) => {
    for (const item of usGaap?.[tag]?.units?.[unit] || []) {
      if (item.start || !String(item.form || '').startsWith('10-') || !validDate(item.end) || !validDate(item.filed) || !Number.isFinite(item.val)) continue;
      const saved = values.get(item.end);
      if (!saved || priority < saved.priority || (priority === saved.priority && item.filed > saved.filed)) values.set(item.end, { priority, filed: item.filed, value: item.val });
    }
  });
  return new Map([...values].map(([end, item]) => [end, item.value]));
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
// Per-share values divide by later splits, share counts multiply, and dollar amounts are unchanged.
function adjustedPeriods(facts, splits, mode = 'perShare') {
  const periods = new Map();
  for (const fact of facts) {
    const factor = mode === 'amount' ? 1 : splits.filter((split) => split.date > fact.filed).reduce((product, split) => product * split.ratio, 1);
    const value = mode === 'shares' ? fact.val * factor : fact.val / factor;
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

const shiftYears = (date, years) => { const shifted = new Date(time(date)); shifted.setUTCFullYear(shifted.getUTCFullYear() + years); return shifted.toISOString().slice(0, 10); };

// Most recent trailing-twelve-month total. 10-Qs report cash flows year-to-date, so
// TTM = last fiscal year + this year-to-date − the same year-to-date a year earlier.
function latestTtm(periods) {
  const candidates = periods.filter((item) => item.kind).sort((a, b) => b.end.localeCompare(a.end) || (b.kind === 'FY') - (a.kind === 'FY'));
  for (const item of candidates) {
    if (item.kind === 'FY') return { end: item.end, value: item.value };
    const priorYear = periods.find((other) => other.kind === 'FY' && other.end < item.start && near(other.end, item.start, 10));
    const priorToDate = periods.find((other) => other.kind === item.kind && near(other.end, shiftYears(item.end, -1), 20) && near(other.start, shiftYears(item.start, -1), 20));
    if (priorYear && priorToDate) return { end: item.end, value: priorYear.value + item.value - priorToDate.value };
  }
  return null;
}

function fiscalYear(end) {
  const [year, month, day] = end.split('-').map(Number);
  return month === 1 && day <= 7 ? year - 1 : year;
}

// Raw statement values per fiscal year, plus the latest trailing-twelve-month flows and balance sheet.
// Ratios are calculated in math.js from these raw values.
function buildStatements(usGaap, dei, splits) {
  const flows = Object.fromEntries(Object.entries(FLOW_TAGS).map(([name, tags]) => [name, adjustedPeriods(periodFacts(usGaap, tags, 'USD'), splits, 'amount')]));
  const shares = adjustedPeriods(periodFacts(usGaap, SHARE_TAGS, 'shares'), splits, 'shares');
  const instants = Object.fromEntries(Object.entries(INSTANT_TAGS).map(([name, tags]) => [name, instantValues(usGaap, tags)]));
  const round = (value) => value == null || !Number.isFinite(value) ? null : Math.round(value);
  const balanceAt = (end) => {
    const get = (name) => instants[name].get(end) ?? null;
    const any = (...names) => names.some((name) => get(name) != null);
    const cash = get('cashAndShortTerm') ?? (any('cash', 'shortTermInvestments') ? (get('cash') || 0) + (get('shortTermInvestments') || 0) : null);
    const longTerm = get('longTermDebt') ?? (any('longTermDebtNoncurrent', 'longTermDebtCurrent') ? (get('longTermDebtNoncurrent') || 0) + (get('longTermDebtCurrent') || 0) : null);
    const hasDebt = longTerm != null || any('commercialPaper', 'shortTermBorrowings');
    // A balance sheet with equity but no debt lines means the company carries no financial debt.
    const debt = hasDebt ? (longTerm || 0) + (get('commercialPaper') || 0) + (get('shortTermBorrowings') || 0) : get('equity') != null ? 0 : null;
    return { cash: round(cash), debt: round(debt), equity: round(get('equity')) };
  };
  const fyValue = (periods, end) => periods.find((item) => item.kind === 'FY' && item.end === end)?.value ?? null;
  const flowAt = (end) => {
    const values = Object.fromEntries(Object.keys(FLOW_TAGS).map((name) => [name, fyValue(flows[name], end)]));
    if (values.grossProfit == null && values.revenue != null && values.costOfRevenue != null) values.grossProfit = values.revenue - values.costOfRevenue;
    delete values.costOfRevenue;
    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, round(value)]));
  };
  const years = [...new Set(flows.revenue.concat(flows.netIncome).filter((item) => item.kind === 'FY').map((item) => item.end))].sort();
  const annual = new Map(years.map((end) => [end, { ...flowAt(end), dilutedShares: round(fyValue(shares, end)), ...balanceAt(end) }]));

  const ttm = {};
  for (const name of Object.keys(FLOW_TAGS)) {
    const latest = latestTtm(flows[name]);
    if (latest) { ttm[name] = round(latest.value); if (['revenue', 'operatingCashFlow'].includes(name) && (!ttm.end || latest.end > ttm.end)) ttm.end = latest.end; }
  }
  if (ttm.grossProfit == null && ttm.revenue != null && ttm.costOfRevenue != null) ttm.grossProfit = ttm.revenue - ttm.costOfRevenue;
  delete ttm.costOfRevenue;

  const balanceDates = [...new Set([...instants.equity.keys(), ...instants.cash.keys()])].sort();
  const balanceEnd = balanceDates.at(-1);
  const balance = balanceEnd ? { end: balanceEnd, ...balanceAt(balanceEnd) } : null;

  const latestShares = [...shares].sort((a, b) => b.end.localeCompare(a.end) || (a.kind === 'Q' ? -1 : 1))[0];
  // Cover-page share count is the most current figure. Multi-class filers may omit it, so fall back to diluted shares.
  const cover = (dei?.EntityCommonStockSharesOutstanding?.units?.shares || []).filter((item) => validDate(item.end) && validDate(item.filed) && Number.isFinite(item.val));
  const coverEnd = cover.map((item) => item.end).sort().at(-1);
  const coverFacts = cover.filter((item) => item.end === coverEnd);
  const coverFiled = coverFacts.map((item) => item.filed).sort().at(-1);
  const coverShares = coverFacts.filter((item) => item.filed === coverFiled).reduce((sum, item) => sum + item.val, 0);
  const coverFactor = splits.filter((split) => split.date > coverFiled).reduce((product, split) => product * split.ratio, 1);
  const sharesOutstanding = coverShares > 0 && (!latestShares || coverEnd >= latestShares.end)
    ? { value: round(coverShares * coverFactor), date: coverEnd, source: 'Cover page shares outstanding' }
    : latestShares ? { value: round(latestShares.value), date: latestShares.end, source: 'Diluted weighted-average shares' } : null;
  return { annual, ttm, balance, sharesOutstanding };
}

function buildFundamentals(usGaap, dei = null) {
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
  const statements = buildStatements(usGaap, dei, splits);
  const epsByEnd = new Map(epsPeriods.filter((item) => item.kind === 'FY').map((item) => [item.end, item.value]));
  const annual = [...new Set([...epsByEnd.keys(), ...statements.annual.keys()])]
    .sort()
    .map((end) => ({ year: fiscalYear(end), end, eps: epsByEnd.has(end) ? +epsByEnd.get(end).toFixed(4) : null, dividend: annualDividend(end), ...(statements.annual.get(end) || {}) }));
  return { eps, dividends, annual, splits, paysDividends: dividendFacts.length > 0, ttm: statements.ttm, balance: statements.balance, sharesOutstanding: statements.sharesOutstanding };
}

// The latest quote replaces any bar on or after its trading date, so the current month ends at the live price.
function withQuote(records, quote) {
  if (!quote || records.some((row) => row.date > quote.date)) return records;
  return [...records.filter((row) => row.date < quote.date), { date: quote.date, close: quote.price }];
}

// depth: 'sec' has no prices, 'full' has all available history plus the latest quote.
function combine({ symbol, name, sector, prices, fundamentals, quote = null, priceError = null, depth = 'full', fetchedAt = new Date().toISOString() }) {
  const monthly = depth === 'sec' ? [] : monthlyPrices(withQuote(prices, quote));
  if (depth !== 'sec' && monthly.length < 2) throw new ProviderError(`Not enough price history was found for ${symbol}. Check the ticker.`, 404);
  const { eps, dividends, annual, splits, paysDividends, ttm, balance, sharesOutstanding } = fundamentals;
  const rows = monthly.map((row) => {
    const ttmEps = valueAt(eps, row.date);
    const ttmDividend = paysDividends ? valueAt(dividends, row.date) : 0;
    return { date: row.date, price: row.price, eps: ttmEps == null ? null : +ttmEps.toFixed(4), dividend: ttmDividend == null ? 0 : +Math.max(0, ttmDividend).toFixed(4) };
  });
  if (depth === 'full' && !rows.some((row) => row.eps != null)) throw new ProviderError(`SEC earnings history for ${symbol} does not overlap the available price history.`, 422);
  const splitNote = splits.length ? ` Detected splits: ${splits.map((split) => `${split.ratio >= 1 ? `${+split.ratio.toFixed(2)}-for-1` : `1-for-${+(1 / split.ratio).toFixed(2)}`} (by ${split.date})`).join(', ')}.` : '';
  return {
    ticker: symbol,
    name,
    sector: sector || 'Unclassified',
    source: 'api',
    depth,
    provider: depth === 'sec' ? 'SEC EDGAR' : 'Cboe + SEC EDGAR',
    currency: 'USD',
    hasFundamentals: true,
    rows,
    annual,
    ttm: ttm || null,
    balance: balance || null,
    sharesOutstanding: sharesOutstanding || null,
    splits,
    quote: depth === 'sec' ? null : quote,
    priceError,
    fetchedAt,
    methodologyNote: `Month-end closing prices (split-adjusted) from Cboe, with the current month at the latest delayed quote. Trailing diluted EPS and dividends per share from SEC 10-K/10-Q filings, restated to today's share basis and interpolated between quarter ends.${splitNote}`
  };
}

async function fetchJson(url, options, label) {
  let response;
  try { response = await options.fetchImpl(url, { headers: options.headers, signal: AbortSignal.timeout(20000) }); }
  catch { throw new ProviderError(`Could not reach ${label}. Try again shortly.`); }
  // Cboe answers 403 for symbols it doesn't carry.
  if (response.status === 404 || (label === 'Cboe' && response.status === 403)) return null;
  if (response.status === 401 || response.status === 403) throw new ProviderError(`${label} refused the request.`, 502);
  if (response.status === 429) throw new ProviderError(`${label} request limit reached. Try again later.`, 429);
  if (!response.ok) throw new ProviderError(`${label} returned HTTP ${response.status}.`);
  try { return await response.json(); }
  catch { throw new ProviderError(`${label} returned invalid JSON.`); }
}

// The whole daily history in one file, through the previous close. Cboe writes class shares with a dot (BRK.B).
async function fetchPrices(symbol, fetchImpl = fetch) {
  const body = await fetchJson(`${CBOE_HISTORY}${encodeURIComponent(symbol)}.json`, { fetchImpl }, 'Cboe');
  if (body == null) return [];
  if (!Array.isArray(body.data)) throw new ProviderError('Cboe returned an unexpected price response.');
  return body.data
    .map((row) => ({ date: row.date, close: finiteNumber(row.close) }))
    .filter((row) => validDate(row.date) && row.close != null && row.close > 0);
}

// Latest trade, about 15 minutes delayed. last_trade_time is New York local time, e.g. "2026-09-25T14:26:29".
async function fetchQuote(symbol, fetchImpl = fetch) {
  const body = await fetchJson(`${CBOE_QUOTE}${encodeURIComponent(symbol)}.json`, { fetchImpl }, 'Cboe');
  const price = finiteNumber(body?.data?.current_price);
  const time = String(body?.data?.last_trade_time || '');
  if (price == null || price <= 0 || !validDate(time.slice(0, 10))) return null;
  return { price, date: time.slice(0, 10), time, previousClose: finiteNumber(body.data.prev_day_close) };
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

// All observations of a FRED series via its keyless CSV download (missing values are ".").
async function fetchFredSeries(series, { fetchImpl = fetch, userAgent } = {}) {
  let response;
  try { response = await fetchImpl(`${FRED_CSV}${encodeURIComponent(series)}`, { headers: { 'User-Agent': userAgent || 'Lettuce investment research (nathanielmann.ca)' }, signal: AbortSignal.timeout(20000) }); }
  catch { throw new ProviderError('Could not reach FRED. Try again shortly.'); }
  if (!response.ok) throw new ProviderError(`FRED returned HTTP ${response.status}.`);
  const observations = (await response.text()).trim().split(/\r?\n/).slice(1)
    .map((line) => { const [date, value] = line.split(','); return { date, value: finiteNumber(value) }; })
    .filter((item) => validDate(item.date) && item.value != null);
  if (!observations.length) throw new ProviderError(`FRED returned no observations for ${series}.`, 422);
  return observations;
}

async function fetchFredLatest(series, options) {
  const observations = await fetchFredSeries(series, options);
  return { series, ...observations.at(-1) };
}

// Everything except the live quote, so the server can cache it for a day and add fresh quotes on top.
// withPrices false skips Cboe and returns SEC data only. If Cboe has no history, SEC data is still returned with priceError set.
async function fetchCompanyData(symbol, { fetchImpl = fetch, userAgent, withPrices = true } = {}) {
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) throw new ProviderError('Invalid ticker.', 400);
  const sec ={ fetchImpl, headers: { 'User-Agent': userAgent || 'Lettuce investment research (nathanielmann.ca)', Accept: 'application/json' } };
  const entry = await lookupCik(symbol, sec);
  if (!entry) throw new ProviderError(`${symbol} was not found in SEC filings. Lettuce supports U.S.-listed companies that file 10-K and 10-Q reports.`, 404);
  const cik = String(entry.cik_str).padStart(10, '0');
  let priceError = null;
  const [facts, submissions, prices] = await Promise.all([
    fetchJson(`${SEC_FACTS}CIK${cik}.json`, sec, 'SEC EDGAR'),
    fetchJson(`${SEC_SUBMISSIONS}CIK${cik}.json`, sec, 'SEC EDGAR').catch(() => null),
    withPrices ? fetchPrices(symbol, fetchImpl).catch((error) => { priceError = error.message; return []; }) : []
  ]);
  if (!facts?.facts?.['us-gaap']) throw new ProviderError(`SEC filings for ${symbol} do not include U.S. GAAP financial data.`, 422);
  if (withPrices && !prices.length) priceError ||= `Cboe has no price history for ${symbol}, so only SEC data is shown.`;
  const filedName = submissions?.name || entry.title || symbol;
  return {
    symbol,
    name: /[a-z]/.test(filedName) ? filedName : filedName.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase()),
    sector: submissions?.sicDescription,
    prices,
    priceError,
    depth: prices.length ? 'full' : 'sec',
    fundamentals: buildFundamentals(facts.facts['us-gaap'], facts.facts.dei)
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', reg: '®', trade: '™', copy: '©', bull: '•', hellip: '…' };

// Filing HTML to plain text, one paragraph per line. Filers split words across styled spans
// ("B<span>USINESS</span>"), so inline tags are removed without adding a space; table cells get one.
function htmlText(html) {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/?t[dh]\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(x?)([0-9a-f]+);/gi, (match, hex, code) => { const point = parseInt(code, hex ? 16 : 10); return point > 0 && point < 0x110000 ? String.fromCodePoint(point) : match; })
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t ​]+/g, ' ')
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

// Paragraphs of 10-K "Item 1. Business", up to "Item 1A" (or "Item 2" for filers without risk factors).
// The table of contents repeats the heading, so the longest candidate is the real section.
function businessSection(text) {
  const joined = text.replace(/^(item\s*\d+[a-z]?\s*[.:]?)\n/gim, '$1 ');
  let best = '';
  for (const match of joined.matchAll(/^item\s*1\s*[.:\-–—]?\s*business\b.*$/gim)) {
    const rest = joined.slice(match.index + match[0].length);
    const end = rest.search(/^item\s*(1a|2)\b/im);
    const body = end === -1 ? rest.slice(0, 60000) : rest.slice(0, end);
    if (body.length > best.length) best = body;
  }
  return best.split('\n').filter((line) => line && !/^\d+$/.test(line) && !/form 10-k\s*\|/i.test(line) && !/^table of contents$/i.test(line));
}

// The opening prose paragraphs, skipping headings and "In this report, the terms…" definitions.
function businessSummary(paragraphs, limit = 1100) {
  const summary = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.length < 60 || !/[.:]$/.test(paragraph) || /^(in this report|as used in this|unless the context|references (in this|to))/i.test(paragraph)) continue;
    summary.push(paragraph);
    length += paragraph.length;
    if (length >= limit) break;
  }
  return summary;
}

async function fetchText(url, options, label) {
  let response;
  try { response = await options.fetchImpl(url, { headers: options.headers, signal: AbortSignal.timeout(30000) }); }
  catch { throw new ProviderError(`Could not reach ${label}. Try again shortly.`); }
  if (!response.ok) throw new ProviderError(`${label} returned HTTP ${response.status}.`);
  return response.text();
}

function latestAnnual(filings) {
  const index = (filings?.form || []).findIndex((form) => ANNUAL_FORMS.has(form));
  return index === -1 ? null : { form: filings.form[index], accession: filings.accessionNumber[index], document: filings.primaryDocument[index], filed: filings.filingDate[index], period: filings.reportDate[index] || null };
}

// What the company does, from "Item 1. Business" of its latest 10-K.
async function fetchProfile(symbol, { fetchImpl = fetch, userAgent } = {}) {
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) throw new ProviderError('Invalid ticker.', 400);
  const sec = { fetchImpl, headers: { 'User-Agent': userAgent || 'Lettuce investment research (nathanielmann.ca)', Accept: 'application/json' } };
  const entry = await lookupCik(symbol, sec);
  if (!entry) throw new ProviderError(`${symbol} was not found in SEC filings.`, 404);
  const cik = String(entry.cik_str).padStart(10, '0');
  const submissions = await fetchJson(`${SEC_SUBMISSIONS}CIK${cik}.json`, sec, 'SEC EDGAR');
  let annual = latestAnnual(submissions?.filings?.recent);
  // Busy filers push their last 10-K out of the "recent" block into an older page.
  if (!annual && submissions?.filings?.files?.[0]?.name) annual = latestAnnual(await fetchJson(`${SEC_SUBMISSIONS}${submissions.filings.files[0].name}`, sec, 'SEC EDGAR'));
  if (!annual) throw new ProviderError(`No 10-K annual report was found for ${symbol}.`, 404);
  const url = `${SEC_ARCHIVES}${Number(entry.cik_str)}/${annual.accession.replace(/-/g, '')}/${annual.document}`;
  const business = businessSection(htmlText(await fetchText(url, { ...sec, headers: { ...sec.headers, Accept: 'text/html' } }, 'SEC EDGAR')));
  let length = 0;
  return {
    ticker: symbol,
    summary: businessSummary(business),
    // Enough of the section for a full read without sending megabytes to the browser.
    business: business.filter((paragraph) => (length += paragraph.length) <= 20000),
    filing: { ...annual, url },
    fetchedAt: new Date().toISOString()
  };
}

async function fetchCompany(symbol, options = {}) {
  const data = await fetchCompanyData(symbol, options);
  const quote = data.depth === 'full' ? await fetchQuote(symbol, options.fetchImpl).catch(() => null) : null;
  return combine({ ...data, quote });
}

module.exports = { ProviderError, monthlyPrices, detectSplits, adjustedPeriods, trailingSeries, latestTtm, valueAt, buildFundamentals, withQuote, combine, fetchPrices, fetchQuote, fetchFredSeries, fetchFredLatest, fetchCompanyData, fetchCompany, htmlText, businessSection, businessSummary, fetchProfile };
