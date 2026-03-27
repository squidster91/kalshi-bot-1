import { OrderbookManager } from '../api/websocket';
import { submitQuote } from '../api/rest';
import { ParsedRFQ } from './listener';
import { getLegPrices, naiveComboPrice } from '../pricing/marginals';
import { computeJointProbability } from '../pricing/copula';
import { calculateSpread, computeQuotePrices } from '../pricing/spreads';
import { checkRiskLimits } from '../risk/limits';
import { getInventorySkew } from '../risk/inventory';
import { getContractSizeAdjustment } from '../risk/inventory';
import { insertQuote, markRFQQuoted } from '../db/queries';
import { config } from '../config';
import { logger } from '../logger';
import { EventEmitter } from 'events';

export interface QuoteDecision {
  rfqId: string;
  quoted: boolean;
  reason?: string;
  fairValue?: number;
  naiveValue?: number;
  spread?: number;
  yesBid?: number;
  noBid?: number;
  contracts?: number;
  quoteId?: string;
}

/**
 * The Quoter decides whether to quote an RFQ and at what price.
 * It combines the pricing engine with risk checks to produce quotes.
 */
export class Quoter extends EventEmitter {
  private orderbookManager: OrderbookManager;
  private quoteCount = 0;
  private fillCount = 0;

  constructor(orderbookManager: OrderbookManager) {
    super();
    this.orderbookManager = orderbookManager;
  }

  async processRFQ(rfq: ParsedRFQ): Promise<QuoteDecision> {
    const startTime = Date.now();

    try {
      // 1. Get current prices for all legs
      const legPrices = getLegPrices(rfq.legs, this.orderbookManager);

      // Check for stale or missing prices
      const stalLegs = legPrices.filter((l) => l.isStale);
      if (stalLegs.length > 0) {
        return this.skip(rfq.id, `Stale prices for ${stalLegs.length} legs: ${stalLegs.map(l => l.ticker).join(', ')}`);
      }

      const missingPrices = legPrices.filter((l) => l.probability === 0);
      if (missingPrices.length > 0) {
        return this.skip(rfq.id, `Missing prices for ${missingPrices.length} legs`);
      }

      // 2. Compute fair value
      const naiveValue = naiveComboPrice(legPrices);
      const fairValue = computeJointProbability(legPrices);

      // 3. Calculate spread
      const spreadResult = calculateSpread(rfq.legs, fairValue);
      const inventorySkew = getInventorySkew(rfq.eventTicker);
      const totalSpread = spreadResult.spread + inventorySkew;

      // 4. Enforce minimum spread
      if (totalSpread < config.spread.minSpread) {
        return this.skip(rfq.id, `Spread ${totalSpread.toFixed(4)} below minimum ${config.spread.minSpread}`);
      }

      // 5. Compute quote prices
      const { yesBid, noBid } = computeQuotePrices(fairValue, totalSpread);

      // 6. Determine contract size
      const contracts = getContractSizeAdjustment(
        Math.min(rfq.contractsRequested, config.risk.maxContractsPerQuote),
        rfq.eventTicker
      );

      // 7. Risk checks
      const riskCheck = checkRiskLimits({
        eventTicker: rfq.eventTicker,
        comboPrice: yesBid,
        contractsRequested: contracts,
      });

      if (!riskCheck.allowed) {
        return this.skip(rfq.id, `Risk check failed: ${riskCheck.reason}`);
      }

      // 8. Check if our price is competitive with what the user wants to pay
      // The user's target cost represents what they hope to pay per YES contract
      // Our yesBid should be somewhat close to their target to have a chance of filling
      if (rfq.targetCostDollars > 0 && yesBid > rfq.targetCostDollars * 1.5) {
        return this.skip(rfq.id,
          `Our price $${yesBid.toFixed(4)} too far from target $${rfq.targetCostDollars.toFixed(4)}`
        );
      }

      // 9. Submit quote (or log in paper mode)
      if (config.bot.paperMode || !config.bot.quotingEnabled) {
        logger.info('PAPER MODE: Would submit quote', {
          rfqId: rfq.id,
          fairValue: fairValue.toFixed(4),
          naiveValue: naiveValue.toFixed(4),
          spread: totalSpread.toFixed(4),
          yesBid: yesBid.toFixed(4),
          noBid: noBid.toFixed(4),
          contracts,
          targetCost: rfq.targetCostDollars.toFixed(4),
          latencyMs: Date.now() - startTime,
        });

        return {
          rfqId: rfq.id,
          quoted: false,
          reason: 'Paper mode',
          fairValue,
          naiveValue,
          spread: totalSpread,
          yesBid,
          noBid,
          contracts,
        };
      }

      // Submit real quote
      const result = await submitQuote({
        rfq_id: rfq.id,
        yes_bid_dollars: yesBid.toFixed(2),
        no_bid_dollars: noBid.toFixed(2),
        yes_contracts_fp: contracts.toString(),
        no_contracts_fp: contracts.toString(),
      });

      const quoteId = result.quote.id;
      this.quoteCount++;

      // Record in database
      insertQuote({
        id: quoteId,
        rfq_id: rfq.id,
        yes_bid_dollars: yesBid.toFixed(2),
        no_bid_dollars: noBid.toFixed(2),
        yes_contracts: contracts.toString(),
        no_contracts: contracts.toString(),
        fair_value_computed: fairValue,
        spread_applied: totalSpread,
      });
      markRFQQuoted(rfq.id, quoteId, yesBid.toFixed(2), noBid.toFixed(2));

      logger.info('Quote submitted', {
        rfqId: rfq.id,
        quoteId,
        fairValue: fairValue.toFixed(4),
        yesBid: yesBid.toFixed(4),
        contracts,
        latencyMs: Date.now() - startTime,
      });

      this.emit('quote_submitted', {
        rfqId: rfq.id,
        quoteId,
        fairValue,
        yesBid,
        noBid,
        contracts,
      });

      return {
        rfqId: rfq.id,
        quoted: true,
        fairValue,
        naiveValue,
        spread: totalSpread,
        yesBid,
        noBid,
        contracts,
        quoteId,
      };
    } catch (err) {
      logger.error('Error processing RFQ for quoting', {
        rfqId: rfq.id,
        error: String(err),
      });
      return this.skip(rfq.id, `Error: ${String(err)}`);
    }
  }

  private skip(rfqId: string, reason: string): QuoteDecision {
    logger.debug('Skipping RFQ', { rfqId, reason });
    return { rfqId, quoted: false, reason };
  }

  getStats(): { quoteCount: number; fillCount: number } {
    return { quoteCount: this.quoteCount, fillCount: this.fillCount };
  }

  recordFill(): void {
    this.fillCount++;
  }
}
