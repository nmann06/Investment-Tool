const test = require('node:test');
const assert = require('node:assert/strict');
const { median, cagr, calculate } = require('../math.js');

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
