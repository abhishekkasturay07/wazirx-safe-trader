import { config } from '../config.js';
import { store } from '../database/db.js';
import { wazirx } from '../api/wazirx.js';
import { areEntriesPaused, setEntriesPaused } from '../runtime-controls.js';
import { telegramRequest } from '../notifications/telegram-client.js';

const money = value => `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const mode = () => config.liveMode ? 'LIVE' : 'PAPER';
const HELP = [
  'WazirX Trader commands:',
  '/status - P&L, risk and open positions',
  '/portfolio - WazirX balances',
  '/scan - run a market scan now',
  '/pause - stop new entries (open trades stay managed)',
  '/resume - allow new entries',
  '/risk - circuit-breaker details',
  '/help - show this list'
].join('\n');

export function normalizeCommand(text = '') {
  return text.trim().split(/\s+/)[0].toLowerCase().replace(/@[^ ]+$/, '');
}

function positionLines(positions) {
  if (!positions.length) return 'Open positions: none';
  return ['Open positions:', ...positions.map(p => `${p.symbol.toUpperCase()} — ${p.status}/${p.strategy_stage ?? 'INITIAL'}, ${money(p.invested)} @ ${money(p.entry_price)}`)].join('\n');
}

async function portfolioText() {
  if (!config.apiKey || !config.secretKey) return 'Portfolio unavailable: WazirX API keys are not configured.';
  const funds = await wazirx.funds();
  const holdings = funds.map(f => ({ asset: f.asset, total: Number(f.free) + Number(f.locked) })).filter(f => f.total > 0);
  return holdings.length ? ['WazirX holdings:', ...holdings.map(h => `${h.asset.toUpperCase()}: ${h.total}`)].join('\n') : 'No WazirX balances found.';
}

export function createTelegramBot({ scan, riskStatus, request = telegramRequest, logger = console } = {}) {
  let offset = 0, stopped = false, controller;
  const allowed = new Set(config.telegram.allowedChatIds);
  const reply = (chatId, text) => request('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4096) });

  async function handleMessage(message) {
    const chatId = String(message?.chat?.id ?? '');
    if (!allowed.has(chatId)) {
      logger.warn?.(`Rejected Telegram command from unauthorized chat ${chatId || 'unknown'}`);
      return;
    }
    const command = normalizeCommand(message.text);
    try {
      if (command === '/start' || command === '/help') return await reply(chatId, HELP);
      if (command === '/pause') {
        setEntriesPaused(true);
        store.event('INFO', `New entries paused from Telegram chat ${chatId}`);
        return await reply(chatId, '⏸ New entries paused. Existing positions remain protected and managed.');
      }
      if (command === '/resume') {
        setEntriesPaused(false);
        store.event('INFO', `New entries resumed from Telegram chat ${chatId}`);
        return await reply(chatId, '▶️ New entries resumed. Risk limits still apply.');
      }
      if (command === '/risk') {
        const risk = riskStatus();
        return await reply(chatId, `Risk: ${risk.allowed ? 'ALLOWED' : 'BLOCKED'}\nReason: ${risk.reason ?? 'none'}\nSession P&L: ${money(risk.dailyPnl)}\nLoss limit: ${money(risk.lossLimit)}\nConsecutive losses: ${risk.consecutiveLosses}\nEntries paused: ${areEntriesPaused() ? 'yes' : 'no'}`);
      }
      if (command === '/status') {
        const currentMode = mode(), risk = riskStatus(), positions = store.activePositions(currentMode);
        return await reply(chatId, `Mode: ${currentMode}\nToday P&L: ${money(store.todayPnl(currentMode))}\nTotal P&L: ${money(store.totalPnl(currentMode))}\nNew entries: ${risk.allowed ? 'allowed' : `blocked — ${risk.reason}`}\n${positionLines(positions)}`);
      }
      if (command === '/portfolio') return await reply(chatId, await portfolioText());
      if (command === '/scan') {
        await reply(chatId, '🔎 Scan started…');
        const result = await scan();
        if (result?.skipped) return await reply(chatId, `Scan skipped: ${result.reason}`);
        const buys = (result?.results ?? []).filter(item => !item.error && item.action === 'BUY');
        const errors = (result?.results ?? []).filter(item => item.error);
        return await reply(chatId, `Scan complete. Signals: ${result?.results?.length ?? 0}, BUY: ${buys.length}, errors: ${errors.length}.`);
      }
      return await reply(chatId, `Unknown command.\n\n${HELP}`);
    } catch (error) {
      store.event('ERROR', `Telegram ${command || 'message'}: ${error.message}`);
      return await reply(chatId, `❌ Command failed: ${error.message}`).catch(() => {});
    }
  }

  async function poll() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const updates = await request('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, { signal: controller.signal });
        for (const update of updates ?? []) {
          offset = Math.max(offset, Number(update.update_id) + 1);
          if (update.message?.text) await handleMessage(update.message);
        }
      } catch (error) {
        if (!stopped && error.name !== 'AbortError') {
          logger.error?.(`Telegram polling error: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }
  }

  return {
    handleMessage,
    start() { if (!config.telegram.enabled) return false; stopped = false; void poll(); return true; },
    stop() { stopped = true; controller?.abort(); }
  };
}
