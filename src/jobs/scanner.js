import { config } from '../config.js';
import { wazirx } from '../api/wazirx.js';
import { analyze } from '../strategy/strategy.js';
import { store } from '../database/db.js';
import { enter, managePosition, riskStatus } from '../trading/engine.js';
import { reconcileLiveState } from '../trading/reconcile.js';
import { completedCandles, rankCandidates } from '../market/candles.js';

let running = false;
export async function scan() {
  if (running) return { skipped: true, reason: 'Scan already running' };
  running = true;
  const results = [];
  try {
    if (config.liveMode) await reconcileLiveState();
    const mode = config.liveMode ? 'LIVE' : 'PAPER';
    const btcCandles = await wazirx.candles('btcinr');
    const btcClosed = completedCandles(btcCandles, config.interval);
    const btc = analyze(btcClosed, true, config.minScore);
    const marketBullish = btc.indicators.ema20 > btc.indicators.ema50;
    const candidates = [];
    for (const symbol of config.symbols) {
      try {
        const candles = symbol === 'btcinr' ? btcCandles : await wazirx.candles(symbol);
        const closed = symbol === 'btcinr' ? btcClosed : completedCandles(candles, config.interval);
        const result = analyze(closed, marketBullish, config.minScore);
        store.signal(symbol, result);
        const position = store.openFor(symbol, mode);
        const currentPrice = candles.at(-1)?.close;
        if (position?.status === 'OPEN' && Number.isFinite(currentPrice)) await managePosition(position, currentPrice);
        else if (!position && riskStatus().allowed && result.score >= config.minScore) candidates.push({ symbol, signal: result });
        results.push({ symbol, ...result });
      } catch (error) {
        store.event('ERROR', `${symbol}: ${error.message}`);
        results.push({ symbol, error: error.message });
      }
    }
    for (const candidate of rankCandidates(candidates)) await enter(candidate.symbol, candidate.signal);
    return { results, risk: riskStatus() };
  } finally { running = false; }
}
