import { config } from '../config.js';
import { wazirx } from '../api/wazirx.js';
import { analyze } from '../strategy/strategy.js';
import { store } from '../database/db.js';
import { enter, managePosition, riskStatus } from '../trading/engine.js';

let running = false;
export async function scan() {
  if (running) return { skipped: true, reason: 'Scan already running' };
  running = true;
  const results = [];
  try {
    const btcCandles = await wazirx.candles('btcinr');
    const btc = analyze(btcCandles, true);
    const marketBullish = btc.indicators.ema20 > btc.indicators.ema50;
    for (const symbol of config.symbols) {
      try {
        const candles = symbol === 'btcinr' ? btcCandles : await wazirx.candles(symbol);
        const result = analyze(candles, marketBullish);
        store.signal(symbol, result);
        const position = store.openFor(symbol);
        if (position) await managePosition(position, result.price);
        else if (riskStatus().allowed) await enter(symbol, result);
        results.push({ symbol, ...result });
      } catch (error) {
        store.event('ERROR', `${symbol}: ${error.message}`);
        results.push({ symbol, error: error.message });
      }
    }
    return { results, risk: riskStatus() };
  } finally { running = false; }
}
