import { fetchTeamGameLogs, fetchPlayerGameLogs, computeCorrelations } from './nba-stats';
import { upsertCorrelation } from '../db/queries';
import { seedDefaultCorrelations } from '../pricing/correlation';
import { logger } from '../logger';

/**
 * Build/update the correlation matrix from NBA historical data.
 * This should be run daily or on-demand to keep correlations fresh.
 */
export async function buildCorrelationMatrix(season?: string): Promise<void> {
  logger.info('Building correlation matrix from NBA data...', { season });

  // Start with defaults
  seedDefaultCorrelations();

  try {
    // Fetch historical data
    const [teamGames, playerGames] = await Promise.all([
      fetchTeamGameLogs(season),
      fetchPlayerGameLogs(season),
    ]);

    if (teamGames.length === 0) {
      logger.warn('No team game logs fetched, using defaults only');
      return;
    }

    logger.info('Fetched NBA data', {
      teamGames: teamGames.length,
      playerGames: playerGames.length,
    });

    // Compute empirical correlations
    const correlations = computeCorrelations(teamGames, playerGames);

    // Update database with empirical values
    for (const [key, value] of Object.entries(correlations)) {
      const [typeA, typeB] = key.split(':');
      if (Math.abs(value.correlation) < 0.95 && value.sampleSize > 30) {
        // Only update if reasonable correlation and sufficient sample size
        upsertCorrelation(typeA, typeB, value.correlation, value.sampleSize);
        logger.info(`Updated correlation: ${key} = ${value.correlation.toFixed(4)} (n=${value.sampleSize})`);
      }
    }

    logger.info('Correlation matrix build complete');
  } catch (err) {
    logger.error('Failed to build correlation matrix', { error: String(err) });
    logger.info('Falling back to default correlations');
  }
}
