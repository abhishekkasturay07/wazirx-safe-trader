import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `wazirx-liquidity-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
Object.assign(process.env, {
  DATABASE_PATH: dbPath,
  MAX_SPREAD_PERCENT: '0.3',
  MAX_ESTIMATED_SLIPPAGE_PERCENT: '0.25',
  MIN_24H_QUOTE_VOLUME_INR: '10000000'
});

const { estimatedSellSlippagePercent, liquidityCheck } = await import('../src/jobs/scanner.js');

test.after(() => { for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true }); });

test('order-book liquidation estimate accounts for walking down bid levels', () => {
  const slippage = estimatedSellSlippagePercent([['100', '1'], ['99', '9']], 500);
  assert.ok(Math.abs(slippage - 0.8) < 1e-9);
});

test('liquidity gate rejects wide spreads, low volume, and shallow books', () => {
  const healthyTicker = { bidPrice: '100', askPrice: '100.2', lastPrice: '100', volume: '200000' };
  const deepBook = { bids: [['100', '10']] };
  assert.equal(liquidityCheck(healthyTicker, deepBook, 500).allowed, true);
  assert.match(liquidityCheck({ ...healthyTicker, askPrice: '101' }, deepBook, 500).reason, /spread/);
  assert.match(liquidityCheck({ ...healthyTicker, volume: '10' }, deepBook, 500).reason, /volume/);
  assert.match(liquidityCheck(healthyTicker, { bids: [['100', '1'], ['90', '10']] }, 500).reason, /slippage/);
});
