import { config } from '../config.js';
import { wazirx } from '../api/wazirx.js';
import { backtest } from '../backtest/backtest.js';

for (const symbol of config.symbols) {
  try {
    const candles = await wazirx.candles(symbol, config.interval, 2000);
    const result = backtest(candles, {
      capital: config.startingCapital, initialSize: config.initialPosition, addSize: config.addPosition,
      addTriggerPercent: config.addTriggerPercent, stopPercent: config.stopLossPercent,
      firstTakeProfitPercent: config.firstTakeProfitPercent, firstSellPercent: config.firstSellPercent,
      secondTakeProfitPercent: config.secondTakeProfitPercent, secondSellPercent: config.secondSellPercent,
      trailingStopPercent: config.trailingStopPercent, feePercent: config.feePercent, minScore: config.minScore
    });
    const { legs, ...summary } = result;
    console.log(symbol.toUpperCase(), summary);
  } catch (error) { console.error(symbol.toUpperCase(), error.message); }
}
