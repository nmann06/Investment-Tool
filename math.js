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

  return { GRAHAM_PE, median, yearsBetween, cagr, calculate, annualSummary };
});
