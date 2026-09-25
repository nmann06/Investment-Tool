const test = require('node:test');
const assert = require('node:assert/strict');
const { median, cagr, calculate, annualSummary, yearRecord, recordGrowth } = require('../math.js');

test('the ten-year record takes the month-end close nearest each fiscal year end', () => {
  const rows = [
    { date: '2022-09-30', price: 100 },
    { date: '2023-08-31', price: 90 },
    { date: '2023-09-29', price: 110 },
    { date: '2024-08-30', price: 95 },
    // The fiscal year ends Saturday 2024-09-28; the month's last trading day is the Monday after.
    { date: '2024-09-30', price: 121 },
    { date: '2024-10-31', price: 500 }
  ];
  const annual = [
    { year: 2022, end: '2022-10-01', netIncome: 50, eps: 1, dividend: 0.4 },
    { year: 2023, end: '2023-09-30', netIncome: 55, eps: 1.1, dividend: 0.44 },
    { year: 2024, end: '2024-09-28', netIncome: 60.5, eps: 1.21, dividend: null }
  ];
  const record = yearRecord({ rows, annual });
  assert.deepEqual(record.map((year) => year.price), [100, 110, 121]);
  assert.equal(record[0].priceChange, null);
  assert.ok(Math.abs(record[1].priceChange - 0.1) < 1e-10);
  assert.ok(Math.abs(record[2].priceChange - 0.1) < 1e-10);
  assert.equal(yearRecord({ rows: [], annual })[1].price, null);
  assert.equal(record[2].dividend, null);
  assert.ok(Math.abs(recordGrowth(record, 'netIncome') - 0.1) < 0.002);
  assert.equal(recordGrowth(record.slice(0, 1), 'netIncome'), null);
});

test('annual summary reports EPS change, price range and average PE per fiscal year', () => {
  const rows = [
    { date: '2023-06-30', price: 20, eps: 1 },
    { date: '2023-12-29', price: 30, eps: 1.5 },
    { date: '2024-06-28', price: 40, eps: 2 },
    { date: '2024-12-31', price: 36, eps: 1.8 }
  ];
  const annual = [{ year: 2023, end: '2023-12-31', eps: 1.5, dividend: 0.5 }, { year: 2024, end: '2024-12-31', eps: 1.8, dividend: 0.6 }];
  const [first, second] = annualSummary(rows, annual);
  assert.equal(first.high, 30);
  assert.equal(first.low, 20);
  assert.equal(first.averagePe, 20);
  assert.ok(Math.abs(second.epsChange - 0.2) < 1e-10);
  assert.equal(second.averagePe, 20);
});

test('median handles odd and even sample counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('CAGR handles positive endpoints and invalid earnings', () => {
  assert.ok(Math.abs(cagr(100, 121, 2) - 0.1) < 1e-10);
  assert.equal(cagr(-1, 2, 2), null);
});

test('valuation uses median historical PE and EPS times benchmark', () => {
  const rows = [
    { date: '2023-01-01', price: 20, eps: 2 },
    { date: '2024-01-01', price: 30, eps: 2 },
    { date: '2025-01-01', price: 40, eps: 2 }
  ];
  const result = calculate(rows, 5, 0, 10);
  assert.equal(result.normalPe, 15);
  assert.equal(result.fairValue, 30);
  assert.equal(result.currentPe, 20);
  assert.ok(Math.abs(result.safety - (1 - 40 / 30)) < 1e-10);
  assert.ok(Math.abs(result.projectedReturn - (Math.pow(20 / 40, 1 / 5) - 1)) < 1e-10);
});

test('negative EPS cannot create a misleading normal PE', () => {
  const result = calculate([{ date: '2025-01-01', price: 10, eps: -2 }], 5);
  assert.equal(result.normalPe, null);
  assert.equal(result.fairValue, null);
  assert.equal(result.projectedReturn, null);
});
