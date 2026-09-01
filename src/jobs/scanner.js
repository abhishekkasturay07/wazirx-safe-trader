import { config } from '../config.js';
import { wazirx } from '../api/wazirx.js';
import { analyze } from '../strategy/strategy.js';
import { store } from '../database/db.js';
import { enter, managePosition, riskStatus } from '../trading/engine.js';
import { reconcileLiveState } from '../trading/reconcile.js';
import { completedCandles, rankCandidates } from '../market/candles.js';

let running = false;

export function estimatedSellSlippagePercent(bids, quoteAmountInr) {
  if (!Array.isArray(bids) || bids.length === 0 || !Number.isFinite(quoteAmountInr) || quoteAmountInr <= 0) return Infinity;
  const bestBid = Number(bids[0]?.[0]);
  if (!Number.isFinite(bestBid) || bestBid <= 0) return Infinity;
  let remainingBase = quoteAmountInr / bestBid, proceeds = 0, soldBase = 0;
  for (const level of bids) {
    const price = Number(level?.[0]), availableBase = Number(level?.[1]);
    if (!Number.isFinite(price) || !Number.isFinite(availableBase) || price <= 0 || availableBase <= 0) continue;
    const filled = Math.min(remainingBase, availableBase);
    proceeds += filled * price;
    soldBase += filled;
    remainingBase -= filled;
    if (remainingBase <= 1e-12) break;
  }
  if (remainingBase > 1e-12 || soldBase <= 0) return Infinity;
  const averagePrice = proceeds / soldBase;
  return Math.max(0, (bestBid - averagePrice) / bestBid * 100);
}

export function liquidityCheck(ticker, depth = null, quoteAmountInr = config.initialPosition) {
  const bid = Number(ticker?.bidPrice), ask = Number(ticker?.askPrice), last = Number(ticker?.lastPrice), volume = Number(ticker?.volume);
  if (![bid, ask, last, volume].every(Number.isFinite) || bid <= 0 || ask < bid || last <= 0 || volume < 0) return { allowed: false, reason: 'invalid ticker liquidity data' };
  const mid = (bid + ask) / 2;
  const spreadPercent = (ask - bid) / mid * 100;
  const quoteVolumeInr = volume * last;
  if (spreadPercent > config.maxSpreadPercent) return { allowed: false, reason: `spread ${spreadPercent.toFixed(3)}% exceeds ${config.maxSpreadPercent}%`, spreadPercent, quoteVolumeInr };
  if (quoteVolumeInr < config.min24hQuoteVolumeInr) return { allowed: false, reason: `24h quote volume ₹${quoteVolumeInr.toFixed(0)} below ₹${config.min24hQuoteVolumeInr}`, spreadPercent, quoteVolumeInr };
  const estimatedSlippagePercent = estimatedSellSlippagePercent(depth?.bids, quoteAmountInr);
  if (estimatedSlippagePercent > config.maxEstimatedSlippagePercent) return { allowed: false, reason: `estimated sell slippage ${Number.isFinite(estimatedSlippagePercent) ? estimatedSlippagePercent.toFixed(3) + '%' : 'unavailable'} exceeds ${config.maxEstimatedSlippagePercent}%`, spreadPercent, quoteVolumeInr, estimatedSlippagePercent };
  return { allowed: true, spreadPercent, quoteVolumeInr, estimatedSlippagePercent };
}

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
    const symbols = await wazirx.inrMarkets();
    for (const symbol of symbols) {
      try {
        const candles = symbol === 'btcinr' ? btcCandles : await wazirx.candles(symbol);
        const closed = symbol === 'btcinr' ? btcClosed : completedCandles(candles, config.interval);
        const result = analyze(closed, marketBullish, config.minScore);
        store.signal(symbol, result);
        const position = store.openFor(symbol, mode);
        const currentPrice = candles.at(-1)?.close;
        if (position?.status === 'OPEN' && Number.isFinite(currentPrice)) await managePosition(position, currentPrice, result);
        else if (!position && riskStatus().allowed && result.score >= config.minScore) {
          const ticker = await wazirx.ticker(symbol);
          const depth = await wazirx.depth(symbol);
          const liquidity = liquidityCheck(ticker, depth);
          if (liquidity.allowed) candidates.push({ symbol, signal: result });
          else store.event('INFO', `${symbol}: entry skipped — ${liquidity.reason}`);
        }
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
