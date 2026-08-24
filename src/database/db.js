import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
    entry_price REAL NOT NULL, quantity REAL NOT NULL, invested REAL NOT NULL, stop_price REAL NOT NULL,
    target_price REAL NOT NULL, high_price REAL NOT NULL, exit_price REAL, pnl REAL, entry_score INTEGER,
    entry_reason TEXT, exit_reason TEXT, opened_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, score INTEGER NOT NULL, action TEXT NOT NULL,
    price REAL NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);
const existingColumns = new Set(db.prepare('PRAGMA table_info(positions)').all().map(c => c.name));
for (const [name, ddl] of Object.entries({
  buy_order_id: 'TEXT', sell_order_id: 'TEXT', filled_quantity: 'REAL', client_order_id: 'TEXT', pending_since: 'TEXT',
  strategy_stage: "TEXT NOT NULL DEFAULT 'INITIAL'", original_quantity: 'REAL', tp1_sold_quantity: 'REAL NOT NULL DEFAULT 0',
  tp2_sold_quantity: 'REAL NOT NULL DEFAULT 0', realized_pnl: 'REAL NOT NULL DEFAULT 0', basket_break_even: 'REAL'
})) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE positions ADD COLUMN ${name} ${ddl}`);
}

function istDayRangeUtc() {
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const startUtc = new Date(istMidnight - IST_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 24 * 3600 * 1000);
  return [startUtc.toISOString(), endUtc.toISOString()];
}

export const store = {
  signal(symbol, result) {
    db.prepare('INSERT INTO signals(symbol,score,action,price,details,created_at) VALUES(?,?,?,?,?,?)')
      .run(symbol, result.score, result.action, result.price, JSON.stringify(result), new Date().toISOString());
  },
  latestSignal(symbol, sinceIso = null) {
    const row = sinceIso
      ? db.prepare('SELECT details,created_at FROM signals WHERE symbol=? AND created_at>=? ORDER BY id DESC LIMIT 1').get(symbol, sinceIso)
      : db.prepare('SELECT details,created_at FROM signals WHERE symbol=? ORDER BY id DESC LIMIT 1').get(symbol);
    if (!row) return null;
    try { return { ...JSON.parse(row.details), createdAt: row.created_at }; } catch { return null; }
  },
  openPosition(p) {
    return db.prepare(`INSERT INTO positions(symbol,mode,entry_price,quantity,original_quantity,invested,stop_price,target_price,high_price,entry_score,entry_reason,opened_at)
      VALUES(@symbol,@mode,@entryPrice,@quantity,@quantity,@invested,@stopPrice,@targetPrice,@entryPrice,@score,@reason,@now)`).run({ ...p, now: new Date().toISOString() }).lastInsertRowid;
  },
  openPending(p) {
    const now = new Date().toISOString();
    return db.prepare(`INSERT INTO positions(symbol,mode,status,entry_price,quantity,invested,stop_price,target_price,high_price,entry_score,entry_reason,opened_at,client_order_id,pending_since)
      VALUES(@symbol,@mode,'PENDING_ENTRY',@entryPrice,@quantity,@invested,@stopPrice,@targetPrice,@entryPrice,@score,@reason,@now,@clientOrderId,@now)`).run({ ...p, now }).lastInsertRowid;
  },
  attachOrderId(id, side, orderId) {
    const column = side === 'buy' ? 'buy_order_id' : 'sell_order_id';
    db.prepare(`UPDATE positions SET ${column}=?,client_order_id=NULL WHERE id=?`).run(String(orderId), id);
  },
  confirmEntry(id, { quantity, entryPrice, invested, stopPrice, targetPrice }) {
    db.prepare("UPDATE positions SET status='OPEN',strategy_stage='INITIAL',quantity=?,original_quantity=?,entry_price=?,invested=?,high_price=?,filled_quantity=?,stop_price=?,target_price=?,pending_since=NULL WHERE id=?")
      .run(quantity, quantity, entryPrice, invested, entryPrice, quantity, stopPrice, targetPrice, id);
  },
  cancelEntry(id) { db.prepare("UPDATE positions SET status='CANCELLED',closed_at=?,client_order_id=NULL,pending_since=NULL WHERE id=?").run(new Date().toISOString(), id); },
  markPendingExit(id, reason, clientOrderId) {
    db.prepare("UPDATE positions SET status='PENDING_EXIT',sell_order_id=NULL,exit_reason=?,client_order_id=?,pending_since=? WHERE id=?").run(reason, clientOrderId, new Date().toISOString(), id);
  },
  markPendingAdd(id, clientOrderId) {
    db.prepare("UPDATE positions SET status='PENDING_ADD',client_order_id=?,buy_order_id=NULL,pending_since=? WHERE id=?")
      .run(clientOrderId, new Date().toISOString(), id);
  },
  revertAdd(id) { db.prepare("UPDATE positions SET status='OPEN',client_order_id=NULL,buy_order_id=NULL,pending_since=NULL WHERE id=?").run(id); },
  confirmAdd(id, { addedQuantity, addedInvested, entryPrice, totalQuantity, totalInvested, stopPrice, targetPrice }) {
    db.prepare(`UPDATE positions SET status='OPEN',strategy_stage='FULL',quantity=?,original_quantity=?,entry_price=?,invested=?,high_price=max(high_price,?),filled_quantity=?,stop_price=?,target_price=?,pending_since=NULL,client_order_id=NULL
      WHERE id=?`).run(totalQuantity, totalQuantity, entryPrice, totalInvested, entryPrice, totalQuantity, stopPrice, targetPrice, id);
  },
  revertToOpen(id) { db.prepare("UPDATE positions SET status='OPEN',sell_order_id=NULL,exit_reason=NULL,client_order_id=NULL,pending_since=NULL WHERE id=?").run(id); },
  reopenAsPendingExit(id, sellOrderId, reason) {
    db.prepare("UPDATE positions SET status='PENDING_EXIT',sell_order_id=?,exit_reason=?,client_order_id=NULL,exit_price=NULL,pnl=NULL,closed_at=NULL,pending_since=? WHERE id=?").run(String(sellOrderId), reason, new Date().toISOString(), id);
  },
  orphanExitCandidates(symbol, quantity) {
    const tolerance = Math.max(1e-8, Math.abs(quantity) * 1e-8);
    return db.prepare(`SELECT * FROM positions
      WHERE status='CLOSED' AND mode='LIVE' AND lower(symbol)=lower(?) AND sell_order_id IS NULL
        AND exit_reason IS NOT NULL AND julianday(closed_at)>=julianday('now','-7 days') AND abs(quantity-?)<=?
      ORDER BY closed_at DESC`).all(symbol, quantity, tolerance);
  },
  closePosition(id, exitPrice, pnl, reason) {
    db.prepare("UPDATE positions SET status='CLOSED',exit_price=?,pnl=?,exit_reason=?,closed_at=? WHERE id=?")
      .run(exitPrice, pnl, reason, new Date().toISOString(), id);
  },
  confirmExit(id, exitPrice, pnl, reason) {
    db.prepare("UPDATE positions SET status='CLOSED',exit_price=?,pnl=?,exit_reason=?,closed_at=?,filled_quantity=quantity,pending_since=NULL WHERE id=?")
      .run(exitPrice, pnl, reason, new Date().toISOString(), id);
  },
  closeMissingHolding(id) {
    db.prepare("UPDATE positions SET status='CLOSED',exit_price=NULL,pnl=NULL,exit_reason='EXTERNAL_BALANCE_MISSING',closed_at=?,pending_since=NULL,client_order_id=NULL WHERE id=? AND status IN ('OPEN','PENDING_EXIT') AND mode='LIVE'")
      .run(new Date().toISOString(), id);
  },
  confirmPartialExit: db.transaction((position, { soldQty, soldInvested, exitPrice, pnl, reason, nextStage }) => {
    const now = new Date().toISOString();
    const remainingQty = position.quantity - soldQty;
    const remainingInvested = position.invested - soldInvested;
    db.prepare(`INSERT INTO positions(symbol,mode,status,entry_price,quantity,invested,stop_price,target_price,high_price,exit_price,pnl,entry_score,entry_reason,exit_reason,opened_at,closed_at,sell_order_id,filled_quantity)
      VALUES(@symbol,@mode,'CLOSED',@entryPrice,@soldQty,@soldInvested,@stopPrice,@targetPrice,@highPrice,@exitPrice,@pnl,@score,@entryReason,@reason,@openedAt,@now,@sellOrderId,@soldQty)`)
      .run({ symbol: position.symbol, mode: position.mode, entryPrice: position.entry_price, soldQty, soldInvested, stopPrice: position.stop_price, targetPrice: position.target_price, highPrice: position.high_price, exitPrice, pnl, score: position.entry_score, entryReason: position.entry_reason, reason, openedAt: position.opened_at, now, sellOrderId: position.sell_order_id });
    const realizedPnl = Number(position.realized_pnl ?? 0) + pnl;
    const feeRate = config.feePercent / 100;
    const breakEven = remainingQty > 0 ? Math.max(0, remainingInvested - realizedPnl) / (remainingQty * (1 - feeRate)) : null;
    const tp1Sold = Number(position.tp1_sold_quantity ?? 0) + (reason === 'TAKE_PROFIT_1' ? soldQty : 0);
    const tp2Sold = Number(position.tp2_sold_quantity ?? 0) + (reason === 'TAKE_PROFIT_2' ? soldQty : 0);
    db.prepare("UPDATE positions SET status='OPEN',strategy_stage=?,quantity=?,invested=?,realized_pnl=?,basket_break_even=?,tp1_sold_quantity=?,tp2_sold_quantity=?,sell_order_id=NULL,exit_reason=NULL,pending_since=NULL WHERE id=?")
      .run(nextStage ?? position.strategy_stage, remainingQty, remainingInvested, realizedPnl, breakEven, tp1Sold, tp2Sold, position.id);
  }),
  updateProtection(id, highPrice, stopPrice) { db.prepare('UPDATE positions SET high_price=?,stop_price=? WHERE id=?').run(highPrice, stopPrice, id); },
  openPositions(mode) { return db.prepare("SELECT * FROM positions WHERE status='OPEN' AND mode=? ORDER BY opened_at").all(mode); },
  position(id) { return db.prepare('SELECT * FROM positions WHERE id=?').get(id); },
  activePositions(mode) { return db.prepare("SELECT * FROM positions WHERE status IN ('OPEN','PENDING_ENTRY','PENDING_ADD','PENDING_EXIT') AND mode=? ORDER BY opened_at").all(mode); },
  pendingPositions() { return db.prepare("SELECT * FROM positions WHERE status IN ('PENDING_ENTRY','PENDING_ADD','PENDING_EXIT') ORDER BY opened_at").all(); },
  openFor(symbol, mode) { return db.prepare("SELECT * FROM positions WHERE status IN ('OPEN','PENDING_ENTRY','PENDING_ADD','PENDING_EXIT') AND mode=? AND symbol=?").get(mode, symbol); },
  inCooldown(symbol, mode, sinceIso) {
    return Boolean(db.prepare("SELECT 1 FROM positions WHERE symbol=? AND mode=? AND status='CLOSED' AND exit_reason IN ('STOP_OR_TRAILING_STOP','TIME_EXIT') AND closed_at>=? LIMIT 1").get(symbol, mode, sinceIso));
  },
  recentPositions(limit = 50, mode = null) {
    return mode
      ? db.prepare('SELECT * FROM positions WHERE mode=? ORDER BY opened_at DESC LIMIT ?').all(mode, limit)
      : db.prepare('SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?').all(limit);
  },
  todayPnl(mode) {
    const [start, end] = istDayRangeUtc();
    return db.prepare("SELECT COALESCE(SUM(pnl),0) value FROM positions WHERE status='CLOSED' AND mode=? AND closed_at>=? AND closed_at<?").get(mode, start, end).value;
  },
  totalPnl(mode) { return db.prepare("SELECT COALESCE(SUM(pnl),0) value FROM positions WHERE status='CLOSED' AND mode=?").get(mode).value; },
  consecutiveLosses(mode) {
    // This is a daily circuit breaker. Counting the entire trade history can permanently lock the
    // bot: once blocked, it cannot place a winning trade that would reset the streak. Reset at the
    // IST day boundary, consistently with DAILY_LOSS_LIMIT_INR and the dashboard's Today's P&L.
    const [start, end] = istDayRangeUtc();
    const rows = db.prepare("SELECT pnl FROM positions WHERE status='CLOSED' AND mode=? AND pnl IS NOT NULL AND closed_at>=? AND closed_at<? ORDER BY closed_at DESC LIMIT 20").all(mode, start, end);
    return rows.findIndex(r => r.pnl >= 0) === -1 ? rows.length : rows.findIndex(r => r.pnl >= 0);
  },
  latestSignals() { return db.prepare('SELECT * FROM signals WHERE id IN (SELECT MAX(id) FROM signals GROUP BY symbol) ORDER BY symbol').all(); },
  event(level, message) { db.prepare('INSERT INTO events(level,message,created_at) VALUES(?,?,?)').run(level, message, new Date().toISOString()); }
};
