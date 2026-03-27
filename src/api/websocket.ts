import WebSocket from 'ws';
import { config } from '../config';
import { getAuthHeaders } from '../auth';
import { logger } from '../logger';
import { EventEmitter } from 'events';
import { insertPriceSnapshot } from '../db/queries';

export interface WSMessage {
  id?: number;
  type: string;
  sid?: number;
  msg?: Record<string, unknown>;
  cmd?: string;
  params?: Record<string, unknown>;
}

interface ReconnectState {
  attempts: number;
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

export class KalshiWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private subscriptions: Map<string, Record<string, unknown>> = new Map();
  private reconnect: ReconnectState = {
    attempts: 0,
    maxAttempts: 20,
    baseDelay: 1000,
    maxDelay: 60000,
  };
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private messageId = 0;
  private connected = false;
  private closing = false;

  constructor(private name: string) {
    super();
    this.url = config.kalshi.wsUrl;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closing) return reject(new Error('WebSocket is closing'));

      const authPath = '/trade-api/ws/v2';
      const headers = getAuthHeaders('GET', authPath);

      logger.info(`[WS:${this.name}] Connecting to ${this.url}`);

      this.ws = new WebSocket(this.url, {
        headers,
      });

      this.ws.on('open', () => {
        logger.info(`[WS:${this.name}] Connected`);
        this.connected = true;
        this.reconnect.attempts = 0;
        this.startPingInterval();
        this.resubscribe();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          this.emit('message', msg);
          if (msg.type) {
            this.emit(msg.type, msg);
          }
        } catch (err) {
          logger.error(`[WS:${this.name}] Failed to parse message`, {
            error: String(err),
            raw: data.toString().slice(0, 200),
          });
        }
      });

      this.ws.on('close', (code, reason) => {
        logger.warn(`[WS:${this.name}] Disconnected`, {
          code,
          reason: reason.toString(),
        });
        this.connected = false;
        this.stopPingInterval();
        if (!this.closing) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        logger.error(`[WS:${this.name}] Error`, { error: String(err) });
        if (!this.connected) {
          reject(err);
        }
      });
    });
  }

  subscribe(channel: string, params: Record<string, unknown> = {}): void {
    const key = `${channel}:${JSON.stringify(params)}`;
    this.subscriptions.set(key, { channel, ...params });

    if (this.connected) {
      this.sendSubscribe(channel, params);
    }
  }

  private sendSubscribe(channel: string, params: Record<string, unknown>): void {
    this.send({
      id: ++this.messageId,
      cmd: 'subscribe',
      params: {
        channels: [channel],
        ...params,
      },
    });
  }

  private resubscribe(): void {
    for (const [, sub] of this.subscriptions) {
      const { channel, ...params } = sub as { channel: string } & Record<string, unknown>;
      this.sendSubscribe(channel, params);
    }
  }

  send(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`[WS:${this.name}] Cannot send, not connected`);
      return;
    }
    this.ws.send(JSON.stringify(data));
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30_000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnect.attempts >= this.reconnect.maxAttempts) {
      logger.error(`[WS:${this.name}] Max reconnection attempts reached`);
      this.emit('max_reconnects');
      return;
    }

    const delay = Math.min(
      this.reconnect.baseDelay * Math.pow(2, this.reconnect.attempts),
      this.reconnect.maxDelay
    );
    this.reconnect.attempts++;

    logger.info(`[WS:${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnect.attempts})`);

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        logger.error(`[WS:${this.name}] Reconnection failed`, { error: String(err) });
      }
    }, delay);
  }

  close(): void {
    this.closing = true;
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// ── Orderbook WebSocket Manager ──
// Maintains live mid-prices for all subscribed markets

export interface OrderbookState {
  ticker: string;
  yesBid: number;
  yesAsk: number;
  midPrice: number;
  lastUpdate: number;
}

export class OrderbookManager extends EventEmitter {
  private ws: KalshiWebSocket;
  private orderbooks: Map<string, OrderbookState> = new Map();

  constructor() {
    super();
    this.ws = new KalshiWebSocket('orderbook');
  }

  async connect(): Promise<void> {
    await this.ws.connect();

    this.ws.on('orderbook_snapshot', (msg: WSMessage) => {
      this.handleSnapshot(msg);
    });

    this.ws.on('orderbook_delta', (msg: WSMessage) => {
      this.handleDelta(msg);
    });
  }

  subscribeMarket(ticker: string): void {
    this.ws.subscribe('orderbook_delta', { market_tickers: [ticker] });
  }

  subscribeMarkets(tickers: string[]): void {
    // Kalshi may limit subscriptions per message; batch if needed
    const batchSize = 50;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      this.ws.subscribe('orderbook_delta', { market_tickers: batch });
    }
  }

  private handleSnapshot(msg: WSMessage): void {
    const data = msg.msg;
    if (!data) return;
    const ticker = data.market_ticker as string;
    const yes = data.yes as Array<[number, number]> | undefined;
    const no = data.no as Array<[number, number]> | undefined;

    const bestYesBid = yes && yes.length > 0 ? yes[0][0] / 100 : 0;
    const bestYesAsk = no && no.length > 0 ? (100 - no[0][0]) / 100 : 1;
    const mid = (bestYesBid + bestYesAsk) / 2;

    const state: OrderbookState = {
      ticker,
      yesBid: bestYesBid,
      yesAsk: bestYesAsk,
      midPrice: mid,
      lastUpdate: Date.now(),
    };

    this.orderbooks.set(ticker, state);
    this.emit('update', state);
  }

  private handleDelta(msg: WSMessage): void {
    const data = msg.msg;
    if (!data) return;
    const ticker = data.market_ticker as string;

    const existing = this.orderbooks.get(ticker);
    if (!existing) {
      // If we get a delta before snapshot, request fresh data
      return;
    }

    const price = data.price as number | undefined;
    const side = data.side as string | undefined;
    // Deltas update specific levels; for simplicity, recalculate mid from best bid/ask
    // In production, maintain full orderbook; for now, use price hints
    if (price !== undefined && side) {
      if (side === 'yes') {
        existing.yesBid = price / 100;
      } else {
        existing.yesAsk = (100 - price) / 100;
      }
      existing.midPrice = (existing.yesBid + existing.yesAsk) / 2;
      existing.lastUpdate = Date.now();
      this.emit('update', existing);
    }
  }

  getMidPrice(ticker: string): number | null {
    const state = this.orderbooks.get(ticker);
    if (!state) return null;
    return state.midPrice;
  }

  getState(ticker: string): OrderbookState | null {
    return this.orderbooks.get(ticker) ?? null;
  }

  isStale(ticker: string, thresholdMs: number): boolean {
    const state = this.orderbooks.get(ticker);
    if (!state) return true;
    return Date.now() - state.lastUpdate > thresholdMs;
  }

  /**
   * Return all current mid-prices as a Map<ticker, midPrice>.
   */
  getAllMidPrices(): Map<string, number> {
    const prices = new Map<string, number>();
    for (const [ticker, state] of this.orderbooks) {
      prices.set(ticker, state.midPrice);
    }
    return prices;
  }

  /**
   * Snapshot all current mid-prices to the database for correlation analysis.
   */
  snapshotPrices(): void {
    const prices = this.getAllMidPrices();
    let count = 0;
    for (const [ticker, midPrice] of prices) {
      // Skip degenerate prices (0 or 1 indicate no real orderbook)
      if (midPrice > 0.01 && midPrice < 0.99) {
        insertPriceSnapshot(ticker, midPrice);
        count++;
      }
    }
    logger.info(`Snapshotted ${count} mid-prices to database`);
  }

  close(): void {
    this.ws.close();
  }
}

// ── Communications WebSocket Manager ──
// Listens for RFQ events

export class CommunicationsManager extends EventEmitter {
  private ws: KalshiWebSocket;

  constructor() {
    super();
    this.ws = new KalshiWebSocket('communications');
  }

  async connect(): Promise<void> {
    await this.ws.connect();

    this.ws.on('message', (msg: WSMessage) => {
      if (!msg.type) return;

      switch (msg.type) {
        case 'rfq_created':
          this.emit('rfq_created', msg.msg);
          break;
        case 'rfq_deleted':
          this.emit('rfq_deleted', msg.msg);
          break;
        case 'quote_accepted':
          this.emit('quote_accepted', msg.msg);
          break;
        case 'quote_executed':
          this.emit('quote_executed', msg.msg);
          break;
        case 'quote_cancelled':
          this.emit('quote_cancelled', msg.msg);
          break;
        default:
          logger.debug(`[Comms] Unhandled message type: ${msg.type}`);
      }
    });

    // Subscribe to the communications channel
    this.ws.subscribe('communications');
  }

  close(): void {
    this.ws.close();
  }
}
