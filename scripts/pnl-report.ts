/**
 * Generate P&L and performance summary report.
 * Run: npm run pnl
 */

import dotenv from 'dotenv';
dotenv.config();

import { getDb, closeDb } from '../src/db/schema';
import { setLogLevel } from '../src/logger';

async function main(): Promise<void> {
  setLogLevel('warn');

  const db = getDb();

  console.log('\n=== KalshiMM P&L Report ===\n');

  // Overall stats
  const totalRFQs = db.prepare('SELECT COUNT(*) as count FROM rfqs_seen').get() as { count: number };
  const totalQuotes = db.prepare('SELECT COUNT(*) as count FROM quotes_submitted').get() as { count: number };
  const totalFills = db.prepare("SELECT COUNT(*) as count FROM quotes_submitted WHERE status = 'executed'").get() as { count: number };

  console.log('--- Overview ---');
  console.log(`Total RFQs seen: ${totalRFQs.count}`);
  console.log(`Total quotes submitted: ${totalQuotes.count}`);
  console.log(`Total fills: ${totalFills.count}`);
  if (totalQuotes.count > 0) {
    console.log(`Fill rate: ${((totalFills.count / totalQuotes.count) * 100).toFixed(1)}%`);
  }

  // P&L by day
  const dailyPnL = db.prepare(`
    SELECT
      DATE(timestamp) as date,
      SUM(amount) as daily_pnl,
      COUNT(*) as events
    FROM pnl_log
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `).all() as Array<{ date: string; daily_pnl: number; events: number }>;

  if (dailyPnL.length > 0) {
    console.log('\n--- Daily P&L ---');
    let runningTotal = 0;
    for (const day of dailyPnL) {
      runningTotal += day.daily_pnl;
      const pnlStr = day.daily_pnl >= 0
        ? `+$${day.daily_pnl.toFixed(2)}`
        : `-$${Math.abs(day.daily_pnl).toFixed(2)}`;
      console.log(`  ${day.date}  ${pnlStr.padStart(10)}  (running: $${runningTotal.toFixed(2)}, events: ${day.events})`);
    }
    console.log(`\nTotal P&L: $${runningTotal.toFixed(2)}`);
  } else {
    console.log('\nNo P&L data yet.');
  }

  // Open positions
  const positions = db.prepare(`
    SELECT market_ticker, side, contracts, avg_entry_price
    FROM positions WHERE settled = 0 AND contracts > 0
    ORDER BY market_ticker
  `).all() as Array<{ market_ticker: string; side: string; contracts: number; avg_entry_price: number }>;

  if (positions.length > 0) {
    console.log('\n--- Open Positions ---');
    let totalExposure = 0;
    for (const pos of positions) {
      const exposure = pos.side === 'no'
        ? (1 - pos.avg_entry_price) * pos.contracts
        : pos.avg_entry_price * pos.contracts;
      totalExposure += exposure;
      console.log(`  ${pos.market_ticker.padEnd(40)} ${pos.side.padEnd(4)} ${pos.contracts} @ $${pos.avg_entry_price.toFixed(4)}  (exposure: $${exposure.toFixed(2)})`);
    }
    console.log(`\nTotal exposure: $${totalExposure.toFixed(2)}`);
  } else {
    console.log('\nNo open positions.');
  }

  // Quote status distribution
  const statusDist = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM quotes_submitted
    GROUP BY status
    ORDER BY count DESC
  `).all() as Array<{ status: string; count: number }>;

  if (statusDist.length > 0) {
    console.log('\n--- Quote Status Distribution ---');
    for (const s of statusDist) {
      console.log(`  ${s.status.padEnd(20)} ${s.count}`);
    }
  }

  // Average pricing stats on fills
  const pricingStats = db.prepare(`
    SELECT
      AVG(fair_value_computed) as avg_fair,
      AVG(spread_applied) as avg_spread,
      MIN(fair_value_computed) as min_fair,
      MAX(fair_value_computed) as max_fair
    FROM quotes_submitted
    WHERE status = 'executed'
  `).get() as { avg_fair: number | null; avg_spread: number | null; min_fair: number | null; max_fair: number | null };

  if (pricingStats.avg_fair !== null) {
    console.log('\n--- Pricing Stats (Fills Only) ---');
    console.log(`  Avg fair value: $${pricingStats.avg_fair!.toFixed(4)}`);
    console.log(`  Avg spread: ${(pricingStats.avg_spread! * 100).toFixed(2)}%`);
    console.log(`  Fair value range: $${pricingStats.min_fair!.toFixed(4)} - $${pricingStats.max_fair!.toFixed(4)}`);
  }

  closeDb();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
