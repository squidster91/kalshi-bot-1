import { EventEmitter } from 'events';
import { CommunicationsManager } from '../api/websocket';
import { OrderbookManager } from '../api/websocket';
import { MVELeg, getMarket } from '../api/rest';
import { insertRFQ, insertRFQLegPrices, saveRFQLegPricesSnapshot, markRFQDeleted } from '../db/queries';
import { logger } from '../logger';

export interface ParsedRFQ {
  id: string;
  creatorId: string;
  marketTicker: string;
  eventTicker: string;
  contractsRequested: number;
  targetCostDollars: number;
  legs: MVELeg[];
  createdTs: string;
  receivedAt: number;
}

/**
 * RFQ Listener processes incoming RFQ events from the communications WebSocket.
 * It parses, validates, and emits normalized RFQ objects for the quoter to process.
 */
export class RFQListener extends EventEmitter {
  private comms: CommunicationsManager;
  private orderbook: OrderbookManager | null = null;
  private rfqCount = 0;

  constructor(comms: CommunicationsManager, orderbook?: OrderbookManager) {
    super();
    this.comms = comms;
    this.orderbook = orderbook ?? null;
  }

  start(): void {
    this.comms.on('rfq_created', (msg: Record<string, unknown>) => {
      this.handleRFQ(msg);
    });

    this.comms.on('rfq_deleted', (msg: Record<string, unknown>) => {
      const id = msg.id as string;
      if (id) {
        try {
          markRFQDeleted(id);
        } catch (err) {
          logger.debug('Failed to mark RFQ deleted', { id, error: String(err) });
        }
      }
      logger.debug('RFQ deleted', { id });
      this.emit('rfq_deleted', id);
    });

    logger.info('RFQ listener started');
  }

  private handleRFQ(msg: Record<string, unknown>): void {
    try {
      const parsed = this.parseRFQ(msg);
      if (!parsed) return;

      this.rfqCount++;

      // Log to database
      insertRFQ({
        id: parsed.id,
        market_ticker: parsed.marketTicker,
        event_ticker: parsed.eventTicker,
        legs: parsed.legs,
        contracts_requested: parsed.contractsRequested.toString(),
        target_cost_dollars: parsed.targetCostDollars.toString(),
      });

      // Capture leg prices asynchronously (don't block RFQ pipeline)
      this.captureLegPrices(parsed.id, parsed.legs).catch(err => {
        logger.debug('Failed to capture leg prices for RFQ', { id: parsed.id, error: String(err) });
      });

      logger.info('RFQ received', {
        id: parsed.id,
        legs: parsed.legs.length,
        contracts: parsed.contractsRequested,
        targetCost: parsed.targetCostDollars,
        ticker: parsed.marketTicker,
      });

      this.emit('rfq', parsed);
    } catch (err) {
      logger.error('Error processing RFQ', {
        error: String(err),
        msg: JSON.stringify(msg).slice(0, 500),
      });
    }
  }

  private parseRFQ(msg: Record<string, unknown>): ParsedRFQ | null {
    const id = msg.id as string;
    if (!id) {
      logger.warn('RFQ missing id');
      return null;
    }

    const legs = msg.mve_selected_legs as MVELeg[] | undefined;
    if (!legs || legs.length === 0) {
      logger.debug('RFQ has no legs, skipping', { id });
      return null;
    }

    const contractsFp = msg.contracts_fp as string ?? '0';
    const targetCost = msg.target_cost_dollars as string ?? '0';

    return {
      id,
      creatorId: msg.creator_id as string ?? '',
      marketTicker: msg.market_ticker as string ?? '',
      eventTicker: msg.event_ticker as string ?? '',
      contractsRequested: parseFloat(contractsFp) || 0,
      targetCostDollars: parseFloat(targetCost) || 0,
      legs,
      createdTs: msg.created_ts as string ?? '',
      receivedAt: Date.now(),
    };
  }

  // Price cache: ticker -> { mid, ts }. Avoids hammering API for same ticker.
  private priceCache: Map<string, { mid: number; ts: number }> = new Map();
  private static CACHE_TTL_MS = 30_000; // 30 seconds

  private async captureLegPrices(rfqId: string, legs: MVELeg[]): Promise<void> {
    const legPrices: Array<{ ticker: string; side: string; midPrice: number | null }> = [];
    const priceSnapshot: Record<string, number> = {};
    const now = Date.now();

    for (const leg of legs) {
      let mid: number | null = null;

      // 1. Try orderbook (in-memory, instant)
      if (this.orderbook) {
        mid = this.orderbook.getMidPrice(leg.market_ticker);
      }

      // 2. Try cache
      if (mid === null) {
        const cached = this.priceCache.get(leg.market_ticker);
        if (cached && (now - cached.ts) < RFQListener.CACHE_TTL_MS) {
          mid = cached.mid;
        }
      }

      // 3. Fall back to REST API
      if (mid === null) {
        try {
          const resp = await getMarket(leg.market_ticker);
          const m = resp.market;
          if (m.yes_bid > 0 && m.yes_ask > 0) {
            mid = (m.yes_bid + m.yes_ask) / 2 / 100; // Convert cents to dollars
          } else if (m.last_price > 0) {
            mid = m.last_price / 100;
          }
          if (mid !== null) {
            this.priceCache.set(leg.market_ticker, { mid, ts: now });
          }
        } catch {
          // Market might not exist or API error - skip
        }
      }

      legPrices.push({ ticker: leg.market_ticker, side: leg.side, midPrice: mid });
      if (mid !== null) {
        priceSnapshot[leg.market_ticker] = mid;
      }
    }

    insertRFQLegPrices(rfqId, legPrices);
    if (Object.keys(priceSnapshot).length > 0) {
      saveRFQLegPricesSnapshot(rfqId, priceSnapshot);
    }

    // Clean old cache entries periodically
    if (this.priceCache.size > 5000) {
      for (const [k, v] of this.priceCache) {
        if (now - v.ts > RFQListener.CACHE_TTL_MS * 10) {
          this.priceCache.delete(k);
        }
      }
    }
  }

  getStats(): { rfqCount: number } {
    return { rfqCount: this.rfqCount };
  }
}
