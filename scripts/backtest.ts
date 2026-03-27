/**
 * Replay historical RFQs against our pricing model to evaluate performance.
 * Run: npm run backtest
 */

import dotenv from 'dotenv';
dotenv.config();

import { getDb, closeDb } from '../src/db/schema';
import { setLogLevel } from '../src/logger';

interface RFQRecord {
  id: string;
  market_ticker: string;
  legs_json: string;
  contracts_requested: string;
  target_cost_dollars: string;
  computed_fair_value: number | null;
  quote_price_yes: string | null;
  received_at: string;
  num_legs: number;
  is_same_game: number;
}

async function main(): Promise<void> {
  setLogLevel('warn');

  const db = getDb();

  // Fetch all logged RFQs
  const rfqs = db.prepare(`
    SELECT * FROM rfqs_seen ORDER BY received_at ASC
  `).all() as RFQRecord[];

  if (rfqs.length === 0) {
    console.log('No historical RFQs found. Run the bot in paper mode first to collect RFQ data.');
    closeDb();
    return;
  }

  console.log(`\n=== Backtest Results ===\n`);
  console.log(`Total RFQs: ${rfqs.length}`);

  // Analyze pricing
  let totalWithFairValue = 0;
  let totalQuoted = 0;
  let sumSpread = 0;
  let targetBelowFair = 0;
  let targetAboveFair = 0;

  const legDistribution = new Map<number, number>();
  let sameGameCount = 0;

  for (const rfq of rfqs) {
    const numLegs = rfq.num_legs;
    legDistribution.set(numLegs, (legDistribution.get(numLegs) ?? 0) + 1);

    if (rfq.is_same_game) sameGameCount++;

    if (rfq.computed_fair_value !== null && rfq.computed_fair_value > 0) {
      totalWithFairValue++;
      const targetCost = parseFloat(rfq.target_cost_dollars);

      if (targetCost < rfq.computed_fair_value) {
        targetBelowFair++;
      } else {
        targetAboveFair++;
      }

      if (rfq.quote_price_yes) {
        totalQuoted++;
        const quotePrice = parseFloat(rfq.quote_price_yes);
        sumSpread += rfq.computed_fair_value - quotePrice;
      }
    }
  }

  console.log(`\nRFQs with fair value computed: ${totalWithFairValue}`);
  console.log(`RFQs quoted: ${totalQuoted}`);

  console.log(`\n--- Leg Distribution ---`);
  for (const [legs, count] of [...legDistribution.entries()].sort()) {
    console.log(`  ${legs}-leg combos: ${count} (${((count / rfqs.length) * 100).toFixed(1)}%)`);
  }

  console.log(`\nSame-game combos: ${sameGameCount} (${((sameGameCount / rfqs.length) * 100).toFixed(1)}%)`);

  if (totalWithFairValue > 0) {
    console.log(`\n--- Pricing Analysis ---`);
    console.log(`Target below fair value: ${targetBelowFair} (${((targetBelowFair / totalWithFairValue) * 100).toFixed(1)}%)`);
    console.log(`Target above fair value: ${targetAboveFair} (${((targetAboveFair / totalWithFairValue) * 100).toFixed(1)}%)`);
  }

  if (totalQuoted > 0) {
    console.log(`Average spread captured: ${(sumSpread / totalQuoted).toFixed(4)} ($${((sumSpread / totalQuoted) * 100).toFixed(2)} per $100)`);
  }

  // Analyze fills
  const fills = db.prepare(`
    SELECT COUNT(*) as count, AVG(fair_value_computed) as avg_fair, AVG(spread_applied) as avg_spread
    FROM quotes_submitted WHERE status = 'executed'
  `).get() as { count: number; avg_fair: number; avg_spread: number };

  if (fills.count > 0) {
    console.log(`\n--- Fill Analysis ---`);
    console.log(`Total fills: ${fills.count}`);
    console.log(`Fill rate: ${((fills.count / totalQuoted) * 100).toFixed(1)}%`);
    console.log(`Avg fair value on fills: ${fills.avg_fair.toFixed(4)}`);
    console.log(`Avg spread on fills: ${fills.avg_spread.toFixed(4)}`);
  }

  closeDb();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
