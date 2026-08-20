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
for (const [name, ddl] of Object.entries({ buy_order_id: 'TEXT', sell_order_id: 'TEXT', filled_quantity: 'REAL' })) {
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
  openPosition(p) {
    return db.prepare(`INSERT INTO positions(symbol,mode,entry_price,quantity,invested,stop_price,target_price,high_price,entry_score,entry_reason,opened_at)
      VALUES(@symbol,@mode,@entryPrice,@quantity,@invested,@stopPrice,@targetPrice,@entryPrice,@score,@reason,@now)`).run({ ...p, now: new Date().toISOString() }).lastInsertRowid;
  },
  openPending(p) {
    return db.prepare(`INSERT INTO positions(symbol,mode,status,entry_price,quantity,invested,stop_price,target_price,high_price,entry_score,entry_reason,opened_at,buy_order_id)
      VALUES(@symbol,@mode,'PENDING_ENTRY',@entryPrice,@quantity,@invested,@stopPrice,@targetPrice,@entryPrice,@score,@reason,@now,@buyOrderId)`).run({ ...p, now: new Date().toISOString() }).lastInsertRowid;
  },
  confirmEntry(id, { quantity, entryPrice, invested }) {
    db.prepare("UPDATE positions SET status='OPEN',quantity=?,entry_price=?,invested=?,high_price=?,filled_quantity=? WHERE id=?")
      .run(quantity, entryPrice, invested, entryPrice, quantity, id);
  },
  cancelEntry(id) { db.prepare("UPDATE positions SET status='CANCELLED',closed_at=? WHERE id=?").run(new Date().toISOString(), id); },
  markPendingExit(id, sellOrderId, reason) { db.prepare("UPDATE positions SET status='PENDING_EXIT',sell_order_id=?,exit_reason=? WHERE id=?").run(sellOrderId, reason, id); },
  revertToOpen(id) { db.prepare("UPDATE positions SET status='OPEN',sell_order_id=NULL,exit_reason=NULL WHERE id=?").run(id); },
  closePosition(id, exitPrice, pnl, reason) {
    db.prepare("UPDATE positions SET status='CLOSED',exit_price=?,pnl=?,exit_reason=?,closed_at=? WHERE id=?")
      .run(exitPrice, pnl, reason, new Date().toISOString(), id);
  },
  confirmExit(id, exitPrice, pnl, reason) {
    db.prepare("UPDATE positions SET status='CLOSED',exit_price=?,pnl=?,exit_reason=?,closed_at=? WHERE id=?")
      .run(exitPrice, pnl, reason, new Date().toISOString(), id);
  },
  updateProtection(id, highPrice, stopPrice) { db.prepare('UPDATE positions SET high_price=?,stop_price=? WHERE id=?').run(highPrice, stopPrice, id); },
  openPositions() { return db.prepare("SELECT * FROM positions WHERE status='OPEN' ORDER BY opened_at").all(); },
  pendingPositions() { return db.prepare("SELECT * FROM positions WHERE status IN ('PENDING_ENTRY','PENDING_EXIT') ORDER BY opened_at").all(); },
  openFor(symbol) { return db.prepare("SELECT * FROM positions WHERE status IN ('OPEN','PENDING_ENTRY','PENDING_EXIT') AND symbol=?").get(symbol); },
  recentPositions(limit = 50) { return db.prepare('SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?').all(limit); },
  todayPnl() {
    const [start, end] = istDayRangeUtc();
    return db.prepare("SELECT COALESCE(SUM(pnl),0) value FROM positions WHERE status='CLOSED' AND closed_at>=? AND closed_at<?").get(start, end).value;
  },
  totalPnl() { return db.prepare("SELECT COALESCE(SUM(pnl),0) value FROM positions WHERE status='CLOSED'").get().value; },
  consecutiveLosses() {
    const rows = db.prepare("SELECT pnl FROM positions WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 20").all();
    return rows.findIndex(r => r.pnl >= 0) === -1 ? rows.length : rows.findIndex(r => r.pnl >= 0);
  },
  latestSignals() { return db.prepare('SELECT * FROM signals WHERE id IN (SELECT MAX(id) FROM signals GROUP BY symbol) ORDER BY symbol').all(); },
  event(level, message) { db.prepare('INSERT INTO events(level,message,created_at) VALUES(?,?,?)').run(level, message, new Date().toISOString()); }
};
