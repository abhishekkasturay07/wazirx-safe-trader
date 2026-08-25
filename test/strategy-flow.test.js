import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `wazirx-strategy-flow-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
Object.assign(process.env, {
  DATABASE_PATH: dbPath, LIVE_MODE: 'false', STARTING_CAPITAL_INR: '2483.19', MAX_POSITION_INR: '500',
  PAUSE_NEW_ENTRIES: 'false',
  INITIAL_POSITION_INR: '300', ADD_POSITION_INR: '200', ADD_TRIGGER_PERCENT: '1', MAX_OPEN_POSITIONS: '4',
  STOP_LOSS_PERCENT: '2', FIRST_TAKE_PROFIT_PERCENT: '4', FIRST_SELL_PERCENT: '30',
  SECOND_TAKE_PROFIT_PERCENT: '7', SECOND_SELL_PERCENT: '30', TRAILING_STOP_PERCENT: '4',
  COOLDOWN_CANDLES: '4', MAX_HOLDING_HOURS: '48', TRADING_FEE_PERCENT: '0.2'
});

const { store } = await import('../src/database/db.js');
const { enter, managePosition } = await import('../src/trading/engine.js');

test.after(() => { for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true }); });

const entrySignal = { score: 80, price: 100, reasons: ['test'] };
const continuation = { checks: { emaTrend: true, marketTrend: true }, indicators: { candleBullish: true, rsi: 55 } };

test('paper strategy adds only on strength, takes 30/30 percent, then trails the 40 percent runner', async () => {
  const id = await enter('flowinr', entrySignal);
  let p = store.openFor('flowinr', 'PAPER');
  assert.equal(p.invested, 300);
  assert.equal(p.strategy_stage, 'INITIAL');

  await managePosition(p, 99, continuation);
  p = store.openFor('flowinr', 'PAPER');
  assert.equal(p.invested, 300, 'a falling price must never add to the position');

  await managePosition(p, 101, continuation);
  p = store.openFor('flowinr', 'PAPER');
  assert.equal(p.invested, 500);
  assert.equal(p.strategy_stage, 'FULL');
  const originalQty = p.original_quantity;

  await managePosition(p, p.entry_price * 1.04, continuation);
  p = store.openFor('flowinr', 'PAPER');
  assert.equal(p.strategy_stage, 'FULL', 'a strong completed-candle trend should defer TP1');

  await managePosition(p, p.entry_price * 1.04, null);
  p = store.openFor('flowinr', 'PAPER');
  assert.equal(p.strategy_stage, 'TP1_DONE');
  assert.ok(Math.abs(p.tp1_sold_quantity - originalQty * 0.30) < 1e-8);
  assert.ok(p.basket_break_even > 0);

  await managePosition(p, p.entry_price * 1.07, continuation);
  p = store.openFor('flowinr', 'PAPER');
  assert.equal(p.strategy_stage, 'TP1_DONE', 'a strong completed-candle trend should defer TP2');

  await managePosition(p, p.entry_price * 1.07, null);
  p = store.openFor('flowinr', 'PAPER');
  assert.equal(p.strategy_stage, 'RUNNER');
  assert.ok(Math.abs(p.tp2_sold_quantity - originalQty * 0.30) < 1e-8);
  assert.ok(Math.abs(p.quantity - originalQty * 0.40) < 1e-8);

  const high = p.entry_price * 1.13;
  await managePosition(p, high, continuation);
  p = store.openFor('flowinr', 'PAPER');
  const trailing = high * 0.96;
  assert.ok(Math.abs(p.stop_price - Math.max(p.basket_break_even, trailing)) < 1e-8);
  await managePosition(p, trailing - 0.01, continuation);
  assert.equal(store.openFor('flowinr', 'PAPER'), undefined);
  const closed = store.recentPositions(20, 'PAPER').filter(x => x.symbol === 'flowinr');
  assert.equal(closed.some(x => x.exit_reason === 'TAKE_PROFIT_1'), true);
  assert.equal(closed.some(x => x.exit_reason === 'TAKE_PROFIT_2'), true);
  assert.equal(closed.some(x => x.exit_reason === 'STOP_OR_TRAILING_STOP'), true);
});

test('concurrent scanner/WebSocket triggers cannot submit the same TP1 twice', async () => {
  await enter('lockinr', { score: 80, price: 100, reasons: ['test'] });
  const staleSnapshot = store.openFor('lockinr', 'PAPER');
  await Promise.all([
    managePosition(staleSnapshot, 104, null),
    managePosition(staleSnapshot, 104, null)
  ]);
  const tp1Rows = store.recentPositions(50, 'PAPER').filter(x => x.symbol === 'lockinr' && x.exit_reason === 'TAKE_PROFIT_1');
  assert.equal(tp1Rows.length, 1);
  assert.equal(store.openFor('lockinr', 'PAPER').strategy_stage, 'TP1_DONE');
});

test('manual risk reset clears the breaker window without deleting today P&L', () => {
  const beforeToday = store.todayPnl('PAPER');
  store.resetRisk('PAPER');
  assert.equal(store.riskPnl('PAPER'), 0);
  assert.equal(store.consecutiveLosses('PAPER'), 0);
  assert.equal(store.todayPnl('PAPER'), beforeToday);

  const id = store.openPosition({ symbol: 'resetinr', mode: 'PAPER', entryPrice: 10, quantity: 10, invested: 100, stopPrice: 9.8, targetPrice: 10.4, score: 80, reason: 'test' });
  store.closePosition(id, 9.8, -2, 'STOP_OR_TRAILING_STOP');
  assert.equal(store.riskPnl('PAPER'), -2);
  assert.equal(store.consecutiveLosses('PAPER'), 1);
});
