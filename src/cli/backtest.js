import { config } from '../config.js';
import { wazirx } from '../api/wazirx.js';
import { backtest } from '../backtest/backtest.js';

for (const symbol of config.symbols) {
  try {
    const candles = await wazirx.candles(symbol, config.interval, 2000);
    console.log(symbol.toUpperCase(), backtest(candles, { capital: config.startingCapital, size: config.maxPosition, stopPercent: config.stopLossPercent, targetPercent: config.targetPercent, feePercent: config.feePercent }));
  } catch (error) { console.error(symbol.toUpperCase(), error.message); }
}
