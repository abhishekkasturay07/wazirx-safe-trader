import express from 'express';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertSafeConfiguration } from './config.js';
import { store } from './database/db.js';
import { scan } from './jobs/scanner.js';

assertSafeConfiguration();
const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root, '../public')));
app.get('/api/status', (_req, res) => {
  const open = store.openPositions(), totalPnl = store.totalPnl();
  res.json({ mode: config.liveMode ? 'LIVE' : 'PAPER', capital: config.startingCapital + totalPnl, todayPnl: store.todayPnl(), totalPnl, openPositions: open, signals: store.latestSignals(), trades: store.recentPositions() });
});
app.post('/api/scan', async (_req, res) => { try { res.json(await scan()); } catch (e) { res.status(500).json({ error: e.message }); } });

cron.schedule(config.scanCron, () => scan().catch(e => store.event('ERROR', e.message)));
app.listen(config.port, () => console.log(`WazirX trader (${config.liveMode ? 'LIVE' : 'PAPER'}) on http://localhost:${config.port}`));
