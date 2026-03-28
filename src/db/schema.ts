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

  // Create index on has_player_props (after column is guaranteed to exist)
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rfqs_player_date ON rfqs_seen(has_player_props, received_at)`);
  } catch { /* index already exists */ }

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

  // One-time migration: purge all old rfqs_seen data (pre-filter era)
  try {
    const migrationKey = 'purge_old_rfqs_v1';
    const applied = db.prepare(`SELECT key FROM migrations WHERE key = ?`).get(migrationKey);
    if (!applied) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const result = db.prepare(`DELETE FROM rfqs_seen WHERE received_at < ? || 'T00:00:00'`).run(today);
      db.prepare(`DELETE FROM rfq_leg_prices WHERE rfq_id NOT IN (SELECT id FROM rfqs_seen)`).run();
      db.exec(`VACUUM`);
      db.prepare(`INSERT INTO migrations (key, applied_at) VALUES (?, ?)`).run(migrationKey, new Date().toISOString());
      logger.info('Migration: purged old rfqs_seen data', { deleted: result.changes });
    }
  } catch (err) {
    logger.warn('Purge migration failed', { error: String(err) });
  }

  // One-time migration: purge all non-MLB-moneyline rfqs from before the filter was added
  try {
    const migKey = 'purge_non_mlb_v1';
    const done = db.prepare(`SELECT key FROM migrations WHERE key = ?`).get(migKey);
    if (!done) {
      db.pragma('foreign_keys = OFF');
      // Delete any RFQ where legs don't all match MLB game moneyline pattern
      const delLegs = db.prepare(`DELETE FROM rfq_leg_prices WHERE rfq_id IN (
        SELECT id FROM rfqs_seen WHERE legs_json NOT LIKE '%MLBGAME%' AND legs_json NOT LIKE '%MLB%GAME%'
      )`).run();
      const delRfqs = db.prepare(`DELETE FROM rfqs_seen WHERE legs_json NOT LIKE '%MLBGAME%' AND legs_json NOT LIKE '%MLB%GAME%'`).run();
      db.pragma('foreign_keys = ON');
      db.prepare(`INSERT INTO migrations (key, applied_at) VALUES (?, ?)`).run(migKey, new Date().toISOString());
      logger.info('Migration: purged non-MLB rfqs', { rfqs: delRfqs.changes, legs: delLegs.changes });
    }
  } catch (err) {
    logger.warn('Non-MLB purge migration failed', { error: String(err) });
  }

  // Auto-purge: delete RFQ data older than 24 hours on every startup
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.pragma('foreign_keys = OFF');
    const legsDel = db.prepare(`DELETE FROM rfq_leg_prices WHERE rfq_id IN (SELECT id FROM rfqs_seen WHERE received_at < ?)`).run(cutoff);
    const rfqDel = db.prepare(`DELETE FROM rfqs_seen WHERE received_at < ?`).run(cutoff);
    db.pragma('foreign_keys = ON');
    if (rfqDel.changes > 0) {
      logger.info('Auto-purge: removed old RFQ data', { rfqs: rfqDel.changes, legs: legsDel.changes });
    }
  } catch (err) {
    logger.warn('Auto-purge failed', { error: String(err) });
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
