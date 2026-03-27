import { confirmQuote } from '../api/rest';
import { updateQuoteStatus } from '../db/queries';
import { config } from '../config';
import { logger } from '../logger';
import { EventEmitter } from 'events';

interface PendingConfirmation {
  quoteId: string;
  rfqId: string;
  acceptedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * The Confirmer handles the quote acceptance and confirmation flow.
 * When a quote is accepted by the retail user, we must confirm within 30 seconds.
 * We use a 25-second timeout (5-second buffer) for safety.
 */
export class Confirmer extends EventEmitter {
  private pending: Map<string, PendingConfirmation> = new Map();

  /**
   * Handle a quote_accepted event.
   * Must confirm within 30 seconds or the quote expires.
   */
  async handleQuoteAccepted(msg: Record<string, unknown>): Promise<void> {
    const quoteId = msg.quote_id as string ?? msg.id as string;
    const rfqId = msg.rfq_id as string ?? '';

    if (!quoteId) {
      logger.error('Quote accepted but no quote_id in message');
      return;
    }

    const acceptedAt = Date.now();
    logger.info('Quote accepted, confirming...', { quoteId, rfqId });

    // Update database
    updateQuoteStatus(quoteId, 'accepted', 'accepted_at');

    // Set a safety timeout — if we can't confirm in time, log it
    const timeout = setTimeout(() => {
      logger.error('Confirmation timeout reached', { quoteId });
      this.pending.delete(quoteId);
    }, config.risk.confirmationTimeoutMs);

    this.pending.set(quoteId, { quoteId, rfqId, acceptedAt, timeout });

    try {
      // Confirm immediately
      if (config.bot.paperMode) {
        logger.info('PAPER MODE: Would confirm quote', { quoteId });
        updateQuoteStatus(quoteId, 'confirmed', 'confirmed_at');
        this.emit('confirmed', { quoteId, rfqId });
      } else {
        const result = await confirmQuote(quoteId);
        updateQuoteStatus(quoteId, 'confirmed', 'confirmed_at');

        const latencyMs = Date.now() - acceptedAt;
        logger.info('Quote confirmed', { quoteId, latencyMs });

        this.emit('confirmed', { quoteId, rfqId, latencyMs });
      }
    } catch (err) {
      logger.error('Failed to confirm quote', {
        quoteId,
        error: String(err),
        timeSinceAcceptMs: Date.now() - acceptedAt,
      });
      updateQuoteStatus(quoteId, 'confirmation_failed');
      this.emit('confirmation_failed', { quoteId, rfqId, error: String(err) });
    } finally {
      clearTimeout(timeout);
      this.pending.delete(quoteId);
    }
  }

  /**
   * Handle a quote_executed event (fill).
   */
  handleQuoteExecuted(msg: Record<string, unknown>): void {
    const quoteId = msg.quote_id as string ?? msg.id as string;
    const rfqId = msg.rfq_id as string ?? '';

    logger.info('Quote executed (filled)', { quoteId, rfqId });
    updateQuoteStatus(quoteId, 'executed', 'executed_at');

    this.emit('executed', { quoteId, rfqId, msg });
  }

  /**
   * Handle a quote_cancelled event.
   */
  handleQuoteCancelled(msg: Record<string, unknown>): void {
    const quoteId = msg.quote_id as string ?? msg.id as string;
    logger.info('Quote cancelled', { quoteId });
    updateQuoteStatus(quoteId, 'cancelled');

    // Clean up any pending confirmation
    const pending = this.pending.get(quoteId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(quoteId);
    }
  }

  getPendingCount(): number {
    return this.pending.size;
  }
}
