// node --test deploy/tests/loadtest/compare-p95.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, count429, p95Of } from './compare-p95.mjs';

const summary = (stat, api, n429 = 0) => ({
  metrics: {
    'http_req_duration{scenario:static}': { values: { 'p(95)': stat } },
    'http_req_duration{scenario:api}': { values: { 'p(95)': api } },
    status_429: { values: { count: n429 } },
  },
});

test('reads the p95 and the 429 count', () => {
  assert.equal(p95Of(summary(3, 40), 'api'), 40);
  assert.equal(count429(summary(3, 40, 7)), 7);
  assert.equal(count429({ metrics: {} }), 0);
  assert.throws(() => p95Of({ metrics: {} }, 'api'));
});

test('passes within 10 % of the baseline', () => {
  const r = compare({ base: [[summary(100, 200)], [summary(100, 200)]], abuse: [[summary(109, 219)]], floorMs: 0 });
  assert.equal(r.ok, true);
});

test('fails above 10 % with no floor', () => {
  const r = compare({ base: [[summary(100, 200)]], abuse: [[summary(100, 221)]], floorMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.rows.find((x) => x.scenario === 'api').ok, false);
  assert.equal(r.rows.find((x) => x.scenario === 'static').ok, true);
});

test('the noise floor tolerates a few milliseconds on small p95s', () => {
  const small = compare({ base: [[summary(4, 10)]], abuse: [[summary(8, 14)]], floorMs: 5 });
  assert.equal(small.ok, true);
  const big = compare({ base: [[summary(4, 10)]], abuse: [[summary(10, 10)]], floorMs: 5 });
  assert.equal(big.ok, false);
});

test('means over clients, then over windows', () => {
  const r = compare({
    base: [[summary(10, 10), summary(30, 30)]],
    abuse: [[summary(20, 20), summary(20, 20)]],
    floorMs: 0,
  });
  assert.equal(r.rows[0].base, 20);
  assert.equal(r.rows[0].delta, 0);
});

test('refuses empty window lists', () => {
  assert.throws(() => compare({ base: [], abuse: [[summary(1, 1)]] }));
});
