import express from 'express';
import path from 'path';
import { getDb } from '../db/schema';
import { config } from '../config';
import { getPositionSummary } from '../risk/positions';
import { getRiskUtilization, isKillSwitchActive } from '../risk/limits';
import { getTodayPnL, getTodayStats, getRFQsWithOutcomes, getRFQLegPrices, getRFQOutcomeStats } from '../db/queries';
import { logger } from '../logger';

const app = express();
const PORT = 3000;

const serverStartTime = Date.now();

// Serve static dashboard
app.get('/', (_req, res) => {
  // HTML file stays in src/, not compiled to dist/
  const htmlPath = path.join(__dirname, '..', '..', 'src', 'dashboard', 'index.html');
  res.sendFile(htmlPath);
});

// ── API: Today's stats ──
app.get('/api/stats', (_req, res) => {
  try {
    const stats = getTodayStats();
    const pnl = getTodayPnL();

    let balance: number | null = null;
    try {
      const db = getDb();
      const row = db.prepare(`
        SELECT running_balance FROM pnl_log
        WHERE running_balance IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get() as { running_balance: number } | undefined;
      balance = row?.running_balance ?? config.risk.startingBankroll;
    } catch {
      balance = config.risk.startingBankroll;
    }

    res.json({
      rfqs_seen: stats.rfqs_seen,
      quotes_submitted: stats.quotes_submitted,
      quotes_filled: stats.quotes_filled,
      today_pnl: pnl,
      balance,
      paper_mode: config.bot.paperMode,
      quoting_enabled: config.bot.quotingEnabled,
      env: config.kalshi.env,
      kill_switch: isKillSwitchActive(),
      uptime_ms: Date.now() - serverStartTime,
      risk_utilization: {
        daily_loss: getRiskUtilization().dailyLossUtilization,
        total_exposure: getRiskUtilization().totalExposureUtilization,
        warnings: getRiskUtilization().warnings,
      },
    });
  } catch (err) {
    logger.error('Dashboard /api/stats error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Recent RFQs (increased to 500) ──
app.get('/api/rfqs', (_req, res) => {
  try {
    const db = getDb();
    const rfqs = db.prepare(`
      SELECT id, market_ticker, event_ticker, legs_json, contracts_requested,
             target_cost_dollars, received_at, quoted, quote_id,
             quote_price_yes, quote_price_no, computed_fair_value,
             num_legs, is_same_game, leg_prices_snapshot
      FROM rfqs_seen
      ORDER BY received_at DESC
      LIMIT 500
    `).all();
    res.json(rfqs);
  } catch (err) {
    logger.error('Dashboard /api/rfqs error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Recent quotes ──
app.get('/api/quotes', (_req, res) => {
  try {
    const db = getDb();
    const quotes = db.prepare(`
      SELECT q.id, q.rfq_id, q.yes_bid_dollars, q.no_bid_dollars,
             q.yes_contracts, q.no_contracts, q.fair_value_computed,
             q.spread_applied, q.status, q.submitted_at,
             q.accepted_at, q.confirmed_at, q.executed_at,
             r.market_ticker, r.event_ticker, r.num_legs
      FROM quotes_submitted q
      LEFT JOIN rfqs_seen r ON q.rfq_id = r.id
      ORDER BY q.submitted_at DESC
      LIMIT 100
    `).all();
    res.json(quotes);
  } catch (err) {
    logger.error('Dashboard /api/quotes error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Daily P&L history ──
app.get('/api/pnl', (_req, res) => {
  try {
    const db = getDb();

    // Try daily_pnl table first, fall back to pnl_log aggregation
    let dailyPnl = db.prepare(`
      SELECT date, net_pnl, gross_pnl, fees_paid,
             rfqs_seen, quotes_submitted, quotes_filled
      FROM daily_pnl
      ORDER BY date DESC
      LIMIT 90
    `).all() as Array<Record<string, unknown>>;

    if (dailyPnl.length === 0) {
      // Aggregate from pnl_log
      dailyPnl = db.prepare(`
        SELECT
          DATE(timestamp) as date,
          SUM(amount) as net_pnl,
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as gross_pnl,
          0 as fees_paid
        FROM pnl_log
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
        LIMIT 90
      `).all() as Array<Record<string, unknown>>;
    }

    res.json(dailyPnl);
  } catch (err) {
    logger.error('Dashboard /api/pnl error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Risk utilization ──
app.get('/api/risk', (_req, res) => {
  try {
    const summary = getPositionSummary();
    const riskUtil = getRiskUtilization();

    const exposureByEvent: Array<{
      event_ticker: string;
      exposure: number;
      limit: number;
      utilization: number;
    }> = [];

    for (const [event, exposure] of summary.exposureByEvent) {
      exposureByEvent.push({
        event_ticker: event,
        exposure,
        limit: config.risk.maxExposurePerEvent,
        utilization: exposure / config.risk.maxExposurePerEvent,
      });
    }

    res.json({
      total_exposure: summary.totalExposure,
      max_total_exposure: config.risk.maxTotalExposure,
      total_utilization: riskUtil.totalExposureUtilization,
      daily_loss_utilization: riskUtil.dailyLossUtilization,
      max_daily_loss: config.risk.maxDailyLoss,
      today_pnl: getTodayPnL(),
      exposure_by_event: exposureByEvent,
      warnings: riskUtil.warnings,
      kill_switch: isKillSwitchActive(),
      limits: {
        max_contracts_per_quote: config.risk.maxContractsPerQuote,
        max_daily_loss: config.risk.maxDailyLoss,
        max_exposure_per_event: config.risk.maxExposurePerEvent,
        max_total_exposure: config.risk.maxTotalExposure,
        starting_bankroll: config.risk.startingBankroll,
      },
    });
  } catch (err) {
    logger.error('Dashboard /api/risk error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Open positions ──
app.get('/api/positions', (_req, res) => {
  try {
    const summary = getPositionSummary();
    res.json({
      total_positions: summary.totalPositions,
      total_exposure: summary.totalExposure,
      positions: summary.positions,
    });
  } catch (err) {
    logger.error('Dashboard /api/positions error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: RFQ volume per hour (last 24h) ──
app.get('/api/rfq-volume', (_req, res) => {
  try {
    const db = getDb();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:00:00', received_at) as hour,
        COUNT(*) as count
      FROM rfqs_seen
      WHERE received_at >= ?
      GROUP BY strftime('%Y-%m-%dT%H:00:00', received_at)
      ORDER BY hour ASC
    `).all(since) as Array<{ hour: string; count: number }>;

    // Fill in missing hours with zero
    const result: Array<{ hour: string; label: string; count: number }> = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - i);
      const hourKey = d.toISOString().slice(0, 13) + ':00:00';
      const label = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const match = rows.find(r => r.hour === hourKey);
      result.push({
        hour: hourKey,
        label,
        count: match ? match.count : 0,
      });
    }

    res.json(result);
  } catch (err) {
    logger.error('Dashboard /api/rfq-volume error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: RFQ categories breakdown ──
app.get('/api/rfq-categories', (_req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);

    const rows = db.prepare(`
      SELECT market_ticker, COUNT(*) as count
      FROM rfqs_seen
      WHERE received_at LIKE ? || '%'
      GROUP BY market_ticker
    `).all(today) as Array<{ market_ticker: string; count: number }>;

    // Aggregate by category parsed from ticker prefix
    const categories: Record<string, number> = {};
    let totalLegs = 0;
    let totalRfqs = 0;

    const allRows = db.prepare(`
      SELECT num_legs FROM rfqs_seen WHERE received_at LIKE ? || '%'
    `).all(today) as Array<{ num_legs: number | null }>;

    for (const r of allRows) {
      totalRfqs++;
      totalLegs += r.num_legs || 0;
    }

    for (const row of rows) {
      const cat = parseCategory(row.market_ticker || '');
      categories[cat] = (categories[cat] || 0) + row.count;
    }

    res.json({
      categories,
      avg_legs: totalRfqs > 0 ? totalLegs / totalRfqs : 0,
      total_rfqs: totalRfqs,
    });
  } catch (err) {
    logger.error('Dashboard /api/rfq-categories error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Parse a market ticker into a human-readable category
function parseCategory(ticker: string): string {
  if (!ticker) return 'Unknown';
  const t = ticker.toUpperCase();

  // Multi-event combos
  if (t.startsWith('KXMVE-') || t.includes('CROSS')) return 'Cross-Category';

  // KX prefix combos
  if (t.startsWith('KX')) {
    if (t.includes('NBA')) return 'NBA Multi-Game';
    if (t.includes('NFL')) return 'NFL Multi-Game';
    if (t.includes('MLB')) return 'MLB Multi-Game';
    if (t.includes('NHL')) return 'NHL Multi-Game';
    if (t.includes('SOCCER') || t.includes('MLS') || t.includes('EPL')) return 'Soccer Multi-Game';
    if (t.includes('NCAAB') || t.includes('CBB')) return 'NCAAB Multi-Game';
    if (t.includes('NCAAF') || t.includes('CFB')) return 'NCAAF Multi-Game';
    return 'Multi-Game Combo';
  }

  // Single-event sport tickers
  if (t.includes('NBA')) return 'NBA Game';
  if (t.includes('NFL')) return 'NFL Game';
  if (t.includes('MLB')) return 'MLB Game';
  if (t.includes('NHL')) return 'NHL Game';
  if (t.includes('SOCCER') || t.includes('MLS') || t.includes('EPL')) return 'Soccer';
  if (t.includes('NCAAB') || t.includes('CBB')) return 'NCAAB';
  if (t.includes('NCAAF') || t.includes('CFB')) return 'NCAAF';

  // Non-sports
  if (t.includes('PRES') || t.includes('ELECT') || t.includes('GOV')) return 'Politics';
  if (t.includes('CPI') || t.includes('GDP') || t.includes('ECON') || t.includes('FED')) return 'Economics';
  if (t.includes('WEATHER') || t.includes('TEMP')) return 'Weather';
  if (t.includes('CRYPTO') || t.includes('BTC') || t.includes('ETH')) return 'Crypto';

  return 'Other';
}

// ── Outcomes page ──
app.get('/outcomes', (_req, res) => {
  const htmlPath = path.join(__dirname, '..', '..', 'src', 'dashboard', 'outcomes.html');
  res.sendFile(htmlPath);
});

// ── API: RFQ outcomes for backtesting ──
app.get('/api/outcomes', (_req, res) => {
  try {
    const rfqs = getRFQsWithOutcomes(500);
    res.json(rfqs);
  } catch (err) {
    logger.error('Dashboard /api/outcomes error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Leg prices for a specific RFQ ──
app.get('/api/outcomes/:rfqId/legs', (req, res) => {
  try {
    const legs = getRFQLegPrices(req.params.rfqId);
    res.json(legs);
  } catch (err) {
    logger.error('Dashboard /api/outcomes/:rfqId/legs error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Outcome statistics ──
app.get('/api/outcome-stats', (_req, res) => {
  try {
    const stats = getRFQOutcomeStats();
    res.json(stats);
  } catch (err) {
    logger.error('Dashboard /api/outcome-stats error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Simulated P&L - what if we'd filled at target cost? ──
app.get('/api/backtest', (_req, res) => {
  try {
    const db = getDb();

    // Get all RFQs with leg price data
    const rfqs = db.prepare(`
      SELECT r.id, r.target_cost_dollars, r.contracts_requested,
             r.num_legs, r.received_at, r.lifespan_ms, r.leg_prices_snapshot,
             r.market_ticker
      FROM rfqs_seen r
      WHERE r.leg_prices_snapshot IS NOT NULL
      ORDER BY r.received_at DESC
      LIMIT 1000
    `).all() as Array<Record<string, unknown>>;

    let totalSimulatedPnl = 0;
    let rfqsAnalyzed = 0;
    let rfqsProfitable = 0;
    const dailyPnl: Record<string, number> = {};

    for (const rfq of rfqs) {
      const snapshot = rfq.leg_prices_snapshot as string;
      if (!snapshot) continue;

      let prices: Record<string, number>;
      try { prices = JSON.parse(snapshot); } catch { continue; }

      const targetCost = parseFloat(rfq.target_cost_dollars as string) || 0;
      if (targetCost <= 0) continue;

      // Compute naive fair value as product of leg probabilities
      const legPriceValues = Object.values(prices);
      if (legPriceValues.length === 0) continue;

      let fairValue = 1;
      for (const p of legPriceValues) {
        fairValue *= p;
      }

      // Simulated edge: what the RFQ buyer was willing to pay vs fair value
      // If target_cost > fair_value, they're overpaying → we'd profit
      const edge = targetCost - fairValue;

      totalSimulatedPnl += edge;
      rfqsAnalyzed++;
      if (edge > 0) rfqsProfitable++;

      const date = (rfq.received_at as string).slice(0, 10);
      dailyPnl[date] = (dailyPnl[date] || 0) + edge;
    }

    const dailyEntries = Object.entries(dailyPnl)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pnl]) => ({ date, pnl: Math.round(pnl * 100) / 100 }));

    res.json({
      rfqs_analyzed: rfqsAnalyzed,
      rfqs_profitable: rfqsProfitable,
      win_rate: rfqsAnalyzed > 0 ? rfqsProfitable / rfqsAnalyzed : 0,
      total_simulated_pnl: Math.round(totalSimulatedPnl * 100) / 100,
      avg_edge_per_rfq: rfqsAnalyzed > 0 ? Math.round((totalSimulatedPnl / rfqsAnalyzed) * 10000) / 10000 : 0,
      daily_pnl: dailyEntries,
    });
  } catch (err) {
    logger.error('Dashboard /api/backtest error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export function startDashboard(): void {
  app.listen(PORT, () => {
    logger.info(`Dashboard server running at http://localhost:${PORT}`);
  });
}
