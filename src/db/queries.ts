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
  creator_id?: string;
}): void {
  const db = getDb();
  const legs = rfq.legs;
  const eventTickers = new Set(legs.map((l) => l.event_ticker));
  const isSameGame = eventTickers.size === 1 ? 1 : 0;

  const playerPropPattern = /PTS|REB|AST|3PM|TPM|STL|BLK/i;
  const hasPlayerProps = legs.some(l => l.market_ticker && playerPropPattern.test(l.market_ticker)) ? 1 : 0;

  db.prepare(`
    INSERT OR IGNORE INTO rfqs_seen
      (id, market_ticker, event_ticker, legs_json, contracts_requested,
       target_cost_dollars, received_at, computed_fair_value, num_legs, is_same_game, has_player_props, creator_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    isSameGame,
    hasPlayerProps,
    rfq.creator_id ?? null
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
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
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

// ── Price Cache ──

export function upsertPriceCache(ticker: string, midPrice: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO price_cache (ticker, mid_price, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET mid_price = excluded.mid_price, updated_at = excluded.updated_at
  `).run(ticker, midPrice, new Date().toISOString());
}

// ── Known Bots ──

export function loadKnownBots(): Set<string> {
  const db = getDb();
  const rows = db.prepare(`SELECT creator_id FROM known_bots`).all() as Array<{ creator_id: string }>;
  return new Set(rows.map(r => r.creator_id));
}

export function saveKnownBot(creatorId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO known_bots (creator_id, first_detected, rfq_count)
    VALUES (?, ?, 1)
    ON CONFLICT(creator_id) DO UPDATE SET rfq_count = rfq_count + 1
  `).run(creatorId, new Date().toISOString());
}

// ── Daily Qualified RFQ Tracking ──

export function incrementDailyQualified(budgetDollars: number): void {
  const db = getDb();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const budgetCents = Math.round(budgetDollars * 100);
  db.prepare(`
    INSERT INTO daily_qualified (date, qualified_count, qualified_budget_cents)
    VALUES (?, 1, ?)
    ON CONFLICT(date) DO UPDATE SET
      qualified_count = qualified_count + 1,
      qualified_budget_cents = qualified_budget_cents + ?
  `).run(today, budgetCents, budgetCents);
}

export function getDailyQualified(date?: string): { qualified_count: number; qualified_budget_cents: number } {
  const db = getDb();
  const d = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const row = db.prepare(`
    SELECT qualified_count, qualified_budget_cents FROM daily_qualified WHERE date = ?
  `).get(d) as { qualified_count: number; qualified_budget_cents: number } | undefined;
  return row || { qualified_count: 0, qualified_budget_cents: 0 };
}

// ── Price Cache ──

export function loadPriceCache(): Map<string, { mid: number; ts: number }> {
  const db = getDb();
  const rows = db.prepare(`SELECT ticker, mid_price, updated_at FROM price_cache`).all() as Array<{
    ticker: string;
    mid_price: number;
    updated_at: string;
  }>;
  const cache = new Map<string, { mid: number; ts: number }>();
  for (const row of rows) {
    cache.set(row.ticker, { mid: row.mid_price, ts: new Date(row.updated_at).getTime() });
  }
  return cache;
}

// ── RFQ Outcomes ──

export function insertRFQLegPrices(
  rfqId: string,
  legs: Array<{ ticker: string; side: string; midPrice: number | null }>
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO rfq_leg_prices (rfq_id, leg_ticker, leg_side, mid_price_at_rfq)
    VALUES (?, ?, ?, ?)
  `);
  for (const leg of legs) {
    stmt.run(rfqId, leg.ticker, leg.side, leg.midPrice);
  }
}

export function updateRFQLegLatestPrice(legTicker: string, midPrice: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE rfq_leg_prices SET latest_mid_price = ?, latest_price_at = ?
    WHERE leg_ticker = ? AND settled = 0
  `).run(midPrice, new Date().toISOString(), legTicker);
}

export function markRFQDeleted(rfqId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE rfqs_seen SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL
  `).run(now, rfqId);

  // Calculate lifespan
  const row = db.prepare(`
    SELECT received_at FROM rfqs_seen WHERE id = ?
  `).get(rfqId) as { received_at: string } | undefined;

  if (row) {
    const lifespan = new Date(now).getTime() - new Date(row.received_at).getTime();
    db.prepare(`UPDATE rfqs_seen SET lifespan_ms = ? WHERE id = ?`).run(lifespan, rfqId);
  }
}

export function saveRFQLegPricesSnapshot(rfqId: string, snapshot: Record<string, number>): void {
  const db = getDb();
  db.prepare(`UPDATE rfqs_seen SET leg_prices_snapshot = ? WHERE id = ?`)
    .run(JSON.stringify(snapshot), rfqId);
}

export function getRFQsWithOutcomes(limit = 200): Array<Record<string, unknown>> {
  const db = getDb();
  return db.prepare(`
    SELECT
      r.id, r.market_ticker, r.event_ticker, r.legs_json,
      r.contracts_requested, r.target_cost_dollars,
      r.received_at, r.deleted_at, r.lifespan_ms,
      r.num_legs, r.is_same_game, r.quoted,
      r.leg_prices_snapshot,
      r.computed_fair_value
    FROM rfqs_seen r
    ORDER BY r.received_at DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
}

export function getRFQLegPrices(rfqId: string): Array<{
  leg_ticker: string;
  leg_side: string;
  mid_price_at_rfq: number | null;
  latest_mid_price: number | null;
  settled: number;
  settlement_result: string | null;
}> {
  const db = getDb();
  return db.prepare(`
    SELECT leg_ticker, leg_side, mid_price_at_rfq, latest_mid_price, settled, settlement_result
    FROM rfq_leg_prices WHERE rfq_id = ?
  `).all(rfqId) as Array<{
    leg_ticker: string;
    leg_side: string;
    mid_price_at_rfq: number | null;
    latest_mid_price: number | null;
    settled: number;
    settlement_result: string | null;
  }>;
}

export function getRFQOutcomeStats(): {
  total_rfqs: number;
  avg_lifespan_ms: number;
  rfqs_with_prices: number;
  avg_legs: number;
  rfqs_by_hour: Array<{ hour: number; count: number }>;
} {
  const db = getDb();

  const total = db.prepare(`SELECT COUNT(*) as c FROM rfqs_seen`).get() as { c: number };

  const lifespan = db.prepare(`
    SELECT AVG(lifespan_ms) as avg_ms FROM rfqs_seen WHERE lifespan_ms IS NOT NULL
  `).get() as { avg_ms: number | null };

  const withPrices = db.prepare(`
    SELECT COUNT(DISTINCT rfq_id) as c FROM rfq_leg_prices WHERE mid_price_at_rfq IS NOT NULL
  `).get() as { c: number };

  const avgLegs = db.prepare(`
    SELECT AVG(num_legs) as avg FROM rfqs_seen WHERE num_legs > 0
  `).get() as { avg: number | null };

  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', received_at) AS INTEGER) as hour, COUNT(*) as count
    FROM rfqs_seen
    GROUP BY strftime('%H', received_at)
    ORDER BY hour
  `).all() as Array<{ hour: number; count: number }>;

  return {
    total_rfqs: total.c,
    avg_lifespan_ms: lifespan.avg_ms ?? 0,
    rfqs_with_prices: withPrices.c,
    avg_legs: avgLegs.avg ?? 0,
    rfqs_by_hour: byHour,
  };
}

// ── Daily Summary ──

export function getTodayStats(): {
  rfqs_seen: number;
  quotes_submitted: number;
  quotes_filled: number;
} {
  const db = getDb();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

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
