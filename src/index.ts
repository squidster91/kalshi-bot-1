import { config } from './config';
import { logger, setLogLevel, LogLevel } from './logger';
import { getDb, closeDb } from './db/schema';
import { OrderbookManager, CommunicationsManager } from './api/websocket';
import { getMarkets, getBalance, getCommunicationsId } from './api/rest';
import { RFQListener, ParsedRFQ } from './rfq/listener';
import { Quoter } from './rfq/quoter';
import { Confirmer } from './rfq/confirmer';
import { recordFill } from './risk/positions';
import { getRiskUtilization, activateKillSwitch, isKillSwitchActive } from './risk/limits';
import { getTodayPnL, getTodayStats, logPnL } from './db/queries';
import { buildCorrelationMatrix } from './data/correlation-builder';
import { sendTelegramMessage, notifyFill, notifyRiskWarning, notifyKillSwitch, notifyDailySummary, notifyError } from './notifications';
import { startDashboard } from './dashboard/server';

class KalshiMMBot {
  private orderbookManager: OrderbookManager;
  private commsManager: CommunicationsManager;
  private rfqListener: RFQListener;
  private quoter: Quoter;
  private confirmer: Confirmer;
  private riskCheckInterval: ReturnType<typeof setInterval> | null = null;
  private dailySummaryInterval: ReturnType<typeof setInterval> | null = null;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private correlationInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor() {
    this.orderbookManager = new OrderbookManager();
    this.commsManager = new CommunicationsManager();
    this.rfqListener = new RFQListener(this.commsManager);
    this.quoter = new Quoter(this.orderbookManager);
    this.confirmer = new Confirmer();
  }

  async start(): Promise<void> {
    logger.info('=== KalshiMM Bot Starting ===');
    logger.info('Configuration', {
      env: config.kalshi.env,
      paperMode: config.bot.paperMode,
      quotingEnabled: config.bot.quotingEnabled,
      maxContractsPerQuote: config.risk.maxContractsPerQuote,
      maxDailyLoss: config.risk.maxDailyLoss,
    });

    // Initialize database
    getDb();

    // Build correlation matrix (uses defaults if insufficient snapshot data)
    await buildCorrelationMatrix();

    // Check balance (validates API credentials)
    try {
      const balance = await getBalance();
      logger.info('Account balance', {
        balance: balance.balance,
        available: balance.available_balance,
      });
    } catch (err) {
      logger.warn('Could not fetch balance (API key may not be configured)', {
        error: String(err),
      });
    }

    // Fetch active NBA markets and subscribe to orderbooks
    await this.subscribeToNBAMarkets();

    // Connect WebSockets
    try {
      await this.orderbookManager.connect();
      logger.info('Orderbook WebSocket connected');
    } catch (err) {
      logger.error('Failed to connect orderbook WebSocket', { error: String(err) });
    }

    try {
      await this.commsManager.connect();
      logger.info('Communications WebSocket connected');
    } catch (err) {
      logger.error('Failed to connect communications WebSocket', { error: String(err) });
    }

    // Wire up RFQ processing pipeline
    this.setupRFQPipeline();

    // Start periodic tasks
    this.startPeriodicTasks();

    // Handle graceful shutdown
    this.setupShutdownHandlers();

    // Start web dashboard
    startDashboard();

    logger.info('=== KalshiMM Bot Running ===');
    await sendTelegramMessage(`KalshiMM Bot started (${config.kalshi.env} mode, paper=${config.bot.paperMode})`);
  }

  private async subscribeToNBAMarkets(): Promise<void> {
    try {
      const tickers: string[] = [];
      let cursor: string | undefined;

      // Paginate through all active NBA markets
      do {
        const params: Record<string, string> = {
          status: 'open',
          limit: '200',
        };
        if (cursor) params.cursor = cursor;

        const result = await getMarkets(params);
        const nbaMarkets = result.markets.filter((m) =>
          m.ticker.toUpperCase().startsWith('NBA')
        );
        tickers.push(...nbaMarkets.map((m) => m.ticker));
        cursor = result.cursor || undefined;
      } while (cursor);

      if (tickers.length > 0) {
        this.orderbookManager.subscribeMarkets(tickers);
        logger.info(`Subscribed to ${tickers.length} NBA markets`);
      } else {
        logger.warn('No active NBA markets found');
      }
    } catch (err) {
      logger.error('Failed to fetch NBA markets', { error: String(err) });
    }
  }

  private setupRFQPipeline(): void {
    // Start the RFQ listener
    this.rfqListener.start();

    // Process each RFQ through the quoter
    this.rfqListener.on('rfq', async (rfq: ParsedRFQ) => {
      if (this.shuttingDown || isKillSwitchActive()) return;
      await this.quoter.processRFQ(rfq);
    });

    // Handle quote lifecycle events from communications WebSocket
    this.commsManager.on('quote_accepted', async (msg: Record<string, unknown>) => {
      await this.confirmer.handleQuoteAccepted(msg);
    });

    this.commsManager.on('quote_executed', (msg: Record<string, unknown>) => {
      this.confirmer.handleQuoteExecuted(msg);
    });

    this.commsManager.on('quote_cancelled', (msg: Record<string, unknown>) => {
      this.confirmer.handleQuoteCancelled(msg);
    });

    // Handle confirmed quotes (fills)
    this.confirmer.on('executed', (data: {
      quoteId: string;
      rfqId: string;
      msg: Record<string, unknown>;
    }) => {
      this.quoter.recordFill();
      const price = parseFloat(data.msg.yes_bid_dollars as string ?? '0');
      const contracts = parseInt(data.msg.yes_contracts_fp as string ?? '0');

      if (price > 0 && contracts > 0) {
        recordFill({
          market_ticker: data.msg.market_ticker as string ?? '',
          event_ticker: data.msg.event_ticker as string ?? '',
          side: 'no', // We're selling YES / taking NO
          contracts,
          price,
        });

        logPnL({
          event_type: 'fill',
          market_ticker: data.msg.market_ticker as string,
          rfq_id: data.rfqId,
          amount: 0, // P&L realized at settlement
          details: `Sold YES at $${price.toFixed(4)}, ${contracts} contracts`,
        });

        notifyFill({ quoteId: data.quoteId, rfqId: data.rfqId, yesBid: price, contracts });
      }
    });

    logger.info('RFQ pipeline configured');
  }

  private startPeriodicTasks(): void {
    // Risk utilization check every 60 seconds
    this.riskCheckInterval = setInterval(() => {
      const risk = getRiskUtilization();
      if (risk.warnings.length > 0) {
        logger.warn('Risk warnings', { warnings: risk.warnings });
        notifyRiskWarning(risk.warnings);
      }
    }, 60_000);

    // Snapshot mid-prices every 5 minutes for correlation analysis
    this.snapshotInterval = setInterval(() => {
      try {
        this.orderbookManager.snapshotPrices();
      } catch (err) {
        logger.error('Failed to snapshot prices', { error: String(err) });
      }
    }, 5 * 60_000);

    // Recalculate correlations from snapshots every hour
    this.correlationInterval = setInterval(async () => {
      try {
        await buildCorrelationMatrix();
      } catch (err) {
        logger.error('Failed to rebuild correlation matrix', { error: String(err) });
      }
    }, 60 * 60_000);

    // Daily summary at the end of each day (check every 5 minutes)
    this.dailySummaryInterval = setInterval(async () => {
      const now = new Date();
      // Send daily summary at 11:55 PM
      if (now.getHours() === 23 && now.getMinutes() >= 55 && now.getMinutes() < 60) {
        const stats = getTodayStats();
        const pnl = getTodayPnL();
        await notifyDailySummary({ ...stats, pnl });
      }
    }, 5 * 60_000);
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      logger.info(`Shutdown signal received: ${signal}`);

      // Stop periodic tasks
      if (this.riskCheckInterval) clearInterval(this.riskCheckInterval);
      if (this.dailySummaryInterval) clearInterval(this.dailySummaryInterval);
      if (this.snapshotInterval) clearInterval(this.snapshotInterval);
      if (this.correlationInterval) clearInterval(this.correlationInterval);

      // Close WebSocket connections
      this.orderbookManager.close();
      this.commsManager.close();

      // Close database
      closeDb();

      await sendTelegramMessage(`KalshiMM Bot shutting down (${signal})`);
      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', async (err) => {
      logger.error('Uncaught exception', { error: String(err), stack: err.stack });
      activateKillSwitch(`Uncaught exception: ${err.message}`);
      await notifyError(`Uncaught exception: ${err.message}`);
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error('Unhandled rejection', { reason: String(reason) });
      await notifyError(`Unhandled rejection: ${String(reason)}`);
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.riskCheckInterval) clearInterval(this.riskCheckInterval);
    if (this.dailySummaryInterval) clearInterval(this.dailySummaryInterval);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.correlationInterval) clearInterval(this.correlationInterval);
    this.orderbookManager.close();
    this.commsManager.close();
    closeDb();
  }
}

// ── Main ──

async function main(): Promise<void> {
  setLogLevel((config.bot.logLevel ?? 'info') as LogLevel);

  const bot = new KalshiMMBot();
  await bot.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
