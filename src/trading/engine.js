import { config } from '../config.js';
import { store } from '../database/db.js';
import { notify } from '../notifications/email.js';
import { wazirx } from '../api/wazirx.js';
import { intervalMilliseconds } from '../market/candles.js';

const feeRate = config.feePercent / 100;
const round = (value, precision = 8) => Number(value.toFixed(precision));
const newClientOrderId = () => `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const currentMode = () => config.liveMode ? 'LIVE' : 'PAPER';
const targetPrice = (entry, percent) => entry * (1 + percent / 100);
const positionLocks = new Map();

async function availableCapital(mode) {
  let available = config.startingCapital + store.totalPnl(mode) - store.activePositions(mode).reduce((n, p) => n + p.invested, 0);
  if (config.liveMode) {
    const funds = await wazirx.funds();
    const inrFree = Number(funds.find(f => f.asset === 'inr')?.free ?? 0);
    available = Math.min(available, inrFree);
  }
  return available;
}

// The DB row is written before the order is submitted, so a crash/DB failure never leaves a real
// exchange order untracked — worst case is a local PENDING row with no matching order, which
// reconcilePending() resolves once it can confirm what actually happened.
//
// A submission failure is either definitive (the exchange responded and rejected it — err.definitive
// is set by wazirx.js's request()) or ambiguous (network/timeout — we never got a response, so the
// order may or may not exist). Only a definitive rejection is safe to unwind immediately; an
// ambiguous one must stay PENDING so reconcilePending() can keep retrying the clientOrderId lookup
// on later scans instead of us guessing and potentially cancelling a row backing a real order.
async function submitOrder({ id, side, symbol, quantity, price, clientOrderId }) {
  try {
    const order = await wazirx.placeLimitOrder({ symbol, side, quantity, price, clientOrderId });
    store.attachOrderId(id, side, order.id);
    return { orderId: order.id, ambiguous: false };
  } catch (err) {
    const found = await wazirx.orderStatus(symbol, undefined, clientOrderId).catch(() => null);
    if (found?.id) { store.attachOrderId(id, side, found.id); return { orderId: found.id, ambiguous: false }; }
    if (err.definitive) throw err;
    store.event('ERROR', `${symbol}: order submission ambiguous (${err.message}) — left pending, will retry resolving it via clientOrderId`);
    return { orderId: null, ambiguous: true };
  }
}

export function riskStatus() {
  const mode = currentMode();
  const dailyPnl = store.todayPnl(mode), consecutiveLosses = store.consecutiveLosses(mode);
  const reason = dailyPnl <= -config.dailyLossLimit ? 'Daily loss limit reached'
    : consecutiveLosses >= config.maxConsecutiveLosses ? 'Consecutive loss limit reached' : null;
  return { allowed: !reason, reason, dailyPnl, consecutiveLosses };
}

export async function enter(symbol, signal) {
  const mode = currentMode();
  const risk = riskStatus();
  const cooldownSince = new Date(Date.now() - config.cooldownCandles * intervalMilliseconds(config.interval)).toISOString();
  if (!risk.allowed || signal.score < config.minScore || store.openFor(symbol, mode) || store.activePositions(mode).length >= config.maxOpenPositions || store.inCooldown(symbol, mode, cooldownSince)) return null;
  const available = await availableCapital(mode);
  const invested = Math.min(config.initialPosition, available);
  if (invested <= 0) return null;
  const quantity = round((invested * (1 - feeRate)) / signal.price);
  const stopPrice = signal.price * (1 - config.stopLossPercent / 100);
  const firstTargetPrice = targetPrice(signal.price, config.firstTakeProfitPercent);
  if (config.liveMode) {
    const rounded = await wazirx.roundForSymbol(symbol, signal.price, quantity);
    const clientOrderId = newClientOrderId();
    const id = store.openPending({ symbol, mode: 'LIVE', entryPrice: rounded.price, quantity: rounded.quantity, invested, stopPrice, targetPrice: firstTargetPrice, score: signal.score, reason: signal.reasons.join(', '), clientOrderId });
    let result;
    try {
      result = await submitOrder({ id, side: 'buy', symbol, quantity: rounded.quantity, price: rounded.price, clientOrderId });
    } catch (err) {
      store.cancelEntry(id);
      throw err;
    }
    await notify(result.ambiguous ? `⚠️ ${symbol.toUpperCase()} BUY submission unconfirmed` : `🟡 ${symbol.toUpperCase()} BUY submitted`,
      `Amount: ₹${invested}\nPrice: ₹${rounded.price}\nScore: ${signal.score}\nOrder: ${result.orderId ?? 'unknown — will resolve on reconciliation'}`);
    return id;
  }
  const id = store.openPosition({ symbol, mode: 'PAPER', entryPrice: signal.price, quantity, invested, stopPrice, targetPrice: firstTargetPrice, score: signal.score, reason: signal.reasons.join(', ') });
  await notify(`🟢 ${symbol.toUpperCase()} BUY simulated`, `Initial amount: ₹${invested}\nPrice: ₹${signal.price}\nScore: ${signal.score}\nStop: ₹${stopPrice}\nFirst target: ₹${firstTargetPrice}`);
  return id;
}

function continuationValid(signal) {
  return Boolean(signal?.checks?.emaTrend && signal?.checks?.marketTrend && signal?.indicators?.candleBullish && signal.indicators.rsi >= 40 && signal.indicators.rsi <= 70);
}

async function addToPosition(position, price) {
  const mode = currentMode();
  const remainingCapacity = Math.max(0, config.maxPosition - position.invested);
  const invested = Math.min(config.addPosition, remainingCapacity, await availableCapital(mode));
  if (invested <= 0) return null;
  const quantity = round((invested * (1 - feeRate)) / price);
  if (config.liveMode) {
    const rounded = await wazirx.roundForSymbol(position.symbol, price, quantity);
    const clientOrderId = newClientOrderId();
    store.markPendingAdd(position.id, clientOrderId);
    try {
      const result = await submitOrder({ id: position.id, side: 'buy', symbol: position.symbol, quantity: rounded.quantity, price: rounded.price, clientOrderId });
      await notify(result.ambiguous ? `⚠️ ${position.symbol.toUpperCase()} ADD submission unconfirmed` : `🟡 ${position.symbol.toUpperCase()} ADD submitted`, `Amount: ₹${invested}\nPrice: ₹${rounded.price}`);
    } catch (err) { store.revertAdd(position.id); throw err; }
    return 'ADD_PENDING';
  }
  const totalQuantity = position.quantity + quantity, totalInvested = position.invested + invested;
  const entryPrice = totalInvested / totalQuantity;
  store.confirmAdd(position.id, { addedQuantity: quantity, addedInvested: invested, entryPrice, totalQuantity, totalInvested, stopPrice: entryPrice * (1 - config.stopLossPercent / 100), targetPrice: targetPrice(entryPrice, config.firstTakeProfitPercent) });
  await notify(`🟢 ${position.symbol.toUpperCase()} ADD simulated`, `Added: ₹${invested}\nNew average: ₹${entryPrice}`);
  return 'ADDED';
}

async function exitQuantity(position, price, quantity, reason, nextStage = null) {
  if (quantity <= 0) return null;
  if (config.liveMode) {
    const rounded = await wazirx.roundForSymbol(position.symbol, price, quantity);
    if (rounded.quantity <= 0) return null;
    const clientOrderId = newClientOrderId();
    store.markPendingExit(position.id, reason, clientOrderId);
    let result;
    try {
      result = await submitOrder({ id: position.id, side: 'sell', symbol: position.symbol, quantity: rounded.quantity, price: rounded.price, clientOrderId });
    } catch (err) {
      store.revertToOpen(position.id);
      throw err;
    }
    await notify(result.ambiguous ? `⚠️ ${position.symbol.toUpperCase()} SELL submission unconfirmed` : `🟡 ${position.symbol.toUpperCase()} SELL submitted`,
      `Trigger: ₹${rounded.price}\nQuantity: ${rounded.quantity}\nReason: ${reason}\nOrder: ${result.orderId ?? 'unknown — will resolve on reconciliation'}`);
    return 'EXIT_PENDING';
  }
  const soldInvested = position.invested * (quantity / position.quantity);
  const proceeds = quantity * price * (1 - feeRate);
  const pnl = proceeds - soldInvested;
  if (quantity >= position.quantity - 1e-8) store.closePosition(position.id, price, pnl, reason);
  else store.confirmPartialExit(position, { soldQty: quantity, soldInvested, exitPrice: price, pnl, reason, nextStage });
  await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} SOLD`, `Exit: ₹${price}\nNet P/L: ₹${pnl.toFixed(2)}\nReason: ${reason}`);
  return pnl;
}

async function manageFreshPosition(position, price, signal = null, observedHigh = price) {
  const stage = position.strategy_stage ?? 'INITIAL';
  const high = Math.max(position.high_price, observedHigh);
  let stop = position.stop_price;
  if (['TP1_DONE', 'RUNNER'].includes(stage) && position.basket_break_even) stop = Math.max(stop, position.basket_break_even);
  if (stage === 'RUNNER') stop = Math.max(stop, high * (1 - config.trailingStopPercent / 100));
  store.updateProtection(position.id, high, stop);

  if (price <= stop) return exitQuantity(position, price, position.quantity, 'STOP_OR_TRAILING_STOP');
  const heldHours = (Date.now() - new Date(position.opened_at).getTime()) / 3_600_000;
  if (heldHours >= config.maxHoldingHours && signal && !continuationValid(signal)) return exitQuantity(position, price, position.quantity, 'TIME_EXIT');

  if (stage === 'INITIAL' && price >= position.entry_price * (1 + config.addTriggerPercent / 100) && continuationValid(signal)) return addToPosition(position, price);

  const originalQuantity = position.original_quantity ?? position.quantity;
  // At profit targets, keep holding while the latest completed candle still confirms a healthy
  // uptrend. Protective stops remain price-driven and are intentionally never deferred.
  if (['INITIAL', 'FULL'].includes(stage) && price >= targetPrice(position.entry_price, config.firstTakeProfitPercent) && !continuationValid(signal)) {
    const desired = originalQuantity * config.firstSellPercent / 100 - Number(position.tp1_sold_quantity ?? 0);
    return exitQuantity(position, price, Math.min(position.quantity, desired), 'TAKE_PROFIT_1', 'TP1_DONE');
  }
  if (stage === 'TP1_DONE' && price >= targetPrice(position.entry_price, config.secondTakeProfitPercent) && !continuationValid(signal)) {
    const desired = originalQuantity * config.secondSellPercent / 100 - Number(position.tp2_sold_quantity ?? 0);
    return exitQuantity(position, price, Math.min(position.quantity, desired), 'TAKE_PROFIT_2', 'RUNNER');
  }
  return null;
}

// Scanner and WebSocket updates can arrive together. Serialize by position id and always reload the
// database row inside the lock so an already-pending order can never be submitted a second time.
export async function managePosition(position, price, signal = null, observedHigh = price) {
  if (!position?.id || !Number.isFinite(price) || !Number.isFinite(observedHigh)) return null;
  const previous = positionLocks.get(position.id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const fresh = store.position(position.id);
    if (!fresh || fresh.status !== 'OPEN') return null;
    return manageFreshPosition(fresh, price, signal, observedHigh);
  });
  positionLocks.set(position.id, run);
  try { return await run; }
  finally { if (positionLocks.get(position.id) === run) positionLocks.delete(position.id); }
}
