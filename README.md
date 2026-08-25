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

Use a dedicated API key with **Read + SPOT only**, trusted-IP restriction, and no withdrawal/futures/transfer permission. Dashboard/API authentication is optional: setting `DASHBOARD_PASSWORD` to at least 16 characters enables HTTP Basic authentication; leaving it blank keeps the dashboard public. Submitted limit orders may remain open or partially fill, so the bot reconciles pending orders against exchange fills.

Entry indicators use only completed candles. Open positions are still checked against the latest available price on every scan. When several symbols qualify, candidates are ranked by signal score and then relative volume before the available position slots are filled.

Set `TRADING_FEE_PERCENT` from the fee actually present in your WazirX fills or account plan; it is not necessarily the example value.

## Staged position flow

The staged strategy is configurable through `INITIAL_POSITION_INR`, `ADD_POSITION_INR`, `ADD_TRIGGER_PERCENT`, `FIRST_TAKE_PROFIT_PERCENT`, `FIRST_SELL_PERCENT`, `SECOND_TAKE_PROFIT_PERCENT`, and `SECOND_SELL_PERCENT`. The add-on is allowed only after price strength plus completed-candle trend confirmation; falling positions are never averaged down. Partial-fill progress and the `INITIAL` / `FULL` / `TP1_DONE` / `RUNNER` stage are persisted in SQLite.

New entries are paused by default with `PAUSE_NEW_ENTRIES=true`; open positions continue to receive stop and exit management. Before an entry is admitted, `LIQUID_SYMBOLS`, `MAX_SPREAD_PERCENT`, `MIN_24H_QUOTE_VOLUME_INR`, and `MAX_ESTIMATED_SLIPPAGE_PERCENT` screen the pair using the live ticker and order-book bids. Position size is additionally capped by `MAX_RISK_PER_TRADE_PERCENT`.

Open positions are monitored from WazirX's public `!ticker@arr` WebSocket. Last trade prices update the trailing high while best bids are used as the executable trigger price. Updates are serialized per position to prevent scanner/WebSocket duplicate orders. A stale socket reconnects with exponential backoff and polls REST tickers as a fallback. Entry signals remain on completed candles.

## What V1 enforces

- ₹400 maximum position and two open positions by default
- 2% initial/trailing stop, 4% target, ₹60 daily kill switch
- pause after three consecutive losses
- fees included in paper P/L and backtest (configure the actual current rate)
- BTC market filter plus EMA, RSI, MACD crossover and volume score
- completed-candle entries and score-ranked candidate selection
- staged positions: 60% initial entry, strength-only add, 30%/30% partial profits, and a 40% trailing runner (all configurable)
- password-protected dashboard/API in live mode
- local SQLite database and optional Gmail app-password notifications

This software is not investment advice and cannot promise profit. Backtests and paper results do not predict future returns. Indian tax and exchange charges must be handled separately.
