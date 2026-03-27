import { config } from '../config';
import { MVELeg } from '../api/rest';
import { isSameGame } from './marginals';
import { getPositionsByEvent } from '../db/queries';
import { extractGameId } from './marginals';

export interface SpreadResult {
  spread: number;
  components: {
    base: number;
    sameGameAdjustment: number;
    inventoryAdjustment: number;
    final: number;
  };
}

/**
 * Calculate the spread to add on top of fair value for a combo quote.
 * Wider spreads = more conservative (less likely to fill, but more profit if we do).
 */
export function calculateSpread(
  legs: MVELeg[],
  fairValue: number
): SpreadResult {
  const numLegs = legs.length;
  const { spread: spreadConfig } = config;

  // Base spread depends on number of legs
  const base = spreadConfig.baseSpreads[numLegs] ?? spreadConfig.defaultBaseSpread;

  // Same-game discount: tighter spreads when we have better correlation data
  const sameGame = isSameGame(legs);
  const sameGameMultiplier = sameGame ? spreadConfig.sameGameDiscount : 1.0;
  const sameGameAdjustment = base * (1 - sameGameMultiplier);

  // Inventory penalty: wider if we already have exposure to this event
  let inventoryAdjustment = 0;
  const gameIds = new Set(
    legs.map((l) => extractGameId(l.market_ticker)).filter(Boolean)
  );

  for (const gameId of gameIds) {
    if (!gameId) continue;
    // Check existing positions for this event
    // Use event_ticker pattern matching (simplified)
    const eventTicker = legs.find((l) =>
      extractGameId(l.market_ticker) === gameId
    )?.event_ticker;

    if (eventTicker) {
      const positions = getPositionsByEvent(eventTicker);
      inventoryAdjustment += positions.length * spreadConfig.inventoryPenalty;
    }
  }

  // Calculate final spread
  let finalSpread = base * sameGameMultiplier + inventoryAdjustment;

  // Clamp to configured bounds
  finalSpread = Math.max(spreadConfig.minSpread, Math.min(spreadConfig.maxSpread, finalSpread));

  return {
    spread: finalSpread,
    components: {
      base,
      sameGameAdjustment,
      inventoryAdjustment,
      final: finalSpread,
    },
  };
}

/**
 * Given a fair value and spread, compute the YES and NO bid prices.
 * We are typically selling YES (taking the NO side), so:
 * - YES bid = fair_value - spread (lower than fair, our edge)
 * - NO bid = 1 - YES bid
 */
export function computeQuotePrices(
  fairValue: number,
  spread: number
): { yesBid: number; noBid: number } {
  // Our YES bid is below fair value — this is our edge
  let yesBid = fairValue - spread;

  // Clamp to valid range
  yesBid = Math.max(0.01, Math.min(0.99, yesBid));
  const noBid = Math.round((1 - yesBid) * 100) / 100;
  yesBid = Math.round(yesBid * 100) / 100;

  return { yesBid, noBid };
}
