const test = require('node:test');
const assert = require('node:assert/strict');
const { yearMetrics, growthOver, beta, discountedCashFlow, fundamentals } = require('../math.js');
const { latestTtm, buildFundamentals } = require('../provider.js');

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);

test('year metrics derive FCF, margins and ROIC from raw statement values', () => {
  const [first, second] = yearMetrics([
    { year: 2023, end: '2023-12-31', revenue: 1000, grossProfit: 400, operatingIncome: 200, pretaxIncome: 200, incomeTax: 40, operatingCashFlow: 250, capex: 50, dilutedShares: 100, cash: 100, debt: 300, equity: 600 },
    { year: 2024, end: '2024-12-31', revenue: 1100, grossProfit: 440, operatingIncome: 220, pretaxIncome: 220, incomeTax: 44, operatingCashFlow: 300, capex: 60, dilutedShares: 100, cash: 100, debt: 300, equity: 800 }
  ]);
  assert.equal(first.fcf, 200);
  assert.equal(first.fcfPerShare, 2);
  close(first.grossMargin, 0.4);
  close(first.operatingMargin, 0.2);
  close(first.taxRate, 0.2);
  close(first.roic, 200 * 0.8 / 800);
  // Second year averages invested capital: (800 + 1000) / 2
  close(second.roic, 220 * 0.8 / 900);
  assert.equal(second.netDebt, 200);
});

test('growth needs the exact earlier fiscal year and positive values', () => {
  const years = [2019, 2020, 2021, 2022, 2023, 2024].map((year, index) => ({ year, revenue: 100 * Math.pow(1.1, index) }));
  close(growthOver(years, 'revenue', 5), 0.1);
  assert.equal(growthOver(years, 'revenue', 10), null);
});

test('beta of a stock that moves twice as much as the market', () => {
  const market = [], stock = [];
  let m = 100, s = 100;
  for (let i = 0; i < 40; i++) {
    const move = Math.sin(i) * 0.03;
    m *= 1 + move; s *= 1 + 2 * move;
    const date = `${2020 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-28`;
    market.push({ date, price: m }); stock.push({ date, price: s });
  }
  const result = beta(stock, market);
  close(result.raw, 2, 1e-6);
  close(result.adjusted, 0.67 * 2 + 0.33, 1e-6);
  assert.equal(beta(stock.slice(0, 10), market.slice(0, 10)), null);
});

test('DCF with zero growth equals a perpetuity', () => {
  const result = discountedCashFlow({ fcfPerShare: 10, growth: 0, terminalGrowth: 0, discount: 0.1 });
  close(result.value, 100, 1e-9);
  assert.equal(discountedCashFlow({ fcfPerShare: 10, growth: 0, terminalGrowth: 0.08, discount: 0.08 }), null);
  assert.equal(discountedCashFlow({ fcfPerShare: -1, growth: 0, terminalGrowth: 0, discount: 0.1 }), null);
});

test('valuation multiples use trailing figures and the latest balance sheet', () => {
  const company = {
    rows: [{ date: '2025-06-30', price: 50, eps: 2.5 }],
    annual: [{ year: 2024, end: '2024-12-31', revenue: 1000, operatingIncome: 200, operatingCashFlow: 250, capex: 50, dilutedShares: 100, cash: 100, debt: 300, equity: 600, interestExpense: 15 }],
    ttm: { end: '2025-06-30', revenue: 1200, operatingIncome: 240, depreciation: 60, operatingCashFlow: 300, capex: 60 },
    balance: { end: '2025-06-30', cash: 200, debt: 400, equity: 700 },
    sharesOutstanding: { value: 100, date: '2025-07-15' }
  };
  const F = fundamentals(company, { riskFree: 0.04, equityPremium: 0.05 });
  assert.equal(F.valuation.marketCap, 5000);
  assert.equal(F.valuation.ev, 5200);
  assert.equal(F.valuation.ttmFcf, 240);
  close(F.valuation.pe, 20);
  close(F.valuation.pfcf, 5000 / 240);
  close(F.valuation.evEbit, 5200 / 240);
  close(F.valuation.evEbitda, 5200 / 300);
  // No benchmark → beta 1.0, cost of equity 9%; cost of debt 15 / 300 = 5%.
  close(F.capital.costEquity, 0.09);
  close(F.capital.costDebt, 0.05);
  const weight = 5000 / 5400;
  close(F.capital.wacc, weight * 0.09 + (1 - weight) * 0.05 * (1 - 0.21));
});

test('TTM from year-to-date cash flows', () => {
  const periods = [
    { kind: 'FY', start: '2024-01-01', end: '2024-12-31', value: 100 },
    { kind: 'H', start: '2024-01-01', end: '2024-06-30', value: 40 },
    { kind: 'H', start: '2025-01-01', end: '2025-06-30', value: 60 }
  ];
  assert.deepEqual(latestTtm(periods), { end: '2025-06-30', value: 120 });
  assert.deepEqual(latestTtm(periods.slice(0, 1)), { end: '2024-12-31', value: 100 });
});

test('statements are assembled per fiscal year from SEC facts', () => {
  const flow = (val, start = '2024-01-01', end = '2024-12-31') => ({ start, end, val, filed: '2025-02-01', form: '10-K' });
  const instant = (val, end = '2024-12-31') => ({ end, val, filed: '2025-02-01', form: '10-K' });
  const usd = (...items) => ({ units: { USD: items } });
  const usGaap = {
    EarningsPerShareDiluted: { units: { 'USD/shares': [flow(2)] } },
    Revenues: usd(flow(1000)),
    CostOfRevenue: usd(flow(600)),
    OperatingIncomeLoss: usd(flow(200)),
    NetCashProvidedByUsedInOperatingActivities: usd(flow(250)),
    PaymentsToAcquirePropertyPlantAndEquipment: usd(flow(50)),
    CashAndCashEquivalentsAtCarryingValue: usd(instant(80)),
    ShortTermInvestments: usd(instant(20)),
    LongTermDebt: usd(instant(300)),
    CommercialPaper: usd(instant(10)),
    StockholdersEquity: usd(instant(600)),
    WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [flow(100)] } }
  };
  const result = buildFundamentals(usGaap, { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2025-01-20', val: 98, filed: '2025-02-01', form: '10-K' }] } } });
  const year = result.annual.find((item) => item.end === '2024-12-31');
  assert.equal(year.revenue, 1000);
  assert.equal(year.grossProfit, 400);
  assert.equal(year.cash, 100);
  assert.equal(year.debt, 310);
  assert.equal(year.dilutedShares, 100);
  assert.equal(result.ttm.revenue, 1000);
  assert.deepEqual(result.sharesOutstanding, { value: 98, date: '2025-01-20', source: 'Cover page shares outstanding' });
});
