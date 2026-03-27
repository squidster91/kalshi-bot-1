import { EventEmitter } from 'events';
import { CommunicationsManager } from '../api/websocket';
import { OrderbookManager } from '../api/websocket';
import { MVELeg, getMarket, getMarkets } from '../api/rest';
import { insertRFQ, insertRFQLegPrices, saveRFQLegPricesSnapshot, markRFQDeleted, upsertPriceCache, loadPriceCache, loadKnownBots, saveKnownBot } from '../db/queries';
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

    // Load persistent price cache from database
    try {
      this.priceCache = loadPriceCache();
      logger.info(`Loaded ${this.priceCache.size} cached prices from database`);
    } catch (err) {
      logger.warn('Failed to load price cache', { error: String(err) });
    }

    // Load known bots from database
    try {
      this.knownBots = loadKnownBots();
      logger.info(`Loaded ${this.knownBots.size} known bots from database`);
    } catch (err) {
      logger.warn('Failed to load known bots', { error: String(err) });
    }
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

  // Bot detection: track RFQ frequency per creator
  private creatorRfqTimes: Map<string, number[]> = new Map();
  private static BOT_THRESHOLD = 3; // 3+ RFQs per minute = bot
  private static BOT_WINDOW_MS = 60_000; // 1 minute window
  private knownBots = new Set<string>();

  // Player prop detection
  private static PLAYER_PROP_PATTERN = /PTS|REB|AST|3PM|TPM|STL|BLK/i;

  // Counters for reporting
  private totalSeen = 0;
  private botFiltered = 0;
  private playerFiltered = 0;
  private budgetModeFiltered = 0;
  private lastReportTime = Date.now();

  private handleRFQ(msg: Record<string, unknown>): void {
    try {
      const parsed = this.parseRFQ(msg);
      if (!parsed) return;

      this.totalSeen++;
      const now = Date.now();

      // Filter 1: Bot detection — creator frequency
      const creatorId = parsed.creatorId;
      if (creatorId) {
        let times = this.creatorRfqTimes.get(creatorId);
        if (!times) {
          times = [];
          this.creatorRfqTimes.set(creatorId, times);
        }
        times.push(now);

        // Trim to window
        const cutoff = now - RFQListener.BOT_WINDOW_MS;
        while (times.length > 0 && times[0] < cutoff) times.shift();

        if (times.length >= RFQListener.BOT_THRESHOLD && !this.knownBots.has(creatorId)) {
          this.knownBots.add(creatorId);
          try { saveKnownBot(creatorId); } catch { /* ok */ }
          logger.info('New bot detected', { creatorId, knownBots: this.knownBots.size });
        }

        if (this.knownBots.has(creatorId)) {
          this.botFiltered++;
          this.reportFilterStats(now);
          return;
        }
      }

      // Filter 2: Skip player-prop parlays (team-only)
      const hasPlayerProps = parsed.legs.some(
        l => l.market_ticker && RFQListener.PLAYER_PROP_PATTERN.test(l.market_ticker)
      );
      if (hasPlayerProps) {
        this.playerFiltered++;
        this.reportFilterStats(now);
        return;
      }

      // Filter 3: $10 budget-mode bots (exact $10 target cost + 0 contracts)
      if (parsed.targetCostDollars === 10 && parsed.contractsRequested === 0) {
        this.budgetModeFiltered++;
        this.reportFilterStats(now);
        return;
      }

      this.reportFilterStats(now);
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

  private reportFilterStats(now: number): void {
    if (now - this.lastReportTime > 30_000 && this.totalSeen > 0) {
      const totalFiltered = this.botFiltered + this.playerFiltered + this.budgetModeFiltered;
      const passed = this.totalSeen - totalFiltered;
      logger.info('Filter stats', {
        totalSeen: this.totalSeen,
        botFiltered: this.botFiltered,
        playerFiltered: this.playerFiltered,
        budgetModeFiltered: this.budgetModeFiltered,
        passed,
        pctFiltered: ((totalFiltered / this.totalSeen) * 100).toFixed(1) + '%',
        knownBots: this.knownBots.size,
      });
      this.lastReportTime = now;
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
  private static CACHE_TTL_MS = 5 * 60_000; // 5 minutes
  private rateLimited = false;
  private rateLimitedUntil = 0;
  private lastApiCall = 0;
  private static MIN_API_INTERVAL_MS = 200; // Max ~5 API calls/sec

  // Track which tickers we've already subscribed to via WS
  private subscribedTickers = new Set<string>();

  private async captureLegPrices(rfqId: string, legs: MVELeg[]): Promise<void> {
    const legPrices: Array<{ ticker: string; side: string; midPrice: number | null }> = [];
    const priceSnapshot: Record<string, number> = {};
    const now = Date.now();

    // Step 1: Subscribe new leg tickers to orderbook WebSocket for future RFQs
    if (this.orderbook) {
      const newTickers = legs
        .map(l => l.market_ticker)
        .filter(t => !this.subscribedTickers.has(t));
      if (newTickers.length > 0) {
        this.orderbook.subscribeMarkets(newTickers);
        for (const t of newTickers) this.subscribedTickers.add(t);
        logger.debug('Subscribed to orderbook for leg tickers', { count: newTickers.length });
      }
    }

    // Step 2: Try orderbook + cache first for all legs
    const needFetch: string[] = []; // event_tickers that need API fetch
    for (const leg of legs) {
      let mid: number | null = null;

      // Try orderbook (in-memory, instant)
      if (this.orderbook) {
        mid = this.orderbook.getMidPrice(leg.market_ticker);
      }

      // Try cache
      if (mid === null) {
        const cached = this.priceCache.get(leg.market_ticker);
        if (cached && (now - cached.ts) < RFQListener.CACHE_TTL_MS) {
          mid = cached.mid;
        }
      }

      if (mid !== null) {
        legPrices.push({ ticker: leg.market_ticker, side: leg.side, midPrice: mid });
        priceSnapshot[leg.market_ticker] = mid;
      } else {
        // Need to fetch this one
        legPrices.push({ ticker: leg.market_ticker, side: leg.side, midPrice: null });
        if (!needFetch.includes(leg.event_ticker)) {
          needFetch.push(leg.event_ticker);
        }
      }
    }

    // Step 3: Batch-fetch by event_ticker (1 API call per event instead of per leg)
    if (needFetch.length > 0 && !(this.rateLimited && now < this.rateLimitedUntil)) {
      this.rateLimited = false;

      for (const eventTicker of needFetch) {
        const timeSinceLastCall = Date.now() - this.lastApiCall;
        if (timeSinceLastCall < RFQListener.MIN_API_INTERVAL_MS) {
          await new Promise(r => setTimeout(r, RFQListener.MIN_API_INTERVAL_MS - timeSinceLastCall));
        }

        try {
          this.lastApiCall = Date.now();
          const resp = await getMarkets({ event_ticker: eventTicker, limit: '100' });
          let cached = 0;
          for (const m of resp.markets) {
            let mid: number | null = null;
            if (m.yes_bid > 0 && m.yes_ask > 0) {
              mid = (m.yes_bid + m.yes_ask) / 2 / 100;
            } else if (m.last_price > 0) {
              mid = m.last_price / 100;
            }
            if (mid !== null) {
              this.priceCache.set(m.ticker, { mid, ts: Date.now() });
              try { upsertPriceCache(m.ticker, mid); } catch { /* ok */ }
              cached++;
            }
          }
          logger.info('Batch-fetched market prices', {
            event: eventTicker,
            markets: resp.markets.length,
            cached,
          });
        } catch (err) {
          const errMsg = String(err);
          if (errMsg.includes('429')) {
            this.rateLimited = true;
            this.rateLimitedUntil = Date.now() + 60_000;
            logger.warn('Rate limited on batch market lookup, backing off 60s');
            break;
          }
          logger.debug('Failed to batch-fetch markets', { event: eventTicker, error: errMsg });
        }
      }

      // Now fill in any prices we just fetched
      for (let i = 0; i < legPrices.length; i++) {
        if (legPrices[i].midPrice === null) {
          const cached = this.priceCache.get(legPrices[i].ticker);
          if (cached) {
            legPrices[i].midPrice = cached.mid;
            priceSnapshot[legPrices[i].ticker] = cached.mid;
          }
        }
      }
    }

    insertRFQLegPrices(rfqId, legPrices);
    if (Object.keys(priceSnapshot).length > 0) {
      saveRFQLegPricesSnapshot(rfqId, priceSnapshot);
    }

    // Clean old cache entries periodically
    if (this.priceCache.size > 10000) {
      for (const [k, v] of this.priceCache) {
        if (now - v.ts > RFQListener.CACHE_TTL_MS * 2) {
          this.priceCache.delete(k);
        }
      }
    }
  }

  getStats() {
    return {
      rfqCount: this.rfqCount,
      totalSeen: this.totalSeen,
      botFiltered: this.botFiltered,
      playerFiltered: this.playerFiltered,
      budgetModeFiltered: this.budgetModeFiltered,
      knownBots: this.knownBots.size,
    };
  }
}
