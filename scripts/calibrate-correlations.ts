/**
 * Offline script to build/update the correlation matrix from Kalshi price snapshots.
 * Run: npm run calibrate
 */

import dotenv from 'dotenv';
dotenv.config();

import { getDb, closeDb } from '../src/db/schema';
import { buildCorrelationMatrix } from '../src/data/correlation-builder';
import { loadCorrelationMatrix } from '../src/pricing/correlation';
import { getSnapshotTickers } from '../src/db/queries';
import { setLogLevel } from '../src/logger';

async function main(): Promise<void> {
  setLogLevel('info');

  console.log('\nCalibrating correlations from Kalshi price snapshots\n');

  // Initialize database
  getDb();

  // Show snapshot stats
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const tickers = getSnapshotTickers(since7d);
  console.log(`Tickers with snapshots (last 7 days): ${tickers.length}`);

  // Build correlations from price snapshots
  await buildCorrelationMatrix();

  // Display results
  const matrix = loadCorrelationMatrix();
  console.log('\n=== Correlation Matrix ===\n');

  const entries = Object.entries(matrix).sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));
  for (const [key, value] of entries) {
    const bar = '\u2588'.repeat(Math.round(Math.abs(value) * 20));
    const sign = value >= 0 ? '+' : '-';
    console.log(`  ${key.padEnd(35)} ${sign}${Math.abs(value).toFixed(4)}  ${bar}`);
  }

  console.log(`\nTotal pairs: ${entries.length}`);

  closeDb();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
