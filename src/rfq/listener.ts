import { EventEmitter } from 'events';
import { CommunicationsManager } from '../api/websocket';
import { OrderbookManager } from '../api/websocket';
import { MVELeg, getMarket, getMarkets, getOrderbook } from '../api/rest';
import { insertRFQ, insertRFQLegPrices, saveRFQLegPricesSnapshot, markRFQDeleted, upsertPriceCache, loadPriceCache, loadKnownBots, saveKnownBot, incrementDailyQualified } from '../db/queries';
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
  private static BOT_THRESHOLD = 10; // 10+ RFQs per minute = bot
  private static BOT_WINDOW_MS = 60_000; // 1 minute window
  private knownBots = new Set<string>();

  // Player prop detection
  private static PLAYER_PROP_PATTERN = /PTS|REB|AST|3PM|TPM|STL|BLK/i;

  // MLB moneyline filter: only process parlays where ALL legs are MLB game (moneyline) markets
  private static MLB_MONEYLINE_PATTERN = /MLB.*GAME|MLBGAME/i;
  private static MLB_NON_MONEYLINE = /SPREAD|TOTAL|OVER|UNDER/i;
  private nonMlbFiltered = 0;
  private botMlbDropped = 0; // bots that would have been MLB moneyline

  // Counters for reporting (reset at PST midnight)
  private totalSeen = 0;
  private botFiltered = 0;
  private playerFiltered = 0;
  private lastReportTime = Date.now();
  private counterDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  private checkDayRollover(): void {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    if (today !== this.counterDate) {
      logger.info('PST day rollover — resetting filter counters', { oldDate: this.counterDate, newDate: today });
      this.totalSeen = 0;
      this.botFiltered = 0;
      this.playerFiltered = 0;
      this.nonMlbFiltered = 0;
      this.botMlbDropped = 0;
      this.counterDate = today;
    }
  }

  private handleRFQ(msg: Record<string, unknown>): void {
    try {
      const parsed = this.parseRFQ(msg);
      if (!parsed) return;

      this.checkDayRollover();
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
          // Track if this bot RFQ would have been MLB moneyline
          const wouldBeMlb = parsed.legs.every(l => {
            const t = l.market_ticker || '';
            return RFQListener.MLB_MONEYLINE_PATTERN.test(t) && !RFQListener.MLB_NON_MONEYLINE.test(t);
          });
          if (wouldBeMlb) {
            this.botMlbDropped++;
            logger.info('Bot RFQ was MLB moneyline — dropped', {
              creatorId, id: parsed.id, legs: parsed.legs.length,
              targetCost: parsed.targetCostDollars, botMlbTotal: this.botMlbDropped,
            });
          }
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

      // Filter 3: MLB moneylines only — every leg must be an MLB game market (not spread/total)
      const allMlbMoneyline = parsed.legs.every(l => {
        const t = l.market_ticker || '';
        return RFQListener.MLB_MONEYLINE_PATTERN.test(t) && !RFQListener.MLB_NON_MONEYLINE.test(t);
      });
      if (!allMlbMoneyline) {
        this.nonMlbFiltered++;
        this.reportFilterStats(now);
        return;
      }

      this.reportFilterStats(now);
      this.rfqCount++;

      // Track qualified RFQ (passed all filters) — persisted day-over-day
      try { incrementDailyQualified(parsed.targetCostDollars); } catch { /* ok */ }

      // Log to database
      insertRFQ({
        id: parsed.id,
        market_ticker: parsed.marketTicker,
        event_ticker: parsed.eventTicker,
        legs: parsed.legs,
        contracts_requested: parsed.contractsRequested.toString(),
        target_cost_dollars: parsed.targetCostDollars.toString(),
        creator_id: parsed.creatorId,
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
      const totalFiltered = this.botFiltered + this.playerFiltered + this.nonMlbFiltered;
      const passed = this.totalSeen - totalFiltered;
      logger.info('Filter stats', {
        totalSeen: this.totalSeen,
        botFiltered: this.botFiltered,
        playerFiltered: this.playerFiltered,
        nonMlbFiltered: this.nonMlbFiltered,
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

  // Price cache: ticker -> { mid, thin, ts }. Avoids hammering API for same ticker.
  private priceCache: Map<string, { mid: number; thin: boolean; ts: number }> = new Map();
  private static CACHE_TTL_MS = 5 * 60_000; // 5 minutes
  private rateLimited = false;
  private rateLimitedUntil = 0;
  private lastApiCall = 0;
  private static MIN_API_INTERVAL_MS = 200; // Max ~5 API calls/sec

  // Map combo leg ticker -> real underlying market ticker (discovered via getMarkets)
  private tickerMap: Map<string, string> = new Map();
  // Cache event_ticker -> list of real market tickers (to avoid re-fetching)
  private eventMarketsCache: Map<string, { tickers: string[]; ts: number }> = new Map();

  // Track which tickers we've already subscribed to via WS
  private subscribedTickers = new Set<string>();

  private static LIQUIDITY_THRESHOLD = 100_000; // $100K in cents = 10,000,000 cents... actually quantity * price

  /**
   * Resolve a combo leg's KX-prefixed market_ticker to the real underlying market ticker.
   * Uses the leg's event_ticker to discover actual markets via getMarkets API.
   */
  private async resolveRealTicker(leg: MVELeg): Promise<string | null> {
    // Check cached mapping first
    const cached = this.tickerMap.get(leg.market_ticker);
    if (cached) return cached;

    // Use the leg's event_ticker to find real markets for this event
    // Leg event_ticker is also KX-prefixed (combo), strip it to get the real underlying event
    const rawEventTicker = leg.event_ticker;
    if (!rawEventTicker) {
      logger.warn('Leg has no event_ticker', { market_ticker: leg.market_ticker, legData: JSON.stringify(leg).slice(0, 300) });
      return null;
    }
    const eventTicker = rawEventTicker.startsWith('KX') ? rawEventTicker.slice(2) : rawEventTicker;

    let realTickers: string[] = [];
    const eventCached = this.eventMarketsCache.get(eventTicker);
    if (eventCached && (Date.now() - eventCached.ts) < 10 * 60_000) {
      realTickers = eventCached.tickers;
    } else {
      try {
        const timeSinceLastCall = Date.now() - this.lastApiCall;
        if (timeSinceLastCall < RFQListener.MIN_API_INTERVAL_MS) {
          await new Promise(r => setTimeout(r, RFQListener.MIN_API_INTERVAL_MS - timeSinceLastCall));
        }
        this.lastApiCall = Date.now();
        const resp = await getMarkets({ event_ticker: eventTicker, status: 'open', limit: '50' });
        realTickers = (resp?.markets || []).map(m => m.ticker);
        this.eventMarketsCache.set(eventTicker, { tickers: realTickers, ts: Date.now() });
        if (realTickers.length > 0) {
          logger.info('Discovered real markets for event', { rawEventTicker, eventTicker, count: realTickers.length, sample: realTickers.slice(0, 3) });
        }
      } catch (err) {
        const errMsg = String(err);
        if (errMsg.includes('429')) {
          this.rateLimited = true;
          this.rateLimitedUntil = Date.now() + 60_000;
        }
        logger.warn('Failed to discover markets for event', { eventTicker, error: errMsg });
        return null;
      }
    }

    if (realTickers.length === 0) {
      logger.warn('No markets found for event', { eventTicker, market_ticker: leg.market_ticker });
      return null;
    }

    // Match: strip KX from combo ticker and find a real ticker that shares the same suffix
    // e.g. KXMLBGAME-26MAR281507ATHTOR-TOR → find real ticker ending in -TOR
    const comboStripped = leg.market_ticker.startsWith('KX') ? leg.market_ticker.slice(2) : leg.market_ticker;
    const lastDash = comboStripped.lastIndexOf('-');
    const suffix = lastDash >= 0 ? comboStripped.slice(lastDash) : '';

    // Try exact match first (stripping KX)
    let match = realTickers.find(t => t === comboStripped);

    // Try suffix match (same outcome team)
    if (!match && suffix) {
      match = realTickers.find(t => t.endsWith(suffix));
    }

    // Try substring containment
    if (!match) {
      match = realTickers.find(t => comboStripped.includes(t) || t.includes(comboStripped));
    }

    // Last resort: if only one market for this event, use it
    if (!match && realTickers.length === 1) {
      match = realTickers[0];
    }

    if (match) {
      this.tickerMap.set(leg.market_ticker, match);
      if (match !== comboStripped) {
        logger.info('Ticker resolved', { combo: leg.market_ticker, real: match });
      }
      return match;
    }

    logger.warn('Could not match ticker', { combo: leg.market_ticker, stripped: comboStripped, suffix, available: realTickers });
    return null;
  }

  /**
   * Find the implied probability from the NO side of the orderbook.
   * Walk NO levels until cumulative liquidity (quantity * price_cents) >= $100K threshold.
   * Returns the price at that level as a probability (0-1), or null if not enough liquidity.
   */
  private static findNoLiquidityPrice(noLevels: Array<{ price: number; quantity: number }>): { price: number; thin: boolean } | null {
    if (!noLevels || noLevels.length === 0) return null;

    let cumulativeDollars = 0;
    for (const level of noLevels) {
      // level.price is in cents (e.g., 45 = $0.45), quantity is number of contracts
      // Dollar liquidity at this level = quantity * (price / 100)
      const dollarLiquidity = level.quantity * (level.price / 100);
      cumulativeDollars += dollarLiquidity;

      if (cumulativeDollars >= RFQListener.LIQUIDITY_THRESHOLD) {
        // NO price in cents → YES implied probability = (100 - no_price) / 100
        const yesImplied = (100 - level.price) / 100;
        return { price: yesImplied, thin: false };
      }
    }

    // Not enough liquidity — use best NO if available but mark as thin
    if (noLevels.length > 0) {
      return { price: (100 - noLevels[0].price) / 100, thin: true };
    }
    return null;
  }

  private loggedFirstRfq = false;
  private loggedFirstPrice = false;
  private loggedTickerErrors = false;

  private async captureLegPrices(rfqId: string, legs: MVELeg[]): Promise<void> {
    // Log raw leg data for the first RFQ to diagnose field availability
    if (!this.loggedFirstRfq) {
      this.loggedFirstRfq = true;
      logger.info('DIAG: First RFQ raw legs', {
        rfqId,
        legCount: legs.length,
        legs: legs.map(l => JSON.stringify(l).slice(0, 200)),
      });
    }

    const legPrices: Array<{ ticker: string; side: string; midPrice: number | null }> = [];
    const priceSnapshot: Record<string, number> = {};
    const thinTickers: string[] = [];
    const now = Date.now();
    let priced = 0;

    for (const leg of legs) {
      let price: number | null = null;
      let thin = false;

      // Check cache first (keyed by original KX ticker)
      const cached = this.priceCache.get(leg.market_ticker);
      if (cached && (now - cached.ts) < RFQListener.CACHE_TTL_MS) {
        price = cached.mid;
        thin = cached.thin;
      }

      // Fetch price from API if not cached
      if (price === null && !(this.rateLimited && now < this.rateLimitedUntil)) {
        // Try multiple ticker formats: original KX ticker first, then KX-stripped
        const tickersToTry = [leg.market_ticker];
        if (leg.market_ticker.startsWith('KX')) {
          tickersToTry.push(leg.market_ticker.slice(2));
        }

        for (const tryTicker of tickersToTry) {
          if (price !== null) break;
          if (this.rateLimited && Date.now() < this.rateLimitedUntil) break;

          // Try getMarket first (simpler, more reliable)
          try {
            const timeSinceLastCall = Date.now() - this.lastApiCall;
            if (timeSinceLastCall < RFQListener.MIN_API_INTERVAL_MS) {
              await new Promise(r => setTimeout(r, RFQListener.MIN_API_INTERVAL_MS - timeSinceLastCall));
            }
            this.lastApiCall = Date.now();
            const mktResp = await getMarket(tryTicker);
            const m = mktResp?.market;
            if (m) {
              const bid = m.yes_bid > 0 ? m.yes_bid : m.last_price;
              if (bid > 0) {
                price = bid / 100;
                thin = true;
                if (!this.loggedFirstPrice) {
                  this.loggedFirstPrice = true;
                  logger.info('DIAG: First price via getMarket', { tryTicker, yes_bid: m.yes_bid, no_bid: m.no_bid, last_price: m.last_price, price });
                }
              }
            }
          } catch (err) {
            const errMsg = String(err);
            if (errMsg.includes('429')) {
              this.rateLimited = true;
              this.rateLimitedUntil = Date.now() + 60_000;
            }
            // Log first few failures to diagnose which ticker format works
            if (!this.loggedTickerErrors) {
              this.loggedTickerErrors = true;
              logger.info('DIAG: getMarket error', { tryTicker, error: errMsg.slice(0, 200) });
            }
          }

          if (price !== null) break;

          // Try orderbook (NO-side $100K liquidity depth)
          try {
            const timeSinceLastCall = Date.now() - this.lastApiCall;
            if (timeSinceLastCall < RFQListener.MIN_API_INTERVAL_MS) {
              await new Promise(r => setTimeout(r, RFQListener.MIN_API_INTERVAL_MS - timeSinceLastCall));
            }
            this.lastApiCall = Date.now();
            const resp = await getOrderbook(tryTicker);
            const ob = resp?.orderbook;
            if (ob && Array.isArray(ob.no) && ob.no.length > 0) {
              const result = RFQListener.findNoLiquidityPrice(ob.no as Array<{ price: number; quantity: number }>);
              if (result !== null) {
                price = result.price;
                thin = result.thin;
                if (!this.loggedFirstPrice) {
                  this.loggedFirstPrice = true;
                  logger.info('DIAG: First price via orderbook', { tryTicker, price, thin });
                }
              }
            }
          } catch (err) {
            const errMsg = String(err);
            if (errMsg.includes('429')) {
              this.rateLimited = true;
              this.rateLimitedUntil = Date.now() + 60_000;
            }
          }
        }

        // Cache the result (even null to avoid re-fetching)
        if (price !== null) {
          this.priceCache.set(leg.market_ticker, { mid: price, thin, ts: Date.now() });
          try { upsertPriceCache(leg.market_ticker, price); } catch { /* ok */ }
        }
      }

      if (thin) thinTickers.push(leg.market_ticker);
      legPrices.push({ ticker: leg.market_ticker, side: leg.side, midPrice: price });
      if (price !== null) {
        priceSnapshot[leg.market_ticker] = price;
        priced++;
      }
    }

    // One log line per RFQ instead of per-leg
    if (priced < legs.length) {
      logger.warn('Incomplete pricing', { rfqId, priced, total: legs.length, rateLimited: this.rateLimited });
    } else {
      logger.info('Priced RFQ', { rfqId, legs: legs.length, prices: Object.fromEntries(Object.entries(priceSnapshot).filter(([k]) => !k.startsWith('__'))) });
    }

    // Store thin tickers in snapshot so dashboard can display liquidity status
    if (thinTickers.length > 0) {
      priceSnapshot['__thin__'] = thinTickers.length;
      for (const t of thinTickers) {
        priceSnapshot['__thin_' + t] = 1;
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
      nonMlbFiltered: this.nonMlbFiltered,
      botMlbDropped: this.botMlbDropped,
      knownBots: this.knownBots.size,
    };
  }
}
