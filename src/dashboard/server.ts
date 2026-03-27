import express from 'express';
import path from 'path';
import { getDb } from '../db/schema';
import { config } from '../config';
import { getPositionSummary } from '../risk/positions';
import { getRiskUtilization, isKillSwitchActive } from '../risk/limits';
import { getTodayPnL, getTodayStats } from '../db/queries';
import { logger } from '../logger';

const app = express();
const PORT = 3000;

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
    const riskUtil = getRiskUtilization();

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
      risk_utilization: {
        daily_loss: riskUtil.dailyLossUtilization,
        total_exposure: riskUtil.totalExposureUtilization,
        warnings: riskUtil.warnings,
      },
    });
  } catch (err) {
    logger.error('Dashboard /api/stats error', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Recent RFQs ──
app.get('/api/rfqs', (_req, res) => {
  try {
    const db = getDb();
    const rfqs = db.prepare(`
      SELECT id, market_ticker, event_ticker, legs_json, contracts_requested,
             target_cost_dollars, received_at, quoted, quote_id,
             quote_price_yes, quote_price_no, computed_fair_value,
             num_legs, is_same_game
      FROM rfqs_seen
      ORDER BY received_at DESC
      LIMIT 100
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

export function startDashboard(): void {
  app.listen(PORT, () => {
    logger.info(`Dashboard server running at http://localhost:${PORT}`);
  });
}
