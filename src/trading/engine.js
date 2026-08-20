import { config } from '../config.js';
import { store } from '../database/db.js';
import { notify } from '../notifications/email.js';
import { wazirx } from '../api/wazirx.js';

const feeRate = config.feePercent / 100;
const round = (value, precision = 8) => Number(value.toFixed(precision));

export function riskStatus() {
  const dailyPnl = store.todayPnl(), consecutiveLosses = store.consecutiveLosses();
  const reason = dailyPnl <= -config.dailyLossLimit ? 'Daily loss limit reached'
    : consecutiveLosses >= config.maxConsecutiveLosses ? 'Consecutive loss limit reached' : null;
  return { allowed: !reason, reason, dailyPnl, consecutiveLosses };
}

export async function enter(symbol, signal) {
  const risk = riskStatus();
  if (!risk.allowed || signal.score < config.minScore || store.openFor(symbol) || store.openPositions().length >= config.maxOpenPositions) return null;
  let available = config.startingCapital + store.totalPnl() - store.openPositions().reduce((n, p) => n + p.invested, 0);
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
    const order = await wazirx.placeLimitOrder({ symbol, side: 'buy', quantity: rounded.quantity, price: rounded.price });
    const id = store.openPending({ symbol, mode: 'LIVE', entryPrice: rounded.price, quantity: rounded.quantity, invested, stopPrice, targetPrice, score: signal.score, reason: signal.reasons.join(', '), buyOrderId: order.id });
    await notify(`🟡 ${symbol.toUpperCase()} BUY submitted`, `Amount: ₹${invested}\nPrice: ₹${rounded.price}\nScore: ${signal.score}\nOrder: ${order.id}`);
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
    const order = await wazirx.placeLimitOrder({ symbol: position.symbol, side: 'sell', quantity: rounded.quantity, price: rounded.price });
    store.markPendingExit(position.id, order.id, reason);
    await notify(`🟡 ${position.symbol.toUpperCase()} SELL submitted`, `Trigger: ₹${rounded.price}\nReason: ${reason}\nOrder: ${order.id}`);
    return null;
  }
  const proceeds = position.quantity * price * (1 - feeRate);
  const pnl = proceeds - position.invested;
  store.closePosition(position.id, price, pnl, reason);
  await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} SOLD`, `Exit: ₹${price}\nNet P/L: ₹${pnl.toFixed(2)}\nReason: ${reason}`);
  return pnl;
}
