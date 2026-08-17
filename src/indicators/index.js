export function ema(values, period) {
  if (values.length < period) return [];
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = Array(period - 1).fill(null).concat(seed);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0);
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(values) {
  const fast = ema(values, 12), slow = ema(values, 26);
  const line = values.map((_, i) => fast[i] == null || slow[i] == null ? null : fast[i] - slow[i]);
  const compact = line.filter(v => v != null);
  const compactSignal = ema(compact, 9);
  const signal = Array(values.length - compact.length).fill(null).concat(compactSignal);
  return { line, signal, histogram: line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]) };
}

export function atr(candles, period = 14) {
  const tr = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  return ema(tr, period);
}
