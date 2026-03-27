import { getOpenPositions, upsertPosition, getPositionsByEvent } from '../db/queries';
import { logger } from '../logger';

export interface PositionSummary {
  totalPositions: number;
  totalExposure: number;
  exposureByEvent: Map<string, number>;
  positions: Array<{
    market_ticker: string;
    event_ticker: string;
    side: string;
    contracts: number;
    avg_entry_price: number;
    exposure: number;
  }>;
}

/**
 * Get a summary of all open positions with exposure calculations.
 */
export function getPositionSummary(): PositionSummary {
  const positions = getOpenPositions();
  let totalExposure = 0;
  const exposureByEvent = new Map<string, number>();

  const detailed = positions.map((pos) => {
    // Exposure = potential loss if combo resolves against us
    // If we sold YES (took NO side), we lose (1 - entry_price) × contracts if YES hits
    // If we sold NO (took YES side), we lose entry_price × contracts if NO hits
    const exposure = pos.side === 'no'
      ? (1 - pos.avg_entry_price) * pos.contracts
      : pos.avg_entry_price * pos.contracts;

    totalExposure += exposure;

    const current = exposureByEvent.get(pos.event_ticker) ?? 0;
    exposureByEvent.set(pos.event_ticker, current + exposure);

    return {
      ...pos,
      exposure,
    };
  });

  return {
    totalPositions: positions.length,
    totalExposure,
    exposureByEvent,
    positions: detailed,
  };
}

/**
 * Get total exposure for a specific event.
 */
export function getEventExposure(eventTicker: string): number {
  const positions = getPositionsByEvent(eventTicker);
  return positions.reduce((sum, pos) => {
    const exposure = pos.side === 'no'
      ? (1 - pos.avg_entry_price) * pos.contracts
      : pos.avg_entry_price * pos.contracts;
    return sum + exposure;
  }, 0);
}

/**
 * Record a new fill into positions tracking.
 */
export function recordFill(fill: {
  market_ticker: string;
  event_ticker: string;
  side: string;
  contracts: number;
  price: number;
}): void {
  logger.info('Recording fill', {
    ticker: fill.market_ticker,
    side: fill.side,
    contracts: fill.contracts,
    price: fill.price,
  });

  upsertPosition({
    market_ticker: fill.market_ticker,
    event_ticker: fill.event_ticker,
    side: fill.side,
    contracts: fill.contracts,
    avg_entry_price: fill.price,
  });
}
