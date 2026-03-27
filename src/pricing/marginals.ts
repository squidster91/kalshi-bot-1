import { OrderbookManager } from '../api/websocket';
import { MVELeg } from '../api/rest';
import { config } from '../config';
import { logger } from '../logger';

export interface LegPrice {
  ticker: string;
  side: string;
  midPrice: number;
  probability: number; // probability the leg resolves YES given the side
  isStale: boolean;
}

/**
 * Parse a leg's market ticker to determine its type.
 * NBA tickers follow patterns like:
 *   NBA-{GAME_ID}-ML-{TEAM}          (moneyline)
 *   NBA-{GAME_ID}-SP-{TEAM}-{SPREAD} (spread)
 *   NBA-{GAME_ID}-OU-{TOTAL}         (over/under)
 *   NBA-{GAME_ID}-PP-{PLAYER}-{STAT}-{LINE} (player prop)
 */
export type LegType = 'moneyline' | 'spread' | 'total' | 'player_pts' | 'player_reb' |
  'player_ast' | 'player_3pm' | 'player_other' | 'unknown';

export function parseLegType(ticker: string): LegType {
  const upper = ticker.toUpperCase();

  if (upper.includes('-ML-')) return 'moneyline';
  if (upper.includes('-SP-')) return 'spread';
  if (upper.includes('-OU-')) return 'total';
  if (upper.includes('-PP-')) {
    if (upper.includes('-PTS-')) return 'player_pts';
    if (upper.includes('-REB-')) return 'player_reb';
    if (upper.includes('-AST-')) return 'player_ast';
    if (upper.includes('-3PM-') || upper.includes('-TPM-')) return 'player_3pm';
    return 'player_other';
  }
  return 'unknown';
}

/**
 * Extract the game ID from a ticker to determine if legs belong to the same game.
 */
export function extractGameId(ticker: string): string | null {
  // Expected format: NBA-{GAME_ID}-...
  const parts = ticker.split('-');
  if (parts.length >= 2 && parts[0].toUpperCase() === 'NBA') {
    return parts[1];
  }
  return null;
}

/**
 * Given an RFQ's legs, look up current mid-prices from the orderbook manager.
 * Returns probability for each leg (adjusted for side — if side is "no",
 * the probability is 1 - midPrice).
 */
export function getLegPrices(
  legs: MVELeg[],
  orderbookManager: OrderbookManager
): LegPrice[] {
  return legs.map((leg) => {
    const midPrice = orderbookManager.getMidPrice(leg.market_ticker);
    const isStale = orderbookManager.isStale(
      leg.market_ticker,
      config.risk.stalePriceThresholdMs
    );

    if (midPrice === null) {
      logger.warn(`No orderbook data for ${leg.market_ticker}`);
      return {
        ticker: leg.market_ticker,
        side: leg.side,
        midPrice: 0,
        probability: 0,
        isStale: true,
      };
    }

    // The mid-price represents P(YES). If the leg's side is "yes", use it directly.
    // If side is "no", the bet wins when the event doesn't happen, so P = 1 - midPrice.
    const probability = leg.side === 'yes' ? midPrice : 1 - midPrice;

    return {
      ticker: leg.market_ticker,
      side: leg.side,
      midPrice,
      probability,
      isStale,
    };
  });
}

/**
 * Naive combo price assuming independence (used as baseline).
 */
export function naiveComboPrice(legPrices: LegPrice[]): number {
  return legPrices.reduce((acc, leg) => acc * leg.probability, 1);
}

/**
 * Check if all legs belong to the same game.
 */
export function isSameGame(legs: MVELeg[]): boolean {
  const gameIds = legs.map((l) => extractGameId(l.market_ticker)).filter(Boolean);
  if (gameIds.length === 0) return false;
  return new Set(gameIds).size === 1;
}
