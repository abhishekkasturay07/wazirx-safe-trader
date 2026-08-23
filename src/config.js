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
  dashboardUser: process.env.DASHBOARD_USER ?? 'trader',
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
  email: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.EMAIL_ENABLED !== 'false',
    user: process.env.EMAIL_USER ?? '',
    password: process.env.EMAIL_APP_PASSWORD ?? '',
    to: process.env.EMAIL_TO ?? process.env.EMAIL_USER ?? ''
  }
});

export function assertSafeConfiguration() {
  if (config.startingCapital <= 0) throw new Error('STARTING_CAPITAL_INR must be greater than zero');
  if (config.maxPosition <= 0) throw new Error('MAX_POSITION_INR must be greater than zero');
  if (!Number.isInteger(config.maxOpenPositions) || config.maxOpenPositions <= 0) throw new Error('MAX_OPEN_POSITIONS must be a positive integer');
  if (config.maxPosition > config.startingCapital / 2) throw new Error('MAX_POSITION_INR cannot exceed 50% of starting capital');
  if (config.maxPosition * config.maxOpenPositions > config.startingCapital) throw new Error('Maximum total position allocation cannot exceed starting capital');
  if (config.minScore < 0 || config.minScore > 100) throw new Error('MIN_SIGNAL_SCORE must be between 0 and 100');
  for (const [name, value] of Object.entries({ STOP_LOSS_PERCENT: config.stopLossPercent, TARGET_PERCENT: config.targetPercent, TRAILING_STOP_PERCENT: config.trailingStopPercent })) {
    if (value <= 0 || value >= 100) throw new Error(`${name} must be greater than 0 and less than 100`);
  }
  if (config.dailyLossLimit <= 0) throw new Error('DAILY_LOSS_LIMIT_INR must be greater than zero');
  if (!Number.isInteger(config.maxConsecutiveLosses) || config.maxConsecutiveLosses <= 0) throw new Error('MAX_CONSECUTIVE_LOSSES must be a positive integer');
  if (config.feePercent < 0 || config.feePercent >= 100) throw new Error('TRADING_FEE_PERCENT must be at least 0 and less than 100');
  if (!/^\d+[mhdw]$/.test(config.interval)) throw new Error('CANDLE_INTERVAL must look like 15m, 1h, 1d, or 1w');
  if (config.liveMode) {
    if (config.liveConfirmation !== 'I_UNDERSTAND_LIVE_TRADING_RISK') throw new Error('Live mode requires exact LIVE_CONFIRMATION');
    if (!config.apiKey || !config.secretKey) throw new Error('Live mode requires WazirX API credentials');
  }
  if (config.dashboardPassword && config.dashboardPassword.length < 16) throw new Error('DASHBOARD_PASSWORD must be blank or at least 16 characters');
}
