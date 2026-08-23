import test from 'node:test';
import assert from 'node:assert/strict';
import { completedCandles, intervalMilliseconds, rankCandidates } from '../src/market/candles.js';

test('intervals are converted to milliseconds', () => {
  assert.equal(intervalMilliseconds('15m'), 900_000);
  assert.equal(intervalMilliseconds('1h'), 3_600_000);
});

test('current forming candle is excluded from indicator input', () => {
  const now = Date.UTC(2026, 7, 23, 12, 7);
  const candles = [{ time: Date.UTC(2026, 7, 23, 11, 45) }, { time: Date.UTC(2026, 7, 23, 12, 0) }];
  assert.deepEqual(completedCandles(candles, '15m', now), [candles[0]]);
});

test('candidates rank by score, then relative volume, independent of symbol order', () => {
  const candidates = [
    { symbol: 'zinr', signal: { score: 80, indicators: { volumeRatio: 2 } } },
    { symbol: 'ainr', signal: { score: 100, indicators: { volumeRatio: 1 } } },
    { symbol: 'binr', signal: { score: 80, indicators: { volumeRatio: 3 } } }
  ];
  assert.deepEqual(rankCandidates(candidates).map(x => x.symbol), ['ainr', 'binr', 'zinr']);
});
