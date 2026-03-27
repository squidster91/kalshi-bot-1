import { getDb } from './schema';
import { MVELeg } from '../api/rest';

// ── RFQs ──

export interface RFQRecord {
  id: string;
  market_ticker: string;
  event_ticker: string;
  legs_json: string;
  contracts_requested: string;
  target_cost_dollars: string;
  received_at: string;
  quoted: number;
  quote_id: string | null;
  quote_price_yes: string | null;
  quote_price_no: string | null;
  computed_fair_value: number | null;
  num_legs: number;
  is_same_game: number;
}

export function insertRFQ(rfq: {
  id: string;
  market_ticker: string;
  event_ticker: string;
  legs: MVELeg[];
  contracts_requested: string;
  target_cost_dollars: string;
  computed_fair_value?: number;
}): void {
  const db = getDb();
  const legs = rfq.legs;
  const eventTickers = new Set(legs.map((l) => l.event_ticker));
  const isSameGame = eventTickers.size === 1 ? 1 : 0;

  db.prepare(`
    INSERT OR IGNORE INTO rfqs_seen
      (id, market_ticker, event_ticker, legs_json, contracts_requested,
       target_cost_dollars, received_at, computed_fair_value, num_legs, is_same_game)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rfq.id,
    rfq.market_ticker,
    rfq.event_ticker,
    JSON.stringify(legs),
    rfq.contracts_requested,
    rfq.target_cost_dollars,
    new Date().toISOString(),
    rfq.computed_fair_value ?? null,
    legs.length,
    isSameGame
  );
}

export function markRFQQuoted(rfqId: string, quoteId: string, priceYes: string, priceNo: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE rfqs_seen SET quoted = 1, quote_id = ?, quote_price_yes = ?, quote_price_no = ?
    WHERE id = ?
  `).run(quoteId, priceYes, priceNo, rfqId);
}

// ── Quotes ──

export interface QuoteRecord {
  id: string;
  rfq_id: string;
  yes_bid_dollars: string;
  no_bid_dollars: string;
  yes_contracts: string;
  no_contracts: string;
  fair_value_computed: number;
  spread_applied: number;
  status: string;
  submitted_at: string;
  accepted_at: string | null;
  confirmed_at: string | null;
  executed_at: string | null;
}

export function insertQuote(quote: {
  id: string;
  rfq_id: string;
  yes_bid_dollars: string;
  no_bid_dollars: string;
  yes_contracts: string;
  no_contracts: string;
  fair_value_computed: number;
  spread_applied: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO quotes_submitted
      (id, rfq_id, yes_bid_dollars, no_bid_dollars, yes_contracts, no_contracts,
       fair_value_computed, spread_applied, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    quote.id,
    quote.rfq_id,
    quote.yes_bid_dollars,
    quote.no_bid_dollars,
    quote.yes_contracts,
    quote.no_contracts,
    quote.fair_value_computed,
    quote.spread_applied,
    new Date().toISOString()
  );
}

export function updateQuoteStatus(
  quoteId: string,
  status: string,
  timestampField?: 'accepted_at' | 'confirmed_at' | 'executed_at'
): void {
  const db = getDb();
  if (timestampField) {
    db.prepare(`UPDATE quotes_submitted SET status = ?, ${timestampField} = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), quoteId);
  } else {
    db.prepare(`UPDATE quotes_submitted SET status = ? WHERE id = ?`)
      .run(status, quoteId);
  }
}

// ── Positions ──

export function upsertPosition(pos: {
  market_ticker: string;
  event_ticker: string;
  side: string;
  contracts: number;
  avg_entry_price: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO positions (market_ticker, event_ticker, side, contracts, avg_entry_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_ticker) DO UPDATE SET
      side = excluded.side,
      contracts = excluded.contracts,
      avg_entry_price = excluded.avg_entry_price,
      updated_at = excluded.updated_at
  `).run(
    pos.market_ticker,
    pos.event_ticker,
    pos.side,
    pos.contracts,
    pos.avg_entry_price,
    new Date().toISOString()
  );
}

export function getOpenPositions(): Array<{
  market_ticker: string;
  event_ticker: string;
  side: string;
  contracts: number;
  avg_entry_price: number;
}> {
  const db = getDb();
  return db.prepare(`
    SELECT market_ticker, event_ticker, side, contracts, avg_entry_price
    FROM positions WHERE settled = 0 AND contracts > 0
  `).all() as Array<{
    market_ticker: string;
    event_ticker: string;
    side: string;
    contracts: number;
    avg_entry_price: number;
  }>;
}

export function getPositionsByEvent(eventTicker: string): Array<{
  market_ticker: string;
  side: string;
  contracts: number;
  avg_entry_price: number;
}> {
  const db = getDb();
  return db.prepare(`
    SELECT market_ticker, side, contracts, avg_entry_price
    FROM positions WHERE event_ticker = ? AND settled = 0
  `).all(eventTicker) as Array<{
    market_ticker: string;
    side: string;
    contracts: number;
    avg_entry_price: number;
  }>;
}

// ── P&L ──

export function logPnL(entry: {
  event_type: string;
  market_ticker?: string;
  rfq_id?: string;
  amount: number;
  running_balance?: number;
  details?: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO pnl_log (timestamp, event_type, market_ticker, rfq_id, amount, running_balance, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    entry.event_type,
    entry.market_ticker ?? null,
    entry.rfq_id ?? null,
    entry.amount,
    entry.running_balance ?? null,
    entry.details ?? null
  );
}

export function getDailyPnL(date: string): number {
  const db = getDb();
  const result = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM pnl_log WHERE timestamp LIKE ? || '%'
  `).get(date) as { total: number };
  return result.total;
}

export function getTodayPnL(): number {
  const today = new Date().toISOString().slice(0, 10);
  return getDailyPnL(today);
}

// ── Correlations ──

export function upsertCorrelation(
  legTypeA: string,
  legTypeB: string,
  correlation: number,
  sampleSize: number
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO correlation_matrix (leg_type_a, leg_type_b, correlation, sample_size, last_updated)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(leg_type_a, leg_type_b) DO UPDATE SET
      correlation = excluded.correlation,
      sample_size = excluded.sample_size,
      last_updated = excluded.last_updated
  `).run(legTypeA, legTypeB, correlation, sampleSize, new Date().toISOString());
}

export function getCorrelation(legTypeA: string, legTypeB: string): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT correlation FROM correlation_matrix
    WHERE (leg_type_a = ? AND leg_type_b = ?) OR (leg_type_a = ? AND leg_type_b = ?)
  `).get(legTypeA, legTypeB, legTypeB, legTypeA) as { correlation: number } | undefined;
  return row?.correlation ?? null;
}

export function getAllCorrelations(): Array<{
  leg_type_a: string;
  leg_type_b: string;
  correlation: number;
}> {
  const db = getDb();
  return db.prepare(`SELECT leg_type_a, leg_type_b, correlation FROM correlation_matrix`)
    .all() as Array<{ leg_type_a: string; leg_type_b: string; correlation: number }>;
}

// ── Price Snapshots ──

export function insertPriceSnapshot(ticker: string, midPrice: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO price_snapshots (ticker, mid_price, timestamp)
    VALUES (?, ?, ?)
  `).run(ticker, midPrice, new Date().toISOString());
}

export function getPriceSnapshots(
  ticker: string,
  since: string
): Array<{ mid_price: number; timestamp: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT mid_price, timestamp FROM price_snapshots
    WHERE ticker = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(ticker, since) as Array<{ mid_price: number; timestamp: string }>;
}

export function getSnapshotTickers(since: string): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT ticker FROM price_snapshots
    WHERE timestamp >= ?
  `).all(since) as Array<{ ticker: string }>;
  return rows.map((r) => r.ticker);
}

// ── Daily Summary ──

export function getTodayStats(): {
  rfqs_seen: number;
  quotes_submitted: number;
  quotes_filled: number;
} {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const rfqs = db.prepare(`
    SELECT COUNT(*) as count FROM rfqs_seen WHERE received_at LIKE ? || '%'
  `).get(today) as { count: number };

  const quotes = db.prepare(`
    SELECT COUNT(*) as count FROM quotes_submitted WHERE submitted_at LIKE ? || '%'
  `).get(today) as { count: number };

  const filled = db.prepare(`
    SELECT COUNT(*) as count FROM quotes_submitted
    WHERE submitted_at LIKE ? || '%' AND status = 'executed'
  `).get(today) as { count: number };

  return {
    rfqs_seen: rfqs.count,
    quotes_submitted: quotes.count,
    quotes_filled: filled.count,
  };
}
