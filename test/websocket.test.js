import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `wazirx-websocket-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_PATH = dbPath;
process.env.WEBSOCKET_ENABLED = 'false';
const { tickerUpdates } = await import('../src/jobs/price-monitor.js');

test.after(() => { for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true }); });

test('ticker stream parser returns last and executable bid prices and ignores invalid payloads', () => {
  assert.deepEqual(tickerUpdates({ stream: '!ticker@arr', data: [{ E: 123, s: 'BTCINR', c: '105', b: '104', a: '106' }] }), [
    { symbol: 'btcinr', eventTime: 123, last: 105, bid: 104 }
  ]);
  assert.deepEqual(tickerUpdates({ stream: 'other', data: [] }), []);
  assert.deepEqual(tickerUpdates({ stream: '!ticker@arr', data: [{ s: 'bad', c: 'NaN' }] }), []);
});
