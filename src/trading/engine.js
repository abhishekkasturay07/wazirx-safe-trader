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
  const available = config.startingCapital + store.totalPnl() - store.openPositions().reduce((n, p) => n + p.invested, 0);
  const invested = Math.min(config.maxPosition, available);
  if (invested <= 0) return null;
  const quantity = round((invested * (1 - feeRate)) / signal.price);
  if (config.liveMode) await wazirx.placeLimitOrder({ symbol, side: 'buy', quantity, price: signal.price });
  const id = store.openPosition({ symbol, mode: config.liveMode ? 'LIVE' : 'PAPER', entryPrice: signal.price, quantity, invested, stopPrice: signal.price * (1 - config.stopLossPercent / 100), targetPrice: signal.price * (1 + config.targetPercent / 100), score: signal.score, reason: signal.reasons.join(', ') });
  await notify(`🟢 ${symbol.toUpperCase()} BUY ${config.liveMode ? 'submitted' : 'simulated'}`, `Amount: ₹${invested}\nPrice: ₹${signal.price}\nScore: ${signal.score}\nStop: ₹${signal.price * (1 - config.stopLossPercent / 100)}\nTarget: ₹${signal.price * (1 + config.targetPercent / 100)}`);
  return id;
}

export async function managePosition(position, price) {
  let high = Math.max(position.high_price, price);
  const trailing = high * (1 - config.trailingStopPercent / 100);
  const stop = Math.max(position.stop_price, trailing);
  store.updateProtection(position.id, high, stop);
  const reason = price <= stop ? 'STOP_OR_TRAILING_STOP' : price >= position.target_price ? 'TARGET' : null;
  if (!reason) return null;
  if (config.liveMode) await wazirx.placeLimitOrder({ symbol: position.symbol, side: 'sell', quantity: position.quantity, price });
  const proceeds = position.quantity * price * (1 - feeRate);
  const pnl = proceeds - position.invested;
  store.closePosition(position.id, price, pnl, reason);
  await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} SOLD`, `Exit: ₹${price}\nNet P/L: ₹${pnl.toFixed(2)}\nReason: ${reason}`);
  return pnl;
}
