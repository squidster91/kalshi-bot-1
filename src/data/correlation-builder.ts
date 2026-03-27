import { getSnapshotTickers, getPriceSnapshots, upsertCorrelation } from '../db/queries';
import { seedDefaultCorrelations } from '../pricing/correlation';
import { logger } from '../logger';

const MIN_SNAPSHOTS = 30;

/**
 * Build/update the correlation matrix from Kalshi orderbook price snapshots.
 * Computes Pearson correlations on mid-price time series for all pairs of markets
 * that have sufficient data. Falls back to the default correlation matrix when
 * there aren't enough historical snapshots.
 */
export async function buildCorrelationMatrix(): Promise<void> {
  logger.info('Building correlation matrix from price snapshots...');

  // Always seed defaults so we have a fallback
  seedDefaultCorrelations();

  try {
    // Look back 7 days for snapshot data
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const tickers = getSnapshotTickers(since);

    if (tickers.length < 2) {
      logger.warn('Not enough tickers with snapshots for correlation computation, using defaults only');
      return;
    }

    logger.info(`Found ${tickers.length} tickers with snapshots`);

    // Load all time series, keyed by ticker
    const seriesMap = new Map<string, Map<string, number>>();
    for (const ticker of tickers) {
      const snapshots = getPriceSnapshots(ticker, since);
      if (snapshots.length < MIN_SNAPSHOTS) continue;

      const tsMap = new Map<string, number>();
      for (const snap of snapshots) {
        // Round timestamp to nearest 5-minute bucket for alignment
        const bucket = roundToFiveMinutes(snap.timestamp);
        tsMap.set(bucket, snap.mid_price);
      }
      seriesMap.set(ticker, tsMap);
    }

    const validTickers = Array.from(seriesMap.keys());
    logger.info(`${validTickers.length} tickers have >= ${MIN_SNAPSHOTS} snapshots`);

    if (validTickers.length < 2) {
      logger.warn('Not enough tickers with sufficient snapshots, using defaults only');
      return;
    }

    let updatedCount = 0;

    // Compute pairwise correlations
    for (let i = 0; i < validTickers.length; i++) {
      for (let j = i + 1; j < validTickers.length; j++) {
        const tickerA = validTickers[i];
        const tickerB = validTickers[j];
        const seriesA = seriesMap.get(tickerA)!;
        const seriesB = seriesMap.get(tickerB)!;

        // Find common timestamps
        const commonTimestamps: string[] = [];
        for (const ts of seriesA.keys()) {
          if (seriesB.has(ts)) {
            commonTimestamps.push(ts);
          }
        }

        if (commonTimestamps.length < MIN_SNAPSHOTS) continue;

        const xVals = commonTimestamps.map((ts) => seriesA.get(ts)!);
        const yVals = commonTimestamps.map((ts) => seriesB.get(ts)!);

        const corr = pearsonCorrelation(xVals, yVals);

        // Only store reasonable correlations
        if (!isNaN(corr) && Math.abs(corr) < 0.95) {
          upsertCorrelation(tickerA, tickerB, corr, commonTimestamps.length);
          updatedCount++;
        }
      }
    }

    logger.info(`Correlation matrix build complete: updated ${updatedCount} pairs`);
  } catch (err) {
    logger.error('Failed to build correlation matrix from snapshots', { error: String(err) });
    logger.info('Falling back to default correlations');
  }
}

/**
 * Round an ISO timestamp string to the nearest 5-minute bucket.
 */
function roundToFiveMinutes(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  const minutes = Math.round(d.getMinutes() / 5) * 5;
  d.setMinutes(minutes, 0, 0);
  return d.toISOString();
}

/**
 * Compute the Pearson correlation coefficient between two numeric arrays.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return 0;
  return cov / denom;
}
