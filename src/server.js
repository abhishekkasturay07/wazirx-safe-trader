import express from 'express';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertSafeConfiguration } from './config.js';
import { store } from './database/db.js';
import { scan } from './jobs/scanner.js';
import { wazirx } from './api/wazirx.js';
import { reconcilePending } from './trading/reconcile.js';

assertSafeConfiguration();
const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root, '../public')));

async function realPortfolioValueInr(funds) {
  let total = 0;
  for (const f of funds) {
    const amount = Number(f.free) + Number(f.locked);
    if (amount <= 0) continue;
    if (f.asset === 'inr') { total += amount; continue; }
    try {
      const t = await wazirx.ticker(`${f.asset}inr`);
      total += amount * Number(t.lastPrice);
    } catch { /* no direct INR pair for this asset — skip its value */ }
  }
  return total;
}

app.get('/api/status', async (_req, res) => {
  const mode = config.liveMode ? 'LIVE' : 'PAPER';
  const open = store.activePositions(mode), totalPnl = store.totalPnl(mode);
  let capital = config.startingCapital + totalPnl, capitalSource = 'ledger';
  if (config.liveMode && config.apiKey && config.secretKey) {
    try { capital = await realPortfolioValueInr(await wazirx.funds()); capitalSource = 'wazirx'; }
    catch { /* WazirX unreachable — capital stays the internal ledger estimate, flagged via capitalSource */ }
  }
  res.json({ mode, capital, capitalSource, todayPnl: store.todayPnl(mode), totalPnl, openPositions: open, signals: store.latestSignals(), trades: store.recentPositions() });
});
app.post('/api/scan', async (_req, res) => { try { res.json(await scan()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/portfolio', async (_req, res) => {
  if (!config.apiKey || !config.secretKey) return res.json({ configured: false, holdings: [] });
  try {
    const funds = await wazirx.funds();
    const holdings = funds
      .map(f => ({ asset: f.asset, free: Number(f.free), locked: Number(f.locked) }))
      .filter(f => f.free + f.locked > 0);
    res.json({ configured: true, holdings, totalValueInr: await realPortfolioValueInr(funds) });
  } catch (e) { res.status(500).json({ configured: true, error: e.message, holdings: [] }); }
});

if (config.liveMode) await reconcilePending().catch(e => store.event('ERROR', `startup reconcile: ${e.message}`));
cron.schedule(config.scanCron, () => scan().catch(e => store.event('ERROR', e.message)));
app.listen(config.port, () => console.log(`WazirX trader (${config.liveMode ? 'LIVE' : 'PAPER'}) on http://localhost:${config.port}`));
