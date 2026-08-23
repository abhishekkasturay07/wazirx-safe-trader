import { analyze } from '../strategy/strategy.js';

export function backtest(candles, options = {}) {
  const capital = options.capital ?? 2000, size = options.size ?? 400;
  const stopPct = (options.stopPercent ?? 2) / 100, targetPct = (options.targetPercent ?? 4) / 100;
  const trailingPct = (options.trailingStopPercent ?? 2) / 100, fee = (options.feePercent ?? 0.2) / 100;
  const minScore = options.minScore ?? 75;
  let balance = capital, position = null, peak = capital, maxDrawdown = 0;
  const trades = [];
  for (let i = 60; i < candles.length; i++) {
    const candle = candles[i];
    if (!position) {
      // Generate the signal from the completed previous candle and enter at the next open. Using the
      // same close for both signal generation and a guaranteed fill is an optimistic look-ahead fill.
      const marketBullish = typeof options.marketBullish === 'function' ? options.marketBullish(i - 1) : (options.marketBullish ?? true);
      const signal = analyze(candles.slice(0, i), marketBullish, minScore);
      if (signal.score >= minScore) {
        const invested = Math.min(size, balance), quantity = invested * (1 - fee) / candle.open;
        position = { entry: candle.open, invested, quantity, stop: candle.open * (1 - stopPct), target: candle.open * (1 + targetPct), high: candle.open, time: candle.time, score: signal.score };
      }
    }
    if (position) {
      // The previous high can tighten today's stop. We deliberately do not assume that today's high
      // happened before today's low because OHLC candles do not reveal intrabar ordering.
      const activeStop = Math.max(position.stop, position.high * (1 - trailingPct));
      const stopHit = candle.low <= activeStop, targetHit = candle.high >= position.target;
      if (stopHit || targetHit) {
        const exit = stopHit ? Math.min(candle.open, activeStop) : Math.max(candle.open, position.target);
        const pnl = position.quantity * exit * (1 - fee) - position.invested;
        balance += pnl; trades.push({ ...position, exit, pnl, reason: stopHit ? 'STOP' : 'TARGET' }); position = null;
        peak = Math.max(peak, balance); maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak * 100);
      } else {
        position.high = Math.max(position.high, candle.high);
      }
    }
  }
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((n, t) => n + t.pnl, 0), grossLoss = -losses.reduce((n, t) => n + t.pnl, 0);
  const openPositionValue = position && candles.length ? position.quantity * candles.at(-1).close * (1 - fee) : 0;
  const endingEquity = balance + (position ? openPositionValue - position.invested : 0);
  return { startingCapital: capital, endingCapital: balance, endingEquity, netPnl: endingEquity - capital, realizedPnl: balance - capital, openPosition: position, trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0, maxDrawdownPercent: maxDrawdown };
}
