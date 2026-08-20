import 'dotenv/config';

const number = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

export const config = Object.freeze({
  liveMode: process.env.LIVE_MODE === 'true',
  liveConfirmation: process.env.LIVE_CONFIRMATION ?? '',
  apiKey: process.env.WAZIRX_API_KEY ?? '',
  secretKey: process.env.WAZIRX_SECRET_KEY ?? '',
  symbols: (process.env.SYMBOLS ?? 'btcinr,ethinr,xrpinr,solinr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  interval: process.env.CANDLE_INTERVAL ?? '15m',
  scanCron: process.env.SCAN_CRON ?? '*/15 * * * *',
  startingCapital: number('STARTING_CAPITAL_INR', 2000),
  maxPosition: number('MAX_POSITION_INR', 400),
  maxOpenPositions: number('MAX_OPEN_POSITIONS', 2),
  minScore: number('MIN_SIGNAL_SCORE', 75),
  stopLossPercent: number('STOP_LOSS_PERCENT', 2),
  targetPercent: number('TARGET_PERCENT', 4),
  trailingStopPercent: number('TRAILING_STOP_PERCENT', 2),
  dailyLossLimit: number('DAILY_LOSS_LIMIT_INR', 60),
  maxConsecutiveLosses: number('MAX_CONSECUTIVE_LOSSES', 3),
  feePercent: number('TRADING_FEE_PERCENT', 0.2),
  staleOrderMinutes: number('STALE_ORDER_MINUTES', 30),
  port: number('PORT', 3000),
  databasePath: process.env.DATABASE_PATH ?? './data/trader.db',
  email: {
    user: process.env.EMAIL_USER ?? '',
    password: process.env.EMAIL_APP_PASSWORD ?? '',
    to: process.env.EMAIL_TO ?? process.env.EMAIL_USER ?? ''
  }
});

export function assertSafeConfiguration() {
  if (config.maxPosition > config.startingCapital / 2) throw new Error('MAX_POSITION_INR cannot exceed 50% of starting capital');
  if (config.liveMode) {
    if (config.liveConfirmation !== 'I_UNDERSTAND_LIVE_TRADING_RISK') throw new Error('Live mode requires exact LIVE_CONFIRMATION');
    if (!config.apiKey || !config.secretKey) throw new Error('Live mode requires WazirX API credentials');
  }
}
