import WebSocket from 'ws';
import { config } from '../config.js';
import { store } from '../database/db.js';
import { managePosition } from '../trading/engine.js';
import { wazirx } from '../api/wazirx.js';
import { intervalMilliseconds } from '../market/candles.js';

const URL = 'wss://stream.wazirx.com/stream';
const STREAM = '!ticker@arr';
let started = false;

export function tickerUpdates(payload) {
  if (payload?.stream !== STREAM || !Array.isArray(payload.data)) return [];
  return payload.data.map(row => ({
    symbol: String(row.s ?? '').toLowerCase(),
    eventTime: Number(row.E),
    last: Number(row.c),
    bid: Number(row.b)
  })).filter(row => row.symbol && Number.isFinite(row.last) && row.last > 0);
}

export function startPriceMonitor() {
  if (started || !config.websocketEnabled) return () => {};
  started = true;
  const mode = config.liveMode ? 'LIVE' : 'PAPER';
  const latest = new Map(), processing = new Set(), lastProcessed = new Map();
  let socket, reconnectTimer, pingTimer, watchdogTimer, reconnectAttempt = 0, stopped = false;
  let lastTickerAt = Date.now(), fallbackRunning = false;

  const processLatest = async symbol => {
    if (processing.has(symbol)) return;
    processing.add(symbol);
    try {
      while (!stopped && latest.has(symbol)) {
        const elapsed = Date.now() - (lastProcessed.get(symbol) ?? 0);
        const wait = Math.max(0, config.priceTriggerCooldownMs - elapsed);
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        if (stopped) break;
        const update = latest.get(symbol);
        latest.delete(symbol);
        const age = Date.now() - update.eventTime;
        if (age > config.websocketStaleSeconds * 1000 || age < -60_000) continue;
        const position = store.openFor(symbol, mode);
        if (position?.status === 'OPEN') {
          const executablePrice = Number.isFinite(update.bid) && update.bid > 0 ? update.bid : update.last;
          // Reuse only a recent completed-candle analysis. If it is stale/missing, normal target
          // selling remains the safe fallback; a stale bullish signal must never hold forever.
          const signalSince = new Date(Date.now() - intervalMilliseconds(config.interval) * 2).toISOString();
          const signal = store.latestSignal(symbol, signalSince);
          await managePosition(position, executablePrice, signal, update.last);
        }
        lastProcessed.set(symbol, Date.now());
      }
    } catch (error) {
      if (!stopped) store.event('ERROR', `WebSocket price handling ${symbol}: ${error.message}`);
    } finally {
      processing.delete(symbol);
      if (latest.has(symbol)) processLatest(symbol);
    }
  };

  const accept = update => {
    latest.set(update.symbol, update);
    processLatest(update.symbol);
  };

  const restFallback = async () => {
    if (fallbackRunning) return;
    fallbackRunning = true;
    try {
      for (const position of store.openPositions(mode)) {
        try {
          const ticker = await wazirx.ticker(position.symbol);
          const last = Number(ticker.lastPrice);
          const bid = Number(ticker.bidPrice);
          if (Number.isFinite(last) && last > 0) accept({ symbol: position.symbol, last, bid, eventTime: Date.now() });
        } catch (error) {
          store.event('ERROR', `REST price fallback ${position.symbol}: ${error.message}`);
        }
      }
    } finally { fallbackRunning = false; }
  };

  const clearConnectionTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    pingTimer = watchdogTimer = null;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const seconds = Math.min(config.websocketReconnectMaxSeconds, 2 ** Math.min(reconnectAttempt++, 5));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, seconds * 1000);
  };

  const connect = () => {
    if (stopped) return;
    lastTickerAt = Date.now();
    socket = new WebSocket(URL);
    socket.on('open', () => {
      reconnectAttempt = 0;
      socket.send(JSON.stringify({ event: 'subscribe', streams: [STREAM] }));
      store.event('INFO', 'WazirX public price WebSocket connected');
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: 'ping' }));
      }, 10 * 60_000);
      watchdogTimer = setInterval(() => {
        if (Date.now() - lastTickerAt > config.websocketStaleSeconds * 1000) {
          store.event('ERROR', 'WazirX price WebSocket stale — using REST fallback and reconnecting');
          restFallback();
          socket.terminate();
        }
      }, 5_000);
    });
    socket.on('message', raw => {
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch { return; }
      const updates = tickerUpdates(payload);
      if (!updates.length) return;
      lastTickerAt = Date.now();
      for (const update of updates) accept(update);
    });
    socket.on('error', error => store.event('ERROR', `WazirX price WebSocket: ${error.message}`));
    socket.on('close', () => {
      clearConnectionTimers();
      if (!stopped) { restFallback(); scheduleReconnect(); }
    });
  };

  connect();
  return () => {
    stopped = true;
    started = false;
    latest.clear();
    clearConnectionTimers();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) socket.terminate();
  };
}
