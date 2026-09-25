const BASE = 'https://www.alphavantage.co/query';

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

function splitFactorAfter(date, splits) {
  return splits.reduce((factor, split) => split.date > date ? factor * split.factor : factor, 1);
}

function normalizeCompany(symbol, monthly, earnings, splitResponse, overview) {
  const series = monthly?.['Monthly Adjusted Time Series'];
  if (!series || typeof series !== 'object' || !Array.isArray(earnings?.quarterlyEarnings)) {
    throw new ProviderError('The provider did not return usable price and earnings history.');
  }
  if (overview?.Currency && overview.Currency !== 'USD') {
    throw new ProviderError('This prototype currently supports USD-denominated securities only.', 422);
  }
  const splitData = Array.isArray(splitResponse?.data) ? splitResponse.data : null;
  if (!splitData) throw new ProviderError('The provider did not return split history.');
  const splits = splitData.map((item) => ({ date: item.effective_date, factor: finiteNumber(item.split_factor) }));
  if (splits.some((item) => !validDate(item.date) || item.factor == null || item.factor <= 0)) {
    throw new ProviderError('The provider returned an invalid stock split.');
  }
  const quarters = earnings.quarterlyEarnings
    .map((item) => ({ fiscalDate: item.fiscalDateEnding, reportedDate: item.reportedDate, eps: finiteNumber(item.reportedEPS) }))
    .filter((item) => validDate(item.fiscalDate) && validDate(item.reportedDate) && item.eps != null)
    .sort((a, b) => b.fiscalDate.localeCompare(a.fiscalDate) || b.reportedDate.localeCompare(a.reportedDate));
  const prices = Object.entries(series)
    .map(([date, values]) => ({ date, close: finiteNumber(values?.['4. close']) }))
    .filter((item) => validDate(item.date) && item.close != null && item.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!prices.length || quarters.length < 4) throw new ProviderError('Not enough historical prices or quarterly EPS reports were returned.', 422);

  const rows = [];
  for (const price of prices) {
    const available = quarters.filter((item) => item.reportedDate <= price.date && item.fiscalDate <= price.date);
    const latestFour = [];
    const seen = new Set();
    for (const quarter of available) {
      if (seen.has(quarter.fiscalDate)) continue;
      seen.add(quarter.fiscalDate);
      latestFour.push(quarter);
      if (latestFour.length === 4) break;
    }
    if (latestFour.length !== 4) continue;
    const latestAge = (Date.parse(price.date) - Date.parse(latestFour[0].fiscalDate)) / 86400000;
    const oldestAge = (Date.parse(price.date) - Date.parse(latestFour[3].fiscalDate)) / 86400000;
    const consecutive = latestFour.slice(0, 3).every((quarter, index) => {
      const gap = (Date.parse(quarter.fiscalDate) - Date.parse(latestFour[index + 1].fiscalDate)) / 86400000;
      return gap >= 60 && gap <= 125;
    });
    if (latestAge > 180 || oldestAge > 550 || !consecutive) continue;
    const eps = latestFour.reduce((sum, quarter) => sum + quarter.eps / splitFactorAfter(quarter.fiscalDate, splits), 0);
    const adjustedPrice = price.close / splitFactorAfter(price.date, splits);
    if (Number.isFinite(eps) && Number.isFinite(adjustedPrice)) {
      rows.push({ date: price.date, price: +adjustedPrice.toFixed(4), eps: +eps.toFixed(4), dividend: 0 });
    }
  }
  if (rows.length < 2) throw new ProviderError('Not enough matched price and reported EPS observations were returned.', 422);
  return {
    ticker: symbol,
    name: typeof overview?.Name === 'string' && overview.Name ? overview.Name : symbol,
    sector: typeof overview?.Sector === 'string' && overview.Sector ? overview.Sector : 'Unclassified',
    source: 'api',
    provider: 'Alpha Vantage',
    currency: 'USD',
    rows,
    fetchedAt: new Date().toISOString(),
    methodologyNote: 'Trailing EPS uses the latest four reported quarters available at each month end. Historical prices and quarterly EPS are split-adjusted to the latest share basis; verify the provider’s historical EPS basis for securities with splits.'
  };
}

async function providerQuery(fn, symbol, key, fetchImpl = fetch) {
  const url = new URL(BASE);
  url.searchParams.set('function', fn);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', key);
  let response;
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); }
  catch { throw new ProviderError('Could not reach the market-data provider.'); }
  if (response.status === 429) throw new ProviderError('The market-data provider rate limit was reached. Try later.', 429);
  if (!response.ok) throw new ProviderError(`The market-data provider returned HTTP ${response.status}.`);
  let data;
  try { data = await response.json(); }
  catch { throw new ProviderError('The market-data provider returned invalid JSON.'); }
  const providerNotice = String(data?.Note || data?.Information || '');
  if (providerNotice) {
    if (/rate limit|call frequency|requests? per day|daily limit|standard api usage limit/i.test(providerNotice)) {
      throw new ProviderError('Alpha Vantage’s daily request limit was reached. Try again after the limit resets.', 429);
    }
    if (/premium/i.test(providerNotice)) throw new ProviderError(`Alpha Vantage requires a premium plan for ${fn}.`, 402);
    if (/api key/i.test(providerNotice)) throw new ProviderError('Alpha Vantage rejected the configured API key. Check it in Render’s environment settings.', 502);
    throw new ProviderError('Alpha Vantage could not complete this request. Try again later.', 502);
  }
  if (data?.['Error Message']) {
    const suggestion = symbol === 'APPL' ? ' Did you mean AAPL (Apple)?' : '';
    throw new ProviderError(`Ticker ${symbol} was not found.${suggestion}`, 404);
  }
  return data;
}

async function fetchCompany(symbol, key, fetchImpl = fetch) {
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) throw new ProviderError('Invalid ticker.', 400);
  if (!key) throw new ProviderError('Set ALPHA_VANTAGE_API_KEY in .env.local and restart the server.', 503);
  const results = [];
  for (const fn of ['TIME_SERIES_MONTHLY_ADJUSTED', 'EARNINGS', 'SPLITS', 'OVERVIEW']) {
    if (results.length && fetchImpl === fetch) await new Promise((resolve) => setTimeout(resolve, 1250));
    results.push(await providerQuery(fn, symbol, key, fetchImpl));
  }
  const [monthly, earnings, splits, overview] = results;
  return normalizeCompany(symbol, monthly, earnings, splits, overview);
}

module.exports = { ProviderError, normalizeCompany, fetchCompany, splitFactorAfter };
