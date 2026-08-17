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

export const store = {
  signal(symbol, result) {
    db.prepare('INSERT INTO signals(symbol,score,action,price,details,created_at) VALUES(?,?,?,?,?,?)')
      .run(symbol, result.score, result.action, result.price, JSON.stringify(result), new Date().toISOString());
  },
  openPosition(p) {
    return db.prepare(`INSERT INTO positions(symbol,mode,entry_price,quantity,invested,stop_price,target_price,high_price,entry_score,entry_reason,opened_at)
      VALUES(@symbol,@mode,@entryPrice,@quantity,@invested,@stopPrice,@targetPrice,@entryPrice,@score,@reason,@now)`).run({ ...p, now: new Date().toISOString() }).lastInsertRowid;
  },
  closePosition(id, exitPrice, pnl, reason) {
    db.prepare("UPDATE positions SET status='CLOSED',exit_price=?,pnl=?,exit_reason=?,closed_at=? WHERE id=?")
      .run(exitPrice, pnl, reason, new Date().toISOString(), id);
  },
  updateProtection(id, highPrice, stopPrice) { db.prepare('UPDATE positions SET high_price=?,stop_price=? WHERE id=?').run(highPrice, stopPrice, id); },
  openPositions() { return db.prepare("SELECT * FROM positions WHERE status='OPEN' ORDER BY opened_at").all(); },
  openFor(symbol) { return db.prepare("SELECT * FROM positions WHERE status='OPEN' AND symbol=?").get(symbol); },
  recentPositions(limit = 50) { return db.prepare('SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?').all(limit); },
  todayPnl() { return db.prepare("SELECT COALESCE(SUM(pnl),0) value FROM positions WHERE status='CLOSED' AND date(closed_at)=date('now')").get().value; },
  totalPnl() { return db.prepare("SELECT COALESCE(SUM(pnl),0) value FROM positions WHERE status='CLOSED'").get().value; },
  consecutiveLosses() {
    const rows = db.prepare("SELECT pnl FROM positions WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 20").all();
    return rows.findIndex(r => r.pnl >= 0) === -1 ? rows.length : rows.findIndex(r => r.pnl >= 0);
  },
  latestSignals() { return db.prepare('SELECT * FROM signals WHERE id IN (SELECT MAX(id) FROM signals GROUP BY symbol) ORDER BY symbol').all(); },
  event(level, message) { db.prepare('INSERT INTO events(level,message,created_at) VALUES(?,?,?)').run(level, message, new Date().toISOString()); }
};
