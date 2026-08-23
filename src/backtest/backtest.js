import { analyze } from '../strategy/strategy.js';

const continuationValid = signal => Boolean(
  signal.checks.emaTrend && signal.checks.marketTrend && signal.indicators.candleBullish &&
  signal.indicators.rsi >= 40 && signal.indicators.rsi <= 70
);

export function backtest(candles, options = {}) {
  const capital = options.capital ?? 2000;
  const initialSize = options.initialSize ?? 240, addSize = options.addSize ?? 160;
  const stopPct = (options.stopPercent ?? 2) / 100, addTrigger = (options.addTriggerPercent ?? 1) / 100;
  const tp1Pct = (options.firstTakeProfitPercent ?? 4) / 100, tp2Pct = (options.secondTakeProfitPercent ?? 7) / 100;
  const sell1Pct = (options.firstSellPercent ?? 30) / 100, sell2Pct = (options.secondSellPercent ?? 30) / 100;
  const trailingPct = (options.trailingStopPercent ?? 4) / 100, fee = (options.feePercent ?? 0.2) / 100;
  const minScore = options.minScore ?? 75;
  let balance = capital, position = null, peak = capital, maxDrawdown = 0;
  const legs = [], baskets = [];

  const recordLeg = (position, quantity, exit, reason) => {
    const invested = position.invested * (quantity / position.quantity);
    const proceeds = quantity * exit * (1 - fee);
    const pnl = proceeds - invested;
    balance += pnl;
    legs.push({ entry: position.entry, exit, quantity, invested, pnl, reason, time: position.time });
    position.quantity -= quantity;
    position.invested -= invested;
    position.realizedPnl += pnl;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak * 100);
  };

  for (let i = 60; i < candles.length; i++) {
    const candle = candles[i];
    const marketBullish = typeof options.marketBullish === 'function' ? options.marketBullish(i - 1) : (options.marketBullish ?? true);
    const signal = analyze(candles.slice(0, i), marketBullish, minScore);

    if (!position && signal.score >= minScore) {
      const invested = Math.min(initialSize, balance);
      const quantity = invested * (1 - fee) / candle.open;
      position = { entry: candle.open, quantity, originalQuantity: quantity, invested, stop: candle.open * (1 - stopPct), high: candle.open, stage: 'INITIAL', realizedPnl: 0, time: candle.time };
    }
    if (!position) continue;

    let activeStop = position.stop;
    if (['TP1_DONE', 'RUNNER'].includes(position.stage)) {
      const basketBreakEven = Math.max(0, position.invested - position.realizedPnl) / (position.quantity * (1 - fee));
      activeStop = Math.max(activeStop, basketBreakEven);
    }
    if (position.stage === 'RUNNER') activeStop = Math.max(activeStop, position.high * (1 - trailingPct));
    if (candle.low <= activeStop) {
      const exit = Math.min(candle.open, activeStop);
      recordLeg(position, position.quantity, exit, 'STOP_OR_TRAILING_STOP');
      baskets.push({ pnl: position.realizedPnl, time: position.time });
      position = null;
      continue;
    }

    if (position.stage === 'INITIAL' && candle.close >= position.entry * (1 + addTrigger) && continuationValid(signal)) {
      const addedInvested = Math.min(addSize, Math.max(0, balance - position.invested));
      if (addedInvested > 0) {
        const addedQuantity = addedInvested * (1 - fee) / candle.close;
        position.quantity += addedQuantity;
        position.invested += addedInvested;
        position.originalQuantity = position.quantity;
        position.entry = position.invested / position.quantity;
        position.stop = position.entry * (1 - stopPct);
        position.stage = 'FULL';
      }
      position.high = Math.max(position.high, candle.high);
      continue;
    }

    if (['INITIAL', 'FULL'].includes(position.stage) && candle.high >= position.entry * (1 + tp1Pct)) {
      recordLeg(position, Math.min(position.quantity, position.originalQuantity * sell1Pct), position.entry * (1 + tp1Pct), 'TAKE_PROFIT_1');
      position.stage = 'TP1_DONE';
      position.high = Math.max(position.high, candle.high);
      continue;
    }
    if (position.stage === 'TP1_DONE' && candle.high >= position.entry * (1 + tp2Pct)) {
      recordLeg(position, Math.min(position.quantity, position.originalQuantity * sell2Pct), position.entry * (1 + tp2Pct), 'TAKE_PROFIT_2');
      position.stage = 'RUNNER';
      position.high = Math.max(position.high, candle.high);
      continue;
    }
    position.high = Math.max(position.high, candle.high);
  }

  const lastClose = candles.at(-1)?.close;
  const openPositionValue = position && lastClose ? position.quantity * lastClose * (1 - fee) : 0;
  const endingEquity = balance + (position ? openPositionValue - position.invested : 0);
  const wins = legs.filter(t => t.pnl > 0), losses = legs.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((n, t) => n + t.pnl, 0), grossLoss = -losses.reduce((n, t) => n + t.pnl, 0);
  return {
    startingCapital: capital, endingCapital: balance, endingEquity, netPnl: endingEquity - capital,
    realizedPnl: balance - capital, openPosition: position, completedBaskets: baskets.length,
    exitLegs: legs.length, wins: wins.length, losses: losses.length,
    winRate: legs.length ? wins.length / legs.length * 100 : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    maxDrawdownPercent: maxDrawdown, legs
  };
}
