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

  private static LIQUIDITY_THRESHOLD = 100_000; // $100K notional

  /**
   * Extract YES implied probability from orderbook.
   * Kalshi API v3: levels are string tuples [price_dollars, count_fp].
   * e.g., no_dollars: [["0.3200", "500.00"], ["0.3300", "200.00"]]
   * Walk NO side until $100K cumulative notional. YES prob = 1 - no_price.
   */
  private static extractProbFromOrderbook(
    ob: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] }
  ): { price: number; thin: boolean } | null {
    // Try NO side first
    if (ob.no_dollars && ob.no_dollars.length > 0) {
      let cumNotional = 0;
      for (const [priceDollars, countFp] of ob.no_dollars) {
        const price = parseFloat(priceDollars);
        const count = parseFloat(countFp);
        if (isNaN(price) || isNaN(count)) continue;
        cumNotional += count * price; // count contracts × price per contract
        if (cumNotional >= RFQListener.LIQUIDITY_THRESHOLD) {
          return { price: 1 - price, thin: false };
        }
      }
      // Thin — use best NO level
      const bestPrice = parseFloat(ob.no_dollars[0][0]);
      if (!isNaN(bestPrice)) return { price: 1 - bestPrice, thin: true };
    }

    // Try YES side as fallback
    if (ob.yes_dollars && ob.yes_dollars.length > 0) {
      let cumNotional = 0;
      for (const [priceDollars, countFp] of ob.yes_dollars) {
        const price = parseFloat(priceDollars);
        const count = parseFloat(countFp);
        if (isNaN(price) || isNaN(count)) continue;
        cumNotional += count * price;
        if (cumNotional >= RFQListener.LIQUIDITY_THRESHOLD) {
          return { price, thin: false };
        }
      }
      const bestPrice = parseFloat(ob.yes_dollars[0][0]);
      if (!isNaN(bestPrice)) return { price: bestPrice, thin: true };
    }

    return null;
  }

  /**
   * Extract YES implied probability from a Market object.
   * Kalshi API v3 returns prices as dollar strings (e.g., "0.6800" = 68%).
   */
  private static extractProbFromMarket(m: {
    yes_bid_dollars: string; yes_ask_dollars: string;
    no_bid_dollars: string; no_ask_dollars: string;
    last_price_dollars: string;
  }): number | null {
    const yesBid = parseFloat(m.yes_bid_dollars) || 0;
    const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
    const noBid = parseFloat(m.no_bid_dollars) || 0;
    const noAsk = parseFloat(m.no_ask_dollars) || 0;
    const lastPrice = parseFloat(m.last_price_dollars) || 0;

    // Best: midpoint of yes_bid/yes_ask
    if (yesBid > 0 && yesAsk > 0) {
      return (yesBid + yesAsk) / 2;
    }
    // yes_bid alone
    if (yesBid > 0) return yesBid;
    // yes_ask alone
    if (yesAsk > 0 && yesAsk < 1) return yesAsk;
    // Derive from NO side: prob(YES) = 1 - no_price
    if (noBid > 0 && noAsk > 0) {
      return 1 - (noBid + noAsk) / 2;
    }
    if (noBid > 0) return 1 - noBid;
    if (noAsk > 0 && noAsk < 1) return 1 - noAsk;
    // Last resort: last trade price
    if (lastPrice > 0) return lastPrice;
    return null;
  }

  private loggedFirstRfq = false;
  private loggedDiag = false;
  // Cache: event_ticker -> list of single-event market tickers (via mve_filter=exclude)
  private singleEventCache: Map<string, { tickers: string[]; ts: number }> = new Map();

  private async captureLegPrices(rfqId: string, legs: MVELeg[]): Promise<void> {
    // Log raw leg data for the first RFQ
    if (!this.loggedFirstRfq) {
      this.loggedFirstRfq = true;
      logger.info('DIAG: First RFQ raw legs', { rfqId, legCount: legs.length, legs: legs.map(l => JSON.stringify(l).slice(0, 200)) });
    }

    const legPrices: Array<{ ticker: string; side: string; midPrice: number | null }> = [];
    const priceSnapshot: Record<string, number> = {};
    const thinTickers: string[] = [];
    const now = Date.now();
    let priced = 0;

    for (const leg of legs) {
      let price: number | null = null;
      let thin = false;

      // Check cache first
      const cached = this.priceCache.get(leg.market_ticker);
      if (cached && (now - cached.ts) < RFQListener.CACHE_TTL_MS) {
        price = cached.mid;
        thin = cached.thin;
      }

      // Fetch price from API if not cached
      if (price === null && !(this.rateLimited && Date.now() < this.rateLimitedUntil)) {
        // Strategy 1: getMarket (single API call, returns yes_bid/ask/no_bid/ask/last_price)
        const mktResult = await this.tryGetMarket(leg.market_ticker);
        if (mktResult !== null) { price = mktResult; thin = true; }

        // Strategy 2: getOrderbook (depth-weighted price with $100K liquidity threshold)
        if (price === null) {
          const obResult = await this.tryOrderbook(leg.market_ticker);
          if (obResult !== null) { price = obResult.price; thin = obResult.thin; }
        }

        // Cache the result
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

  /** Try getOrderbook for a ticker, return { price, thin } or null */
  private loggedFirstOrderbook = false;
  private async tryOrderbook(ticker: string): Promise<{ price: number; thin: boolean } | null> {
    if (this.rateLimited && Date.now() < this.rateLimitedUntil) return null;
    try {
      await this.rateDelay();
      const resp = await getOrderbook(ticker);
      const ob = resp?.orderbook_fp;
      if (!ob) return null;
      if (!this.loggedFirstOrderbook) {
        this.loggedFirstOrderbook = true;
        logger.info('DIAG: First orderbook', { ticker, noLevels: ob.no_dollars?.length ?? 0, yesLevels: ob.yes_dollars?.length ?? 0, sample: JSON.stringify(ob.no_dollars?.slice(0, 3)) });
      }
      return RFQListener.extractProbFromOrderbook(ob);
    } catch (err) {
      this.handleApiError(err);
      return null;
    }
  }

  /** Try getMarket for a ticker, return YES probability or null */
  private loggedFirstMarketResult = false;
  private async tryGetMarket(ticker: string): Promise<number | null> {
    if (this.rateLimited && Date.now() < this.rateLimitedUntil) return null;
    try {
      await this.rateDelay();
      const mktResp = await getMarket(ticker);
      const m = mktResp?.market;
      if (!m) return null;
      if (!this.loggedFirstMarketResult) {
        this.loggedFirstMarketResult = true;
        const prob = RFQListener.extractProbFromMarket(m);
        logger.info('DIAG: First market price', {
          ticker, yes_bid: m.yes_bid_dollars, yes_ask: m.yes_ask_dollars,
          no_bid: m.no_bid_dollars, no_ask: m.no_ask_dollars,
          last: m.last_price_dollars, prob,
        });
      }
      return RFQListener.extractProbFromMarket(m);
    } catch (err) {
      this.handleApiError(err);
      return null;
    }
  }

  /** Find the single-event market ticker for a combo leg using mve_filter=exclude */
  private async findSingleEventTicker(leg: MVELeg): Promise<string | null> {
    if (this.rateLimited && Date.now() < this.rateLimitedUntil) return null;
    const eventTicker = leg.event_ticker;
    if (!eventTicker) return null;

    const cached = this.singleEventCache.get(eventTicker);
    if (cached && (Date.now() - cached.ts) < 10 * 60_000) {
      return this.matchTicker(leg.market_ticker, cached.tickers);
    }

    try {
      await this.rateDelay();
      const resp = await getMarkets({ event_ticker: eventTicker, mve_filter: 'exclude', status: 'open', limit: '50' });
      const tickers = (resp?.markets || []).map(m => m.ticker);
      this.singleEventCache.set(eventTicker, { tickers, ts: Date.now() });
      if (tickers.length > 0) {
        logger.info('Found single-event markets', { eventTicker, count: tickers.length, sample: tickers.slice(0, 3) });
      }
      return this.matchTicker(leg.market_ticker, tickers);
    } catch (err) {
      this.handleApiError(err);
      return null;
    }
  }

  /** Match a combo leg ticker to a single-event ticker by suffix */
  private matchTicker(comboTicker: string, realTickers: string[]): string | null {
    if (realTickers.length === 0) return null;
    // Exact match
    let match = realTickers.find(t => t === comboTicker);
    // Suffix match (e.g., both end in -CHC)
    if (!match) {
      const lastDash = comboTicker.lastIndexOf('-');
      const suffix = lastDash >= 0 ? comboTicker.slice(lastDash) : '';
      if (suffix) match = realTickers.find(t => t.endsWith(suffix));
    }
    // Single market for event
    if (!match && realTickers.length === 1) match = realTickers[0];
    return match ?? null;
  }

  private async rateDelay(): Promise<void> {
    const elapsed = Date.now() - this.lastApiCall;
    if (elapsed < RFQListener.MIN_API_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, RFQListener.MIN_API_INTERVAL_MS - elapsed));
    }
    this.lastApiCall = Date.now();
  }

  private handleApiError(err: unknown): void {
    const errMsg = String(err);
    if (errMsg.includes('429')) {
      this.rateLimited = true;
      this.rateLimitedUntil = Date.now() + 60_000;
      logger.warn('Rate limited, backing off 60s');
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
