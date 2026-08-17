import { atr, ema, macd, rsi } from '../indicators/index.js';

const last = values => values[values.length - 1];
const average = values => values.reduce((a, b) => a + b, 0) / values.length;

export function analyze(candles, marketBullish = true) {
  if (candles.length < 60) throw new Error('At least 60 candles are required');
  const closes = candles.map(c => c.close), volumes = candles.map(c => c.volume);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), rsis = rsi(closes), m = macd(closes), atrs = atr(candles);
  const i = candles.length - 1;
  const checks = {
    emaTrend: ema20[i] > ema50[i],
    rsiMomentum: rsis[i] >= 40 && rsis[i] <= 65 && rsis[i] > rsis[i - 1],
    macdCross: m.histogram[i] > 0 && m.histogram[i - 1] <= 0,
    volume: volumes[i] > average(volumes.slice(-21, -1)) * 1.1,
    marketTrend: marketBullish
  };
  const weights = { emaTrend: 25, rsiMomentum: 20, macdCross: 20, volume: 20, marketTrend: 15 };
  const score = Object.entries(checks).reduce((sum, [key, ok]) => sum + (ok ? weights[key] : 0), 0);
  return {
    score, action: score >= 75 ? 'BUY' : 'WAIT', price: last(closes),
    indicators: { ema20: last(ema20), ema50: last(ema50), rsi: last(rsis), macdHistogram: last(m.histogram), atr: last(atrs) },
    reasons: Object.keys(checks).filter(key => checks[key]), checks
  };
}
