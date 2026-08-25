import 'dotenv/config';

const number = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

export const config = Object.freeze({
  liveMode: process.env.LIVE_MODE === 'true',
  pauseNewEntries: process.env.PAUSE_NEW_ENTRIES !== 'false',
  liveConfirmation: process.env.LIVE_CONFIRMATION ?? '',
  apiKey: process.env.WAZIRX_API_KEY ?? '',
  secretKey: process.env.WAZIRX_SECRET_KEY ?? '',
  symbols: (process.env.SYMBOLS ?? 'btcinr,ethinr,xrpinr,solinr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  liquidSymbols: (process.env.LIQUID_SYMBOLS ?? 'btcinr,ethinr,xrpinr,solinr,usdtinr,shibinr,wrxinr,trxinr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  interval: process.env.CANDLE_INTERVAL ?? '15m',
  scanCron: process.env.SCAN_CRON ?? '*/15 * * * *',
  startingCapital: number('STARTING_CAPITAL_INR', 2000),
  maxPosition: number('MAX_POSITION_INR', 400),
  initialPosition: number('INITIAL_POSITION_INR', 240),
  addPosition: number('ADD_POSITION_INR', 160),
  addTriggerPercent: number('ADD_TRIGGER_PERCENT', 1),
  maxOpenPositions: number('MAX_OPEN_POSITIONS', 2),
  maxRiskPerTradePercent: number('MAX_RISK_PER_TRADE_PERCENT', 0.5),
  maxSpreadPercent: number('MAX_SPREAD_PERCENT', 0.3),
  maxEstimatedSlippagePercent: number('MAX_ESTIMATED_SLIPPAGE_PERCENT', 0.25),
  min24hQuoteVolumeInr: number('MIN_24H_QUOTE_VOLUME_INR', 10_000_000),
  minScore: number('MIN_SIGNAL_SCORE', 75),
  stopLossPercent: number('STOP_LOSS_PERCENT', 2),
  trailingStopPercent: number('TRAILING_STOP_PERCENT', 2),
  firstTakeProfitPercent: number('FIRST_TAKE_PROFIT_PERCENT', 4),
  firstSellPercent: number('FIRST_SELL_PERCENT', 30),
  secondTakeProfitPercent: number('SECOND_TAKE_PROFIT_PERCENT', 7),
  secondSellPercent: number('SECOND_SELL_PERCENT', 30),
  cooldownCandles: number('COOLDOWN_CANDLES', 4),
  maxHoldingHours: number('MAX_HOLDING_HOURS', 48),
  websocketEnabled: process.env.WEBSOCKET_ENABLED !== 'false',
  websocketStaleSeconds: number('WEBSOCKET_STALE_SECONDS', 20),
  websocketReconnectMaxSeconds: number('WEBSOCKET_RECONNECT_MAX_SECONDS', 30),
  priceTriggerCooldownMs: number('PRICE_TRIGGER_COOLDOWN_MS', 5000),
  dailyLossLimit: number('DAILY_LOSS_LIMIT_INR', 60),
  dailyLossPercent: number('DAILY_LOSS_PERCENT', 1),
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
  if (config.initialPosition <= 0 || config.addPosition < 0 || config.initialPosition + config.addPosition > config.maxPosition) throw new Error('INITIAL_POSITION_INR + ADD_POSITION_INR must be positive and cannot exceed MAX_POSITION_INR');
  if (!Number.isInteger(config.maxOpenPositions) || config.maxOpenPositions <= 0) throw new Error('MAX_OPEN_POSITIONS must be a positive integer');
  if (config.maxRiskPerTradePercent <= 0 || config.maxRiskPerTradePercent > 5) throw new Error('MAX_RISK_PER_TRADE_PERCENT must be greater than 0 and at most 5');
  if (config.maxSpreadPercent <= 0 || config.maxSpreadPercent > 10) throw new Error('MAX_SPREAD_PERCENT must be greater than 0 and at most 10');
  if (config.maxEstimatedSlippagePercent <= 0 || config.maxEstimatedSlippagePercent > 10) throw new Error('MAX_ESTIMATED_SLIPPAGE_PERCENT must be greater than 0 and at most 10');
  if (config.min24hQuoteVolumeInr < 0) throw new Error('MIN_24H_QUOTE_VOLUME_INR cannot be negative');
  if (config.maxPosition > config.startingCapital / 2) throw new Error('MAX_POSITION_INR cannot exceed 50% of starting capital');
  if (config.maxPosition * config.maxOpenPositions > config.startingCapital) throw new Error('Maximum total position allocation cannot exceed starting capital');
  if (config.minScore < 0 || config.minScore > 100) throw new Error('MIN_SIGNAL_SCORE must be between 0 and 100');
  for (const [name, value] of Object.entries({ STOP_LOSS_PERCENT: config.stopLossPercent, TRAILING_STOP_PERCENT: config.trailingStopPercent })) {
    if (value <= 0 || value >= 100) throw new Error(`${name} must be greater than 0 and less than 100`);
  }
  if (config.addTriggerPercent <= 0) throw new Error('ADD_TRIGGER_PERCENT must be greater than zero');
  if (config.firstTakeProfitPercent <= 0 || config.secondTakeProfitPercent <= config.firstTakeProfitPercent) throw new Error('SECOND_TAKE_PROFIT_PERCENT must be greater than FIRST_TAKE_PROFIT_PERCENT');
  if (config.firstSellPercent <= 0 || config.secondSellPercent <= 0 || config.firstSellPercent + config.secondSellPercent >= 100) throw new Error('Partial sell percentages must be positive and leave a runner');
  if (!Number.isInteger(config.cooldownCandles) || config.cooldownCandles < 0) throw new Error('COOLDOWN_CANDLES must be a non-negative integer');
  if (config.maxHoldingHours <= 0) throw new Error('MAX_HOLDING_HOURS must be greater than zero');
  if (config.websocketStaleSeconds < 10) throw new Error('WEBSOCKET_STALE_SECONDS must be at least 10');
  if (config.websocketReconnectMaxSeconds < 1) throw new Error('WEBSOCKET_RECONNECT_MAX_SECONDS must be at least 1');
  if (config.priceTriggerCooldownMs < 1000) throw new Error('PRICE_TRIGGER_COOLDOWN_MS must be at least 1000');
  if (config.dailyLossLimit <= 0) throw new Error('DAILY_LOSS_LIMIT_INR must be greater than zero');
  if (config.dailyLossPercent <= 0 || config.dailyLossPercent > 20) throw new Error('DAILY_LOSS_PERCENT must be greater than 0 and at most 20');
  if (!Number.isInteger(config.maxConsecutiveLosses) || config.maxConsecutiveLosses <= 0) throw new Error('MAX_CONSECUTIVE_LOSSES must be a positive integer');
  if (config.feePercent < 0 || config.feePercent >= 100) throw new Error('TRADING_FEE_PERCENT must be at least 0 and less than 100');
  if (!/^\d+[mhdw]$/.test(config.interval)) throw new Error('CANDLE_INTERVAL must look like 15m, 1h, 1d, or 1w');
  if (config.liveMode) {
    if (config.liveConfirmation !== 'I_UNDERSTAND_LIVE_TRADING_RISK') throw new Error('Live mode requires exact LIVE_CONFIRMATION');
    if (!config.apiKey || !config.secretKey) throw new Error('Live mode requires WazirX API credentials');
  }
  if (config.dashboardPassword && config.dashboardPassword.length < 16) throw new Error('DASHBOARD_PASSWORD must be blank or at least 16 characters');
}
