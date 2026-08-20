import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.tmpdir(), `wazirx-live-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_PATH = dbPath;
process.env.LIVE_MODE = 'true';
process.env.LIVE_CONFIRMATION = 'I_UNDERSTAND_LIVE_TRADING_RISK';
process.env.WAZIRX_API_KEY = 'test-key';
process.env.WAZIRX_SECRET_KEY = 'test-secret';
process.env.MAX_OPEN_POSITIONS = '5';
// Explicit and generous so the position-count cap (not capital) is what's under test — otherwise a
// developer's local .env (small STARTING_CAPITAL_INR) would silently exhaust capital first.
process.env.STARTING_CAPITAL_INR = '100000';
process.env.MAX_POSITION_INR = '10';

const { store } = await import('../src/database/db.js');
const { wazirx } = await import('../src/api/wazirx.js');
const { enter } = await import('../src/trading/engine.js');

test.after(() => { for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true }); });

function stubCommon(t) {
  t.mock.method(wazirx, 'funds', async () => ([{ asset: 'inr', free: '10000', locked: '0' }]));
  t.mock.method(wazirx, 'roundForSymbol', async (_symbol, price, quantity) => ({ price, quantity }));
}

test('an ambiguous (network-level) placeLimitOrder failure leaves the row PENDING, not CANCELLED', async (t) => {
  stubCommon(t);
  t.mock.method(wazirx, 'placeLimitOrder', async () => { throw new Error('fetch failed'); }); // no .definitive — unknown outcome
  t.mock.method(wazirx, 'orderStatus', async () => { throw new Error('lookup also failed'); }); // verification attempt fails too
  const id = await enter('ambinr', { score: 90, price: 10, reasons: ['test'] });
  const p = store.recentPositions(50).find(x => x.id === id);
  assert.equal(p.status, 'PENDING_ENTRY', 'must stay pending — an unresolved outcome is not a confirmed non-order');
  assert.equal(p.client_order_id != null, true, 'clientOrderId must remain so reconcilePending() can keep retrying it');
});

test('a definitive (HTTP-rejected) placeLimitOrder failure cancels the row immediately', async (t) => {
  stubCommon(t);
  t.mock.method(wazirx, 'placeLimitOrder', async () => { throw Object.assign(new Error('WazirX 400: bad request'), { definitive: true }); });
  t.mock.method(wazirx, 'orderStatus', async () => { throw new Error('not found'); });
  await assert.rejects(() => enter('definr', { score: 90, price: 10, reasons: ['test'] }));
  const p = store.recentPositions(50).find(x => x.symbol === 'definr');
  assert.equal(p.status, 'CANCELLED', 'a confirmed rejection has nothing to reconcile later, so it can be unwound now');
});

test('an ambiguous failure that resolves via the clientOrderId lookup attaches the real order id', async (t) => {
  stubCommon(t);
  t.mock.method(wazirx, 'placeLimitOrder', async () => { throw new Error('timeout'); });
  t.mock.method(wazirx, 'orderStatus', async () => ({ id: 555 })); // the order actually landed despite the timeout
  const id = await enter('foundinr', { score: 90, price: 10, reasons: ['test'] });
  const p = store.recentPositions(50).find(x => x.id === id);
  assert.equal(p.status, 'PENDING_ENTRY');
  assert.equal(p.buy_order_id, '555');
});

test('enter() refuses a new position once PENDING_ENTRY rows alone reach MAX_OPEN_POSITIONS', async (t) => {
  stubCommon(t);
  let counter = 9000;
  t.mock.method(wazirx, 'placeLimitOrder', async () => ({ id: counter++ }));
  const cap = Number(process.env.MAX_OPEN_POSITIONS);
  let padded = 0;
  while (store.activePositions('LIVE').length < cap) {
    const result = await enter(`pad${padded}inr`, { score: 90, price: 10, reasons: ['test'] });
    assert.ok(result != null, `enter() unexpectedly refused pad${padded}inr before the cap was reached — check STARTING_CAPITAL_INR/MAX_POSITION_INR in this test`);
    padded++;
    assert.ok(padded <= cap + 2, 'padding loop exceeded the cap — bailing out instead of hanging');
  }
  assert.ok(store.activePositions('LIVE').length >= cap, 'setup must actually reach the cap before asserting the guard');
  const result = await enter('overflowinr', { score: 90, price: 10, reasons: ['test'] });
  assert.equal(result, null, 'a PENDING_ENTRY-only cap must still block new entries');
});
