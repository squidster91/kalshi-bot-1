import { LegType, parseLegType } from './marginals';
import { getCorrelation as getDbCorrelation, getAllCorrelations, upsertCorrelation } from '../db/queries';
import { logger } from '../logger';

/**
 * Default pairwise correlations for NBA market types.
 * These are initial estimates to be calibrated from historical data.
 * Positive correlation means both events tend to happen together.
 */
const DEFAULT_CORRELATIONS: Record<string, number> = {
  'moneyline:spread': 0.95,
  'moneyline:total': 0.15,
  'moneyline:player_pts': 0.25,
  'moneyline:player_reb': 0.10,
  'moneyline:player_ast': 0.20,
  'moneyline:player_3pm': 0.15,
  'moneyline:player_other': 0.15,
  'spread:total': 0.10,
  'spread:player_pts': 0.20,
  'spread:player_reb': 0.08,
  'spread:player_ast': 0.15,
  'spread:player_3pm': 0.12,
  'spread:player_other': 0.12,
  'total:player_pts': 0.40,
  'total:player_reb': 0.15,
  'total:player_ast': 0.30,
  'total:player_3pm': 0.25,
  'total:player_other': 0.20,
  'player_pts:player_reb': 0.15,
  'player_pts:player_ast': 0.30,
  'player_pts:player_3pm': 0.35,
  'player_pts:player_other': 0.20,
  'player_reb:player_ast': 0.10,
  'player_reb:player_3pm': 0.05,
  'player_reb:player_other': 0.10,
  'player_ast:player_3pm': 0.15,
  'player_ast:player_other': 0.15,
  'player_3pm:player_other': 0.10,
};

/**
 * Create a canonical key for a pair of leg types (order-independent).
 */
function correlationKey(typeA: LegType, typeB: LegType): string {
  const sorted = [typeA, typeB].sort();
  return `${sorted[0]}:${sorted[1]}`;
}

/**
 * Look up the pairwise correlation for two leg types.
 * First checks the database (calibrated values), then falls back to defaults.
 */
export function getPairwiseCorrelation(typeA: LegType, typeB: LegType): number {
  if (typeA === typeB) return 1.0;

  // Check database first (calibrated values override defaults)
  const dbCorr = getDbCorrelation(typeA, typeB);
  if (dbCorr !== null) return dbCorr;

  // Fall back to defaults
  const key = correlationKey(typeA, typeB);
  const corr = DEFAULT_CORRELATIONS[key];
  if (corr !== undefined) return corr;

  // Unknown pair — assume low correlation
  logger.warn(`No correlation data for pair: ${typeA} / ${typeB}, using 0.10`);
  return 0.10;
}

/**
 * Build a correlation matrix for a set of leg tickers.
 * Returns an N×N matrix where N is the number of legs.
 */
export function buildCorrelationMatrix(tickers: string[]): number[][] {
  const n = tickers.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    const typeI = parseLegType(tickers[i]);

    for (let j = i + 1; j < n; j++) {
      const typeJ = parseLegType(tickers[j]);
      const corr = getPairwiseCorrelation(typeI, typeJ);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }

  return matrix;
}

/**
 * Seed the database with default correlations (useful for initial setup).
 */
export function seedDefaultCorrelations(): void {
  for (const [key, value] of Object.entries(DEFAULT_CORRELATIONS)) {
    const [typeA, typeB] = key.split(':');
    upsertCorrelation(typeA, typeB, value, 0);
  }
  logger.info('Seeded default correlations into database');
}

/**
 * Load all correlations from the database for display/debugging.
 */
export function loadCorrelationMatrix(): Record<string, number> {
  const rows = getAllCorrelations();
  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = correlationKey(row.leg_type_a as LegType, row.leg_type_b as LegType);
    result[key] = row.correlation;
  }
  return result;
}
