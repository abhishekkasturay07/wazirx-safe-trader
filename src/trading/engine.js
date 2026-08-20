import { config } from '../config.js';
import { store } from '../database/db.js';
import { notify } from '../notifications/email.js';
import { wazirx } from '../api/wazirx.js';

const feeRate = config.feePercent / 100;
const round = (value, precision = 8) => Number(value.toFixed(precision));
const newClientOrderId = () => `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const currentMode = () => config.liveMode ? 'LIVE' : 'PAPER';

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
  if (!risk.allowed || signal.score < config.minScore || store.openFor(symbol, mode) || store.activePositions(mode).length >= config.maxOpenPositions) return null;
  let available = config.startingCapital + store.totalPnl(mode) - store.activePositions(mode).reduce((n, p) => n + p.invested, 0);
  if (config.liveMode) {
    const funds = await wazirx.funds();
    const inrFree = Number(funds.find(f => f.asset === 'inr')?.free ?? 0);
    available = Math.min(available, inrFree);
  }
  const invested = Math.min(config.maxPosition, available);
  if (invested <= 0) return null;
  const quantity = round((invested * (1 - feeRate)) / signal.price);
  const stopPrice = signal.price * (1 - config.stopLossPercent / 100);
  const targetPrice = signal.price * (1 + config.targetPercent / 100);
  if (config.liveMode) {
    const rounded = await wazirx.roundForSymbol(symbol, signal.price, quantity);
    const clientOrderId = newClientOrderId();
    const id = store.openPending({ symbol, mode: 'LIVE', entryPrice: rounded.price, quantity: rounded.quantity, invested, stopPrice, targetPrice, score: signal.score, reason: signal.reasons.join(', '), clientOrderId });
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
  const id = store.openPosition({ symbol, mode: 'PAPER', entryPrice: signal.price, quantity, invested, stopPrice, targetPrice, score: signal.score, reason: signal.reasons.join(', ') });
  await notify(`🟢 ${symbol.toUpperCase()} BUY simulated`, `Amount: ₹${invested}\nPrice: ₹${signal.price}\nScore: ${signal.score}\nStop: ₹${stopPrice}\nTarget: ₹${targetPrice}`);
  return id;
}

export async function managePosition(position, price) {
  let high = Math.max(position.high_price, price);
  const trailing = high * (1 - config.trailingStopPercent / 100);
  const stop = Math.max(position.stop_price, trailing);
  store.updateProtection(position.id, high, stop);
  const reason = price <= stop ? 'STOP_OR_TRAILING_STOP' : price >= position.target_price ? 'TARGET' : null;
  if (!reason) return null;
  if (config.liveMode) {
    const rounded = await wazirx.roundForSymbol(position.symbol, price, position.quantity);
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
      `Trigger: ₹${rounded.price}\nReason: ${reason}\nOrder: ${result.orderId ?? 'unknown — will resolve on reconciliation'}`);
    return null;
  }
  const proceeds = position.quantity * price * (1 - feeRate);
  const pnl = proceeds - position.invested;
  store.closePosition(position.id, price, pnl, reason);
  await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} SOLD`, `Exit: ₹${price}\nNet P/L: ₹${pnl.toFixed(2)}\nReason: ${reason}`);
  return pnl;
}
