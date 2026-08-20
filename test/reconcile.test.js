import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.tmpdir(), `wazirx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_PATH = dbPath;
process.env.LIVE_MODE = 'false';
process.env.WAZIRX_API_KEY = 'test-key';
process.env.WAZIRX_SECRET_KEY = 'test-secret';
process.env.MAX_OPEN_POSITIONS = '2';

const { store, db } = await import('../src/database/db.js');
const { wazirx } = await import('../src/api/wazirx.js');
const { reconcilePending } = await import('../src/trading/reconcile.js');

test.after(() => { for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true }); });

function insertPendingEntry(orderId, over = {}) {
  const id = store.openPending({ symbol: 'testinr', mode: 'LIVE', entryPrice: 10, quantity: 100, invested: 1000, stopPrice: 9.8, targetPrice: 10.4, score: 80, reason: 'test', clientOrderId: null, ...over });
  store.attachOrderId(id, 'buy', orderId);
  return id;
}

function insertPendingExit(orderId, over = {}) {
  const id = store.openPosition({ symbol: 'testinr', mode: 'LIVE', entryPrice: 10, quantity: 100, invested: 1000, stopPrice: 9.8, targetPrice: 10.4, score: 80, reason: 'test', ...over });
  store.markPendingExit(id, 'TARGET', null);
  store.attachOrderId(id, 'sell', orderId);
  return id;
}

function position(id) { return store.recentPositions(50).find(p => p.id === id); }

test('complete buy fill confirms OPEN with real quantity/price and recomputed stop/target', async (t) => {
  const id = insertPendingEntry('1001');
  t.mock.method(wazirx, 'orderStatus', async () => ({ status: 'done', executedQty: '100' }));
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '100', quoteQty: '1000', fee: '0', feeCurrency: 'inr' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  const p = position(id);
  assert.equal(p.status, 'OPEN');
  assert.equal(p.quantity, 100);
  assert.equal(p.entry_price, 10);
  assert.ok(Math.abs(p.stop_price - 9.8) < 1e-9);
  assert.ok(Math.abs(p.target_price - 10.4) < 1e-9);
});

test('complete sell fill (full quantity) confirms CLOSED with correct P&L', async (t) => {
  const id = insertPendingExit('2001');
  t.mock.method(wazirx, 'orderStatus', async () => ({ status: 'done', executedQty: '100' }));
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '100', quoteQty: '1050', fee: '0', feeCurrency: 'inr' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  const p = position(id);
  assert.equal(p.status, 'CLOSED');
  assert.ok(Math.abs(p.pnl - 50) < 1e-9);
});

test('buy cancelled after a partial fill confirms OPEN with the smaller real quantity', async (t) => {
  const id = insertPendingEntry('1002');
  t.mock.method(wazirx, 'orderStatus', async () => ({ status: 'cancel', executedQty: '40' }));
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '40', quoteQty: '400', fee: '0', feeCurrency: 'inr' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  const p = position(id);
  assert.equal(p.status, 'OPEN');
  assert.equal(p.quantity, 40);
  assert.equal(p.invested, 400);
});

test('sell cancelled after a partial fill splits: sold portion CLOSED, remainder stays OPEN', async (t) => {
  const id = insertPendingExit('2002');
  t.mock.method(wazirx, 'orderStatus', async () => ({ status: 'cancel', executedQty: '40' }));
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '40', quoteQty: '420', fee: '0', feeCurrency: 'inr' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  const remainder = position(id);
  assert.equal(remainder.status, 'OPEN');
  assert.equal(remainder.quantity, 60);
  assert.equal(remainder.invested, 600);
  const sold = store.recentPositions(50).find(p => p.status === 'CLOSED' && p.quantity === 40 && p.symbol === 'testinr');
  assert.ok(sold, 'expected a CLOSED row for the sold 40 qty');
  assert.ok(Math.abs(sold.pnl - 20) < 1e-9); // 420 proceeds - 400 proportional cost
});

test('buy fee charged in INR (quote asset) is added to invested cost', async (t) => {
  const id = insertPendingEntry('1003');
  t.mock.method(wazirx, 'orderStatus', async () => ({ status: 'done', executedQty: '736.48889' }));
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '736.48889', quoteQty: '16202.75558', fee: '32.40551116', feeCurrency: 'inr' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  const p = position(id);
  assert.ok(Math.abs(p.invested - (16202.75558 + 32.40551116)) < 1e-6);
  assert.equal(p.quantity, 736.48889);
});

test('buy fee charged in the base asset reduces the quantity actually received', async (t) => {
  const id = insertPendingEntry('1004');
  t.mock.method(wazirx, 'orderStatus', async () => ({ status: 'done', executedQty: '100' }));
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '100', quoteQty: '1000', fee: '0.2', feeCurrency: 'test' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  const p = position(id);
  assert.equal(p.quantity, 99.8);
  assert.equal(p.invested, 1000);
});

test('reconciling twice is idempotent — a resolved position is not reprocessed', async (t) => {
  const id = insertPendingEntry('1007');
  let calls = 0;
  t.mock.method(wazirx, 'orderStatus', async () => { calls++; return { status: 'done', executedQty: '100' }; });
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '100', quoteQty: '1000', fee: '0', feeCurrency: 'inr' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  assert.equal(calls, 1);
  await reconcilePending();
  assert.equal(calls, 1, 'already-OPEN position should not be queried again');
  assert.equal(position(id).status, 'OPEN');
});

test('zero/empty fills on a terminal order are handled without corrupting state', async (t) => {
  const id = insertPendingEntry('1008');
  t.mock.method(wazirx, 'orderStatus', async () => ({ status: 'cancel', executedQty: '0.5' }));
  t.mock.method(wazirx, 'myTrades', async () => ([])); // executedQty says partial, but no fills come back
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  assert.equal(position(id).status, 'CANCELLED');
});

test('todayPnl uses IST day boundaries, not UTC ones', () => {
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnightUtcMs = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - IST_OFFSET_MS;
  const justBeforeIstMidnight = new Date(istMidnightUtcMs - 1000).toISOString();
  const justAfterIstMidnight = new Date(istMidnightUtcMs + 1000).toISOString();
  const baseline = store.todayPnl('PAPER');

  const excludedId = store.openPosition({ symbol: 'istinr', mode: 'PAPER', entryPrice: 1, quantity: 1, invested: 1, stopPrice: 1, targetPrice: 1, score: 1, reason: 'x' });
  store.closePosition(excludedId, 1, 1000, 'TARGET');
  db.prepare('UPDATE positions SET closed_at=? WHERE id=?').run(justBeforeIstMidnight, excludedId);
  assert.equal(store.todayPnl('PAPER'), baseline, 'a trade closed just before IST midnight must not count as today');

  const includedId = store.openPosition({ symbol: 'istinr', mode: 'PAPER', entryPrice: 1, quantity: 1, invested: 1, stopPrice: 1, targetPrice: 1, score: 1, reason: 'x' });
  store.closePosition(includedId, 1, 55, 'TARGET');
  db.prepare('UPDATE positions SET closed_at=? WHERE id=?').run(justAfterIstMidnight, includedId);
  assert.ok(Math.abs(store.todayPnl('PAPER') - (baseline + 55)) < 1e-9, 'a trade closed just after IST midnight must count as today');
});

test('PAPER and LIVE P&L never mix — totalPnl/todayPnl/consecutiveLosses are mode-scoped', () => {
  const paperBefore = store.totalPnl('PAPER');
  const liveBefore = store.totalPnl('LIVE');
  const liveLossesBefore = store.consecutiveLosses('LIVE');

  const paperLossId = store.openPosition({ symbol: 'mixinr', mode: 'PAPER', entryPrice: 1, quantity: 1, invested: 1, stopPrice: 1, targetPrice: 1, score: 1, reason: 'x' });
  store.closePosition(paperLossId, 1, -500, 'STOP_OR_TRAILING_STOP');
  const paperLossId2 = store.openPosition({ symbol: 'mixinr', mode: 'PAPER', entryPrice: 1, quantity: 1, invested: 1, stopPrice: 1, targetPrice: 1, score: 1, reason: 'x' });
  store.closePosition(paperLossId2, 1, -500, 'STOP_OR_TRAILING_STOP');

  assert.equal(store.totalPnl('LIVE'), liveBefore, 'PAPER losses must not appear in LIVE totalPnl');
  assert.equal(store.consecutiveLosses('LIVE'), liveLossesBefore, 'PAPER losses must not count toward the LIVE consecutive-loss breaker');
  assert.ok(Math.abs(store.totalPnl('PAPER') - (paperBefore - 1000)) < 1e-9, 'the PAPER losses must still be visible under the PAPER mode');
});

test('a stale exit that fills between cancel-request and status-check is reconciled, not discarded', async (t) => {
  const id = insertPendingExit('3001');
  db.prepare('UPDATE positions SET pending_since=? WHERE id=?').run(new Date(Date.now() - 60 * 60000).toISOString(), id);
  let statusCalls = 0;
  t.mock.method(wazirx, 'orderStatus', async () => {
    statusCalls++;
    // First call (the staleness check) sees it still waiting; by the time cancelStale re-checks
    // after issuing the cancel, the order has actually filled — the race the review flagged.
    return statusCalls === 1 ? { status: 'wait', createdTime: Date.now() - 60 * 60000 } : { status: 'done', executedQty: '100' };
  });
  t.mock.method(wazirx, 'cancelOrder', async () => ({}));
  t.mock.method(wazirx, 'myTrades', async () => ([{ qty: '100', quoteQty: '1050', fee: '0', feeCurrency: 'inr' }]));
  t.mock.method(wazirx, 'openOrders', async () => ([]));
  await reconcilePending();
  const p = position(id);
  assert.equal(p.status, 'CLOSED', 'the fill that snuck in during cancellation must still be reconciled');
  assert.ok(Math.abs(p.pnl - 50) < 1e-9);
});

