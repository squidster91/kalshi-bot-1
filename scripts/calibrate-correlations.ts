/**
 * Offline script to build/update the correlation matrix from NBA historical data.
 * Run: npm run calibrate
 */

import dotenv from 'dotenv';
dotenv.config();

import { getDb, closeDb } from '../src/db/schema';
import { buildCorrelationMatrix } from '../src/data/correlation-builder';
import { loadCorrelationMatrix } from '../src/pricing/correlation';
import { setLogLevel } from '../src/logger';

async function main(): Promise<void> {
  setLogLevel('info');

  const season = process.argv[2] || '2025-26';
  console.log(`\nCalibrating correlations for season: ${season}\n`);

  // Initialize database
  getDb();

  // Build correlations from NBA data
  await buildCorrelationMatrix(season);

  // Display results
  const matrix = loadCorrelationMatrix();
  console.log('\n=== Correlation Matrix ===\n');

  const entries = Object.entries(matrix).sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));
  for (const [key, value] of entries) {
    const bar = '█'.repeat(Math.round(Math.abs(value) * 20));
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
