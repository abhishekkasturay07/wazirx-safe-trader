# WazirX Safe Trader

Rule-based spot trading bot with a ₹2,000 paper wallet, local indicators, SQLite storage, backtesting, email notifications and a small dashboard. It starts in **paper mode** and does not need API keys for market data.

## Start

```bash
npm install
cp .env.example .env
npm test
npm run backtest
npm start
```

Open `http://localhost:3000`, then press **Scan now**. The scheduled scanner runs every 15 minutes while the server is running.

## Safety and live mode

Keep `LIVE_MODE=false` until paper results have been reviewed over a meaningful sample. Live mode requires all three values:

```env
LIVE_MODE=true
LIVE_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING_RISK
WAZIRX_API_KEY=...
WAZIRX_SECRET_KEY=...
```

Use a dedicated API key with **Read + SPOT only**, trusted-IP restriction, and no withdrawal/futures/transfer permission. Spot orders are limit orders because that is what the documented spot endpoint supports. A submitted limit order may remain open or partially fill; production use should add order-status reconciliation before enabling live mode.

## What V1 enforces

- ₹400 maximum position and two open positions by default
- 2% initial/trailing stop, 4% target, ₹60 daily kill switch
- pause after three consecutive losses
- fees included in paper P/L and backtest (configure the actual current rate)
- BTC market filter plus EMA, RSI, MACD crossover and volume score
- local SQLite database and optional Gmail app-password notifications

This software is not investment advice and cannot promise profit. Backtests and paper results do not predict future returns. Indian tax and exchange charges must be handled separately.
