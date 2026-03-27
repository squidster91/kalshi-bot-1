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

    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      mid_price REAL NOT NULL,
      timestamp TEXT NOT NULL
    );

    -- Known bot creators: persisted across restarts
    CREATE TABLE IF NOT EXISTS known_bots (
      creator_id TEXT PRIMARY KEY,
      first_detected TEXT NOT NULL,
      rfq_count INTEGER DEFAULT 0
    );

    -- Persistent price cache: latest known price per ticker
    CREATE TABLE IF NOT EXISTS price_cache (
      ticker TEXT PRIMARY KEY,
      mid_price REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- RFQ outcome tracking: leg prices at RFQ time
    CREATE TABLE IF NOT EXISTS rfq_leg_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id TEXT NOT NULL,
      leg_ticker TEXT NOT NULL,
      leg_side TEXT NOT NULL,
      mid_price_at_rfq REAL,
      latest_mid_price REAL,
      latest_price_at TEXT,
      settled INTEGER DEFAULT 0,
      settlement_result TEXT,
      FOREIGN KEY (rfq_id) REFERENCES rfqs_seen(id)
    );

    -- Daily qualified RFQ summaries (day-over-day tracking)
    CREATE TABLE IF NOT EXISTS daily_qualified (
      date TEXT PRIMARY KEY,
      qualified_count INTEGER DEFAULT 0,
      qualified_budget_cents INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_rfqs_received_at ON rfqs_seen(received_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes_submitted(status);
    CREATE INDEX IF NOT EXISTS idx_pnl_timestamp ON pnl_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_positions_event ON positions(event_ticker);
    CREATE INDEX IF NOT EXISTS idx_price_snapshots_ticker_ts ON price_snapshots(ticker, timestamp);
    CREATE INDEX IF NOT EXISTS idx_rfq_leg_prices_rfq ON rfq_leg_prices(rfq_id);
    CREATE INDEX IF NOT EXISTS idx_rfq_leg_prices_ticker ON rfq_leg_prices(leg_ticker);
  `);

  // Add columns to rfqs_seen if they don't exist (safe migration)
  try {
    db.exec(`ALTER TABLE rfqs_seen ADD COLUMN deleted_at TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE rfqs_seen ADD COLUMN lifespan_ms INTEGER`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE rfqs_seen ADD COLUMN leg_prices_snapshot TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE rfqs_seen ADD COLUMN has_player_props INTEGER DEFAULT 0`);
    // Only backfill when column is first added (new column = all zeros)
    // Do it in batches to avoid CPU/disk spikes
    logger.info('Backfilling has_player_props column...');
    let updated = 0;
    const batchStmt = db.prepare(`
      UPDATE rfqs_seen SET has_player_props = 1
      WHERE rowid IN (
        SELECT rowid FROM rfqs_seen
        WHERE has_player_props = 0
          AND (legs_json LIKE '%PTS%' OR legs_json LIKE '%REB%' OR legs_json LIKE '%AST%'
               OR legs_json LIKE '%3PM%' OR legs_json LIKE '%TPM%' OR legs_json LIKE '%STL%'
               OR legs_json LIKE '%BLK%')
        LIMIT 5000
      )
    `);
    while (true) {
      const result = batchStmt.run();
      updated += result.changes;
      if (result.changes === 0) break;
    }
    logger.info('Backfill complete', { updated });
  } catch { /* column already exists — no backfill needed */ }

  // One-time migration: clear known_bots to rebuild with 10+ threshold
  try {
    const migrationKey = 'reset_bots_threshold_10';
    const existing = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'`).get();
    if (!existing) {
      db.exec(`CREATE TABLE migrations (key TEXT PRIMARY KEY, applied_at TEXT)`);
    }
    const applied = db.prepare(`SELECT key FROM migrations WHERE key = ?`).get(migrationKey);
    if (!applied) {
      db.exec(`DELETE FROM known_bots`);
      db.prepare(`INSERT INTO migrations (key, applied_at) VALUES (?, ?)`).run(migrationKey, new Date().toISOString());
      logger.info('Migration: cleared known_bots table for 10+ threshold rebuild');
    }
  } catch (err) {
    logger.warn('Migration check failed', { error: String(err) });
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
