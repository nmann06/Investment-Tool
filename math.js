(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ValuationMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const GRAHAM_PE = 15;

  function median(values) {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function yearsBetween(first, last) {
    return (new Date(`${last}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / (365.2425 * 24 * 60 * 60 * 1000);
  }

  function cagr(first, last, years) {
    if (!finite(first) || !finite(last) || first <= 0 || last <= 0 || years <= 0) return null;
    return Math.pow(last / first, 1 / years) - 1;
  }

  function calculate(rows, years, growthRate = 0.08, exitPe = null) {
    const clean = rows
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && finite(row.price) && row.price > 0 && (row.eps == null || finite(row.eps)))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!clean.length) return null;
    const last = clean[clean.length - 1];
    const cutoff = new Date(`${last.date}T00:00:00Z`);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
    const period = clean.filter((row) => new Date(`${row.date}T00:00:00Z`) >= cutoff);
    const observed = period
      .filter((row) => row.eps > 0)
      .map((row) => row.price / row.eps)
      .filter((pe) => pe >= 2 && pe <= 100);
    const normalPe = median(observed);
    const currentPe = last.eps > 0 ? last.price / last.eps : null;
    const fairValue = normalPe !== null && last.eps > 0 ? last.eps * normalPe : null;
    const grahamValue = last.eps > 0 ? last.eps * GRAHAM_PE : null;
    const safety = fairValue !== null && fairValue > 0 ? 1 - last.price / fairValue : null;
    const firstPositive = period.find((row) => row.eps > 0);
    const epsGrowth = firstPositive && last.eps > 0 ? cagr(firstPositive.eps, last.eps, yearsBetween(firstPositive.date, last.date)) : null;
    const dividend = finite(last.dividend) && last.dividend > 0 ? last.dividend : 0;
    const dividendYield = dividend / last.price;
    const payoutRatio = dividend > 0 && last.eps > 0 ? dividend / last.eps : null;
    // Total return assumes dividends are received but not reinvested; each month earns 1/12 of the trailing dividend.
    const first = period[0];
    const elapsed = yearsBetween(first.date, last.date);
    const dividendsReceived = period.slice(1).reduce((sum, row) => sum + (finite(row.dividend) && row.dividend > 0 ? row.dividend / 12 : 0), 0);
    const priceReturn = cagr(first.price, last.price, elapsed);
    const totalReturn = cagr(first.price, last.price + dividendsReceived, elapsed);
    const projectionPe = finite(exitPe) && exitPe > 0 ? exitPe : normalPe;
    const projectedEps = last.eps > 0 ? last.eps * Math.pow(1 + growthRate, 5) : null;
    const projectedPrice = projectedEps !== null && projectionPe !== null ? projectedEps * projectionPe : null;
    const projectedReturn = projectedPrice !== null ? cagr(last.price, projectedPrice, 5) : null;
    const projectedDividends = projectedEps !== null && payoutRatio !== null ? [1, 2, 3, 4, 5].reduce((sum, year) => sum + last.eps * Math.pow(1 + growthRate, year) * payoutRatio, 0) : 0;
    const projectedTotalReturn = projectedPrice !== null ? cagr(last.price, projectedPrice + projectedDividends, 5) : null;
    return { period, latest: last, normalPe, currentPe, fairValue, grahamValue, safety, epsGrowth, dividendYield, payoutRatio, priceReturn, totalReturn, elapsed, projectionPe, projectedEps, projectedPrice, projectedReturn, projectedTotalReturn, growthRate, observationCount: observed.length };
  }

  // Year-by-year table. Uses reported fiscal years when available, otherwise calendar years from the rows.
  function annualSummary(rows, annual) {
    const sorted = rows.filter((row) => finite(row.price)).sort((a, b) => a.date.localeCompare(b.date));
    if (!sorted.length) return [];
    const years = Array.isArray(annual) && annual.length
      ? annual.map((item) => ({ year: item.year, end: item.end, eps: item.eps, dividend: item.dividend }))
      : [...new Set(sorted.map((row) => row.date.slice(0, 4)))].map((year) => {
        const inYear = sorted.filter((row) => row.date.startsWith(year));
        const lastRow = inYear[inYear.length - 1];
        return { year: Number(year), end: lastRow.date, eps: lastRow.eps, dividend: lastRow.dividend ?? null };
      });
    const yearBefore = (date) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
    let previousEnd = null;
    return years.map((item, index) => {
      const from = previousEnd && previousEnd > yearBefore(item.end) ? previousEnd : yearBefore(item.end);
      const inYear = sorted.filter((row) => row.date <= item.end && row.date > from);
      previousEnd = item.end;
      const ratios = inYear.filter((row) => row.eps > 0).map((row) => row.price / row.eps);
      const previous = years[index - 1];
      const epsChange = previous && finite(previous.eps) && finite(item.eps) && previous.eps > 0 && item.eps > 0 ? item.eps / previous.eps - 1 : null;
      return {
        ...item,
        epsChange,
        partial: inYear.length < 11,
        high: inYear.length ? Math.max(...inYear.map((row) => row.price)) : null,
        low: inYear.length ? Math.min(...inYear.map((row) => row.price)) : null,
        averagePe: ratios.length ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : null
      };
    }).filter((item) => item.high != null);
  }

  // Fiscal-year net income, EPS, dividends and year-end share price for the ten-year record.
  // The year-end price is the month-end close nearest the fiscal year end, within 20 days either way:
  // many fiscal years end on a Saturday a few days before the month's last trading day.
  function yearRecord(company) {
    const rows = (company.rows || []).filter((row) => finite(row.price));
    const years = (company.annual || []).filter((item) => item && item.end).slice().sort((a, b) => a.end.localeCompare(b.end));
    const gap = (row, end) => Math.abs(yearsBetween(row.date, end)) * 365.2425;
    let previous = null;
    return years.map((year) => {
      const close = rows.filter((row) => gap(row, year.end) <= 20).sort((a, b) => gap(a, year.end) - gap(b, year.end))[0];
      const price = close ? close.price : null;
      const consecutive = previous && yearsBetween(previous.end, year.end) < 1.1;
      const priceChange = consecutive && finite(previous.price) && finite(price) && previous.price > 0 ? price / previous.price - 1 : null;
      previous = { end: year.end, price };
      return { year: year.year, end: year.end, netIncome: finite(year.netIncome) ? year.netIncome : null, eps: finite(year.eps) ? year.eps : null, dividend: finite(year.dividend) ? year.dividend : null, price, priceChange };
    });
  }

  // Compound annual growth between the first and last positive values of one field.
  function recordGrowth(record, key) {
    const points = record.filter((year) => finite(year[key]) && year[key] > 0);
    if (points.length < 2) return null;
    const first = points[0], last = points[points.length - 1];
    return cagr(first[key], last[key], yearsBetween(first.end, last.end));
  }

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const ratio = (top, bottom) => finite(top) && finite(bottom) && bottom !== 0 ? top / bottom : null;
  const positiveRatio = (top, bottom) => finite(top) && finite(bottom) && bottom > 0 ? top / bottom : null;
  const DEFAULT_TAX = 0.21;

  function taxRate(year) {
    return year && year.pretaxIncome > 0 && finite(year.incomeTax) ? clamp(year.incomeTax / year.pretaxIncome, 0, 0.35) : DEFAULT_TAX;
  }

  // Adds derived metrics to each fiscal year of raw statement values.
  function yearMetrics(annual) {
    const years = (annual || []).filter((item) => item && item.end).slice().sort((a, b) => a.end.localeCompare(b.end));
    return years.map((year, index) => {
      const fcf = finite(year.operatingCashFlow) && finite(year.capex) ? year.operatingCashFlow - year.capex : null;
      const tax = taxRate(year);
      const investedCapital = finite(year.equity) && finite(year.debt) ? year.equity + year.debt - (year.cash || 0) : null;
      const previous = years[index - 1];
      const previousCapital = previous && finite(previous.equity) && finite(previous.debt) ? previous.equity + previous.debt - (previous.cash || 0) : null;
      const averageCapital = investedCapital != null && previousCapital != null ? (investedCapital + previousCapital) / 2 : investedCapital;
      return {
        ...year,
        fcf,
        fcfPerShare: positiveRatio(fcf, year.dilutedShares),
        grossMargin: positiveRatio(year.grossProfit, year.revenue),
        operatingMargin: positiveRatio(year.operatingIncome, year.revenue),
        fcfMargin: positiveRatio(fcf, year.revenue),
        netDebt: finite(year.debt) && finite(year.cash) ? year.debt - year.cash : null,
        taxRate: tax,
        roic: finite(year.operatingIncome) && averageCapital > 0 ? year.operatingIncome * (1 - tax) / averageCapital : null
      };
    });
  }

  // CAGR between the latest fiscal year and the fiscal year `years` earlier; both values must be positive.
  function growthOver(years, field, span) {
    const withValue = years.filter((year) => finite(year[field]) && year[field] > 0);
    const last = withValue[withValue.length - 1];
    const first = last && withValue.find((year) => year.year === last.year - span);
    return last && first ? cagr(first[field], last[field], span) : null;
  }

  function monthlyReturns(rows) {
    const byMonth = new Map((rows || []).filter((row) => finite(row.price) && row.price > 0).map((row) => [row.date.slice(0, 7), row.price]));
    const months = [...byMonth.keys()].sort();
    const returns = new Map();
    for (let i = 1; i < months.length; i++) returns.set(months[i], byMonth.get(months[i]) / byMonth.get(months[i - 1]) - 1);
    return returns;
  }

  // Beta from up to five years of monthly returns against a market proxy, with the Blume adjustment toward 1.
  function beta(stockRows, marketRows, months = 60) {
    const stock = monthlyReturns(stockRows), market = monthlyReturns(marketRows);
    const pairs = [...stock.keys()].filter((month) => market.has(month)).sort().slice(-months).map((month) => [stock.get(month), market.get(month)]);
    if (pairs.length < 24) return null;
    const mean = (index) => pairs.reduce((sum, pair) => sum + pair[index], 0) / pairs.length;
    const stockMean = mean(0), marketMean = mean(1);
    const covariance = pairs.reduce((sum, [s, m]) => sum + (s - stockMean) * (m - marketMean), 0) / (pairs.length - 1);
    const variance = pairs.reduce((sum, [, m]) => sum + (m - marketMean) ** 2, 0) / (pairs.length - 1);
    if (!(variance > 0)) return null;
    const raw = covariance / variance;
    return { raw, adjusted: 0.67 * raw + 0.33, months: pairs.length };
  }

  // Two-stage DCF on free cash flow per share: five years at `growth`, five years fading to `terminalGrowth`, then a Gordon terminal value.
  function discountedCashFlow({ fcfPerShare, growth, terminalGrowth, discount }) {
    if (!(fcfPerShare > 0) || !finite(growth) || !finite(terminalGrowth) || !finite(discount) || discount <= terminalGrowth + 0.005) return null;
    let cash = fcfPerShare, presentValue = 0;
    for (let year = 1; year <= 10; year++) {
      const rate = year <= 5 ? growth : growth + (terminalGrowth - growth) * (year - 5) / 5;
      cash *= 1 + rate;
      presentValue += cash / Math.pow(1 + discount, year);
    }
    const terminal = cash * (1 + terminalGrowth) / (discount - terminalGrowth);
    const presentTerminal = terminal / Math.pow(1 + discount, 10);
    const value = presentValue + presentTerminal;
    return { value, presentValue, presentTerminal, terminalShare: presentTerminal / value };
  }

  function fundamentals(company, options = {}) {
    const years = yearMetrics(company.annual);
    if (!years.some((year) => finite(year.revenue))) return null;
    const rows = (company.rows || []).filter((row) => finite(row.price));
    const latestRow = rows[rows.length - 1];
    const price = options.price ?? latestRow?.price;
    const latestYear = [...years].reverse().find((year) => finite(year.revenue)) || years[years.length - 1];
    const ttm = company.ttm || {};
    const balance = company.balance || latestYear;
    const shares = company.sharesOutstanding?.value || latestYear.dilutedShares;
    const marketCap = finite(price) && shares > 0 ? price * shares : null;
    const cash = balance.cash ?? latestYear.cash ?? 0;
    const debt = balance.debt ?? latestYear.debt ?? 0;
    const ttmFcf = finite(ttm.operatingCashFlow) && finite(ttm.capex) ? ttm.operatingCashFlow - ttm.capex : latestYear.fcf;
    const ebit = ttm.operatingIncome ?? latestYear.operatingIncome;
    const depreciation = ttm.depreciation ?? latestYear.depreciation;
    const ev = marketCap != null ? marketCap + debt - cash : null;
    const tax = taxRate(latestYear);

    const riskFree = finite(options.riskFree) ? options.riskFree : null;
    const erp = finite(options.equityPremium) ? options.equityPremium : 0.05;
    const betaResult = options.benchmarkRows ? beta(rows, options.benchmarkRows) : null;
    const betaValue = betaResult ? clamp(betaResult.adjusted, 0.3, 3) : 1;
    const costEquity = riskFree != null ? riskFree + betaValue * erp : null;
    const averageDebt = years.length > 1 && finite(years[years.length - 2].debt) && finite(latestYear.debt) ? (years[years.length - 2].debt + latestYear.debt) / 2 : latestYear.debt;
    const impliedDebtCost = positiveRatio(latestYear.interestExpense, averageDebt);
    const costDebt = riskFree == null ? null : impliedDebtCost != null ? clamp(impliedDebtCost, 0.01, 0.15) : riskFree + 0.015;
    const equityWeight = marketCap != null ? marketCap / (marketCap + debt) : null;
    const wacc = costEquity != null && equityWeight != null ? equityWeight * costEquity + (1 - equityWeight) * costDebt * (1 - tax) : null;

    const growth = {
      revenue5: growthOver(years, 'revenue', 5), revenue10: growthOver(years, 'revenue', 10),
      eps5: growthOver(years, 'eps', 5), eps10: growthOver(years, 'eps', 10),
      fcfPerShare5: growthOver(years, 'fcfPerShare', 5), dividend5: growthOver(years, 'dividend', 5),
      shares5: growthOver(years, 'dilutedShares', 5)
    };
    const fcfPerShare = positiveRatio(ttmFcf, shares);
    const defaultGrowth = clamp(growth.fcfPerShare5 ?? growth.revenue5 ?? 0.05, 0, 0.15);
    const dcfInputs = { fcfPerShare, growth: options.dcfGrowth ?? defaultGrowth, terminalGrowth: options.terminalGrowth ?? 0.025, discount: options.discount ?? wacc ?? 0.09 };
    const dcf = discountedCashFlow(dcfInputs);
    const ttmEps = latestRow?.eps;

    return {
      years, latestYear, price, shares, sharesSource: company.sharesOutstanding?.source || 'Diluted weighted-average shares', ttmEnd: ttm.end || latestYear.end,
      growth,
      profitability: { grossMargin: latestYear.grossMargin, operatingMargin: latestYear.operatingMargin, fcfMargin: latestYear.fcfMargin, roic: latestYear.roic, ttmOperatingMargin: positiveRatio(ttm.operatingIncome, ttm.revenue), ttmFcfMargin: positiveRatio(ttmFcf, ttm.revenue) },
      balance: { end: balance.end || latestYear.end, cash, debt, netDebt: debt - cash, debtToFcf: positiveRatio(debt, ttmFcf) },
      valuation: {
        marketCap, ev, ttmFcf, fcfPerShare,
        pe: positiveRatio(price, ttmEps), pfcf: positiveRatio(marketCap, ttmFcf), fcfYield: ratio(ttmFcf, marketCap),
        evEbit: positiveRatio(ev, ebit), evEbitda: finite(ebit) && finite(depreciation) ? positiveRatio(ev, ebit + depreciation) : null
      },
      capital: { riskFree, equityPremium: erp, beta: betaResult, betaUsed: betaValue, costEquity, costDebt, costDebtEstimated: impliedDebtCost == null, taxRate: tax, equityWeight, wacc, roicSpread: finite(latestYear.roic) && wacc != null ? latestYear.roic - wacc : null },
      dcf: { ...dcfInputs, defaultGrowth, result: dcf, marginOfSafety: dcf && finite(price) ? 1 - price / dcf.value : null }
    };
  }

  return { GRAHAM_PE, median, yearsBetween, cagr, calculate, annualSummary, yearRecord, recordGrowth, yearMetrics, growthOver, beta, discountedCashFlow, fundamentals };
});
