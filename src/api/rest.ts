import { config } from '../config';
import { getAuthHeaders } from '../auth';
import { logger } from '../logger';

interface RequestOptions {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}

interface RateLimitState {
  remaining: number;
  resetAt: number;
  queue: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    options: RequestOptions;
  }>;
  processing: boolean;
}

const rateLimiter: RateLimitState = {
  remaining: 100,
  resetAt: 0,
  queue: [],
  processing: false,
};

async function processQueue(): Promise<void> {
  if (rateLimiter.processing || rateLimiter.queue.length === 0) return;
  rateLimiter.processing = true;

  while (rateLimiter.queue.length > 0) {
    if (rateLimiter.remaining <= 1 && Date.now() < rateLimiter.resetAt) {
      const waitMs = rateLimiter.resetAt - Date.now() + 100;
      logger.warn(`Rate limit near, waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const item = rateLimiter.queue.shift()!;
    try {
      const result = await executeRequest(item.options);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
  }

  rateLimiter.processing = false;
}

async function executeRequest(options: RequestOptions): Promise<unknown> {
  const { method, path, body, params } = options;

  let url = `${config.kalshi.baseUrl}${path}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  const bodyStr = body ? JSON.stringify(body) : '';
  const apiPath = `/trade-api/v2${path}${params ? '?' + new URLSearchParams(params).toString() : ''}`;
  const headers = getAuthHeaders(method, apiPath, bodyStr);

  const response = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  // Update rate limit tracking from response headers
  const remaining = response.headers.get('ratelimit-remaining');
  const reset = response.headers.get('ratelimit-reset');
  if (remaining) rateLimiter.remaining = parseInt(remaining);
  if (reset) rateLimiter.resetAt = Date.now() + parseInt(reset) * 1000;

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Kalshi API error ${response.status} ${method} ${path}: ${errorBody}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function request<T = unknown>(options: RequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    rateLimiter.queue.push({
      resolve: resolve as (value: unknown) => void,
      reject,
      options,
    });
    processQueue();
  }) as Promise<T>;
}

// ── Market Data ──

export interface Market {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  category: string;
  result?: string;
}

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface Orderbook {
  yes: OrderbookLevel[];
  no: OrderbookLevel[];
  market_ticker: string;
}

export async function getMarkets(params: {
  status?: string;
  event_ticker?: string;
  series_ticker?: string;
  cursor?: string;
  limit?: string;
  mve_filter?: string;
}): Promise<{ markets: Market[]; cursor: string }> {
  const queryParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) queryParams[k] = v;
  }
  return request({ method: 'GET', path: '/markets', params: queryParams });
}

export async function getMarket(ticker: string): Promise<{ market: Market }> {
  return request({ method: 'GET', path: `/markets/${ticker}` });
}

export async function getOrderbook(ticker: string): Promise<{ orderbook: Orderbook }> {
  return request({ method: 'GET', path: `/markets/${ticker}/orderbook` });
}

export async function getMultivariateEventCollections(params?: {
  cursor?: string;
  limit?: string;
}): Promise<{ collections: unknown[]; cursor: string }> {
  const queryParams: Record<string, string> = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) queryParams[k] = v;
    }
  }
  return request({ method: 'GET', path: '/multivariate_event_collections', params: queryParams });
}

// ── Communications / RFQ ──

export interface RFQ {
  id: string;
  creator_id: string;
  market_ticker: string;
  event_ticker: string;
  contracts_fp: string;
  target_cost_dollars: string;
  created_ts: string;
  mve_selected_legs?: MVELeg[];
}

export interface MVELeg {
  event_ticker: string;
  market_ticker: string;
  side: string;
  yes_settlement_value_dollars: string;
}

export async function getCommunicationsId(): Promise<{ communications_id: string }> {
  return request({ method: 'GET', path: '/communications/id' });
}

export async function getRFQs(params?: {
  status?: string;
  cursor?: string;
}): Promise<{ rfqs: RFQ[]; cursor: string }> {
  const queryParams: Record<string, string> = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) queryParams[k] = v;
    }
  }
  return request({ method: 'GET', path: '/communications/rfqs', params: queryParams });
}

export interface QuoteSubmission {
  rfq_id: string;
  yes_bid_dollars: string;
  no_bid_dollars: string;
  yes_contracts_fp: string;
  no_contracts_fp: string;
}

export interface Quote {
  id: string;
  rfq_id: string;
  status: string;
  yes_bid_dollars: string;
  no_bid_dollars: string;
  yes_contracts_fp: string;
  no_contracts_fp: string;
  created_ts: string;
}

export async function submitQuote(quote: QuoteSubmission): Promise<{ quote: Quote }> {
  return request({
    method: 'POST',
    path: '/communications/quotes',
    body: quote as unknown as Record<string, unknown>,
  });
}

export async function confirmQuote(quoteId: string): Promise<{ quote: Quote }> {
  return request({
    method: 'PUT',
    path: `/communications/quotes/${quoteId}/confirm`,
  });
}

// ── Portfolio ──

export interface Position {
  market_ticker: string;
  event_ticker: string;
  yes_contracts: number;
  no_contracts: number;
  avg_yes_price: number;
  avg_no_price: number;
  realized_pnl: number;
}

export async function getPositions(params?: {
  cursor?: string;
  limit?: string;
  event_ticker?: string;
  settlement_status?: string;
}): Promise<{ market_positions: Position[]; cursor: string }> {
  const queryParams: Record<string, string> = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) queryParams[k] = v;
    }
  }
  return request({ method: 'GET', path: '/portfolio/positions', params: queryParams });
}

export interface Balance {
  balance: number;
  available_balance: number;
}

export async function getBalance(): Promise<Balance> {
  return request({ method: 'GET', path: '/portfolio/balance' });
}
