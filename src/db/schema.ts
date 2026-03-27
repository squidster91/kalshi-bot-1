import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve(config.db.path);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    initSchema(db);
    logger.info('Database initialized', { path: dbPath });
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rfqs_seen (
      id TEXT PRIMARY KEY,
      market_ticker TEXT,
      event_ticker TEXT,
      legs_json TEXT,
      contracts_requested TEXT,
      target_cost_dollars TEXT,
      received_at TEXT NOT NULL,
      quoted INTEGER DEFAULT 0,
      quote_id TEXT,
      quote_price_yes TEXT,
      quote_price_no TEXT,
      computed_fair_value REAL,
      num_legs INTEGER,
      is_same_game INTEGER
    );

    CREATE TABLE IF NOT EXISTS quotes_submitted (
      id TEXT PRIMARY KEY,
      rfq_id TEXT NOT NULL,
      yes_bid_dollars TEXT,
      no_bid_dollars TEXT,
      yes_contracts TEXT,
      no_contracts TEXT,
      fair_value_computed REAL,
      spread_applied REAL,
      status TEXT NOT NULL DEFAULT 'open',
      submitted_at TEXT NOT NULL,
      accepted_at TEXT,
      confirmed_at TEXT,
      executed_at TEXT,
      FOREIGN KEY (rfq_id) REFERENCES rfqs_seen(id)
    );

    CREATE TABLE IF NOT EXISTS positions (
      market_ticker TEXT PRIMARY KEY,
      event_ticker TEXT,
      side TEXT NOT NULL,
      contracts INTEGER NOT NULL DEFAULT 0,
      avg_entry_price REAL NOT NULL DEFAULT 0,
      current_value REAL,
      settled INTEGER DEFAULT 0,
      settlement_side TEXT,
      realized_pnl REAL DEFAULT 0,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pnl_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      market_ticker TEXT,
      rfq_id TEXT,
      amount REAL NOT NULL,
      running_balance REAL,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS correlation_matrix (
      leg_type_a TEXT NOT NULL,
      leg_type_b TEXT NOT NULL,
      correlation REAL NOT NULL,
      sample_size INTEGER,
      last_updated TEXT,
      PRIMARY KEY (leg_type_a, leg_type_b)
    );

    CREATE TABLE IF NOT EXISTS daily_pnl (
      date TEXT PRIMARY KEY,
      gross_pnl REAL DEFAULT 0,
      fees_paid REAL DEFAULT 0,
      net_pnl REAL DEFAULT 0,
      rfqs_seen INTEGER DEFAULT 0,
      quotes_submitted INTEGER DEFAULT 0,
      quotes_filled INTEGER DEFAULT 0,
      combos_won INTEGER DEFAULT 0,
      combos_lost INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_rfqs_received_at ON rfqs_seen(received_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes_submitted(status);
    CREATE INDEX IF NOT EXISTS idx_pnl_timestamp ON pnl_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_positions_event ON positions(event_ticker);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
