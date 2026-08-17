import { analyze } from '../strategy/strategy.js';

export function backtest(candles, options = {}) {
  const capital = options.capital ?? 2000, size = options.size ?? 400, stopPct = (options.stopPercent ?? 2) / 100, targetPct = (options.targetPercent ?? 4) / 100, fee = (options.feePercent ?? 0.2) / 100;
  let balance = capital, position = null, peak = capital, maxDrawdown = 0;
  const trades = [];
  for (let i = 60; i < candles.length; i++) {
    const candle = candles[i];
    if (position) {
      const stopHit = candle.low <= position.stop, targetHit = candle.high >= position.target;
      if (stopHit || targetHit) {
        const exit = stopHit ? position.stop : position.target; // conservative when both occur in one candle
        const pnl = position.quantity * exit * (1 - fee) - position.invested;
        balance += pnl; trades.push({ ...position, exit, pnl, reason: stopHit ? 'STOP' : 'TARGET' }); position = null;
        peak = Math.max(peak, balance); maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak * 100);
      }
    } else {
      const signal = analyze(candles.slice(0, i + 1), true);
      if (signal.score >= 75) {
        const invested = Math.min(size, balance), quantity = invested * (1 - fee) / candle.close;
        position = { entry: candle.close, invested, quantity, stop: candle.close * (1 - stopPct), target: candle.close * (1 + targetPct), time: candle.time };
      }
    }
  }
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((n, t) => n + t.pnl, 0), grossLoss = -losses.reduce((n, t) => n + t.pnl, 0);
  return { startingCapital: capital, endingCapital: balance, netPnl: balance - capital, trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0, maxDrawdownPercent: maxDrawdown };
}
