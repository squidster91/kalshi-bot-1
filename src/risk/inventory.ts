import { getPositionSummary } from './positions';
import { config } from '../config';

/**
 * Compute inventory skew adjustment for spread.
 * When we're accumulating too much exposure on one side,
 * widen the spread to slow down accumulation.
 */
export function getInventorySkew(eventTicker: string): number {
  const summary = getPositionSummary();
  const eventExposure = summary.exposureByEvent.get(eventTicker) ?? 0;

  // Normalize exposure as fraction of event limit
  const utilization = eventExposure / config.risk.maxExposurePerEvent;

  // Skew increases linearly with utilization
  // At 50% utilization: +1% spread
  // At 80% utilization: +3% spread
  // At 100%: won't quote (handled by risk limits)
  if (utilization < 0.3) return 0;
  if (utilization < 0.5) return 0.01;
  if (utilization < 0.8) return 0.03;
  return 0.05;
}

/**
 * Determine how many contracts to quote based on current inventory.
 * Scale down contract size as we approach limits.
 */
export function getContractSizeAdjustment(
  requestedContracts: number,
  eventTicker: string
): number {
  const summary = getPositionSummary();
  const eventExposure = summary.exposureByEvent.get(eventTicker) ?? 0;
  const totalExposureUtil = summary.totalExposure / config.risk.maxTotalExposure;
  const eventExposureUtil = eventExposure / config.risk.maxExposurePerEvent;

  const maxUtil = Math.max(totalExposureUtil, eventExposureUtil);

  // Scale down contracts as utilization increases
  let scale = 1.0;
  if (maxUtil > 0.7) scale = 0.5;
  else if (maxUtil > 0.5) scale = 0.75;

  const adjusted = Math.max(1, Math.floor(requestedContracts * scale));
  return Math.min(adjusted, config.risk.maxContractsPerQuote);
}
