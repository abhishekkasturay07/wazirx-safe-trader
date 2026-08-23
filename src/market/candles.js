const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function intervalMilliseconds(interval) {
  const match = /^(\d+)([mhdw])$/.exec(interval);
  if (!match) throw new Error(`Unsupported candle interval: ${interval}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

// WazirX REST klines include the candle that is still forming. Indicators must only use candles
// whose full interval has elapsed, otherwise results depend on how many seconds after cron they ran.
export function completedCandles(candles, interval, now = Date.now()) {
  const duration = intervalMilliseconds(interval);
  return candles.filter(candle => candle.time + duration <= now);
}

export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) =>
    b.signal.score - a.signal.score ||
    (b.signal.indicators.volumeRatio ?? -Infinity) - (a.signal.indicators.volumeRatio ?? -Infinity) ||
    a.symbol.localeCompare(b.symbol)
  );
}
