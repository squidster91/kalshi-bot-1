/**
 * Debug script: fetch a real orderbook from Kalshi API and dump raw data.
 * Compares best-level price vs $100K depth price.
 *
 * Usage: npx tsx scripts/debug-orderbook.ts [TICKER]
 * Default ticker: KXMLBGAME-26MAR282110AZLAD-LAD (or first active MLB market)
 */
import { config } from '../src/config';
import { getAuthHeaders } from '../src/auth';

const LIQUIDITY_THRESHOLD = 100_000;

async function apiRequest(method: string, path: string): Promise<unknown> {
  const url = `${config.kalshi.baseUrl}${path}`;
  const apiPath = `/trade-api/v2${path}`;
  const headers = getAuthHeaders(method, apiPath, '');
  const resp = await fetch(url, { method, headers });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function debugOrderbook(ticker: string) {
  console.log(`\n=== ORDERBOOK DEBUG: ${ticker} ===`);
  console.log(`API: ${config.kalshi.baseUrl}`);
  console.log(`Env: ${config.kalshi.env}\n`);

  // 1. Fetch the market to see Kalshi's displayed prices
  console.log('--- MARKET DATA (what Kalshi shows) ---');
  try {
    const mktResp = await apiRequest('GET', `/markets/${ticker}`) as { market: Record<string, unknown> };
    const m = mktResp.market;
    console.log(`  yes_bid_dollars: ${m.yes_bid_dollars}`);
    console.log(`  yes_ask_dollars: ${m.yes_ask_dollars}`);
    console.log(`  no_bid_dollars:  ${m.no_bid_dollars}`);
    console.log(`  no_ask_dollars:  ${m.no_ask_dollars}`);
    console.log(`  last_price_dollars: ${m.last_price_dollars}`);
    console.log(`  title: ${m.title}`);
    console.log(`  status: ${m.status}`);

    const yesBid = parseFloat(m.yes_bid_dollars as string) || 0;
    const yesAsk = parseFloat(m.yes_ask_dollars as string) || 0;
    const noBid = parseFloat(m.no_bid_dollars as string) || 0;
    const noAsk = parseFloat(m.no_ask_dollars as string) || 0;

    if (yesBid > 0 && yesAsk > 0) {
      console.log(`  → YES mid: ${((yesBid + yesAsk) / 2 * 100).toFixed(2)}%`);
    }
    if (noBid > 0 && noAsk > 0) {
      console.log(`  → NO mid:  ${((noBid + noAsk) / 2 * 100).toFixed(2)}%`);
      console.log(`  → YES from NO mid: ${((1 - (noBid + noAsk) / 2) * 100).toFixed(2)}%`);
    }
  } catch (err) {
    console.log(`  Error: ${err}`);
  }

  // 2. Fetch orderbook
  console.log('\n--- RAW ORDERBOOK ---');
  try {
    const obResp = await apiRequest('GET', `/markets/${ticker}/orderbook`) as Record<string, unknown>;

    // Show what wrapper key the response uses
    console.log(`  Response keys: ${Object.keys(obResp).join(', ')}`);

    // Try both possible wrapper keys
    const ob = (obResp as any).orderbook_fp || (obResp as any).orderbook;
    if (!ob) {
      console.log('  ERROR: No orderbook or orderbook_fp in response!');
      console.log('  Full response:', JSON.stringify(obResp).slice(0, 500));
      return;
    }

    console.log(`  Orderbook keys: ${Object.keys(ob).join(', ')}`);

    // Check all possible field names
    const noSide = ob.no_dollars || ob.no;
    const yesSide = ob.yes_dollars || ob.yes;

    console.log(`\n  NO side: ${noSide?.length || 0} levels`);
    if (noSide && noSide.length > 0) {
      // Dump first 10 levels
      console.log('  Level | Price ($) | Count    | Notional   | Type');
      console.log('  ------|-----------|----------|------------|-----');
      let cumNotional = 0;
      let crossedAt: number | null = null;
      for (let i = 0; i < Math.min(noSide.length, 15); i++) {
        const level = noSide[i];
        let price: number, count: number;

        // Handle both formats: [string, string] tuples or {price, quantity} objects
        if (Array.isArray(level)) {
          price = parseFloat(level[0]);
          count = parseFloat(level[1]);
        } else {
          price = level.price / 100; // old format uses cents
          count = level.quantity;
        }

        const notional = count * price;
        cumNotional += notional;
        const crossed = crossedAt === null && cumNotional >= LIQUIDITY_THRESHOLD;
        if (crossed) crossedAt = i;

        console.log(`  ${String(i).padStart(5)} | $${price.toFixed(4).padStart(7)} | ${count.toFixed(0).padStart(8)} | $${cumNotional.toFixed(0).padStart(9)} | ${crossed ? '← $100K CROSSED' : ''}`);
      }

      const bestNoPrice = Array.isArray(noSide[0]) ? parseFloat(noSide[0][0]) : noSide[0].price / 100;
      console.log(`\n  Best NO level: $${bestNoPrice.toFixed(4)} → P(YES) = ${((1 - bestNoPrice) * 100).toFixed(2)}%`);

      if (crossedAt !== null) {
        const crossLevel = noSide[crossedAt];
        const crossPrice = Array.isArray(crossLevel) ? parseFloat(crossLevel[0]) : crossLevel.price / 100;
        console.log(`  $100K depth NO: $${crossPrice.toFixed(4)} → P(YES) = ${((1 - crossPrice) * 100).toFixed(2)}% (at level ${crossedAt})`);
        console.log(`  Depth impact: ${((bestNoPrice - crossPrice) * 100).toFixed(2)} cents`);
      } else {
        console.log(`  THIN: Only $${cumNotional.toFixed(0)} notional across ${noSide.length} levels (need $${LIQUIDITY_THRESHOLD.toLocaleString()})`);
      }
    }

    console.log(`\n  YES side: ${yesSide?.length || 0} levels`);
    if (yesSide && yesSide.length > 0) {
      console.log('  Level | Price ($) | Count    | Notional   | Type');
      console.log('  ------|-----------|----------|------------|-----');
      let cumNotional = 0;
      for (let i = 0; i < Math.min(yesSide.length, 10); i++) {
        const level = yesSide[i];
        let price: number, count: number;
        if (Array.isArray(level)) {
          price = parseFloat(level[0]);
          count = parseFloat(level[1]);
        } else {
          price = level.price / 100;
          count = level.quantity;
        }
        const notional = count * price;
        cumNotional += notional;
        console.log(`  ${String(i).padStart(5)} | $${price.toFixed(4).padStart(7)} | ${count.toFixed(0).padStart(8)} | $${cumNotional.toFixed(0).padStart(9)} |`);
      }

      const bestYesPrice = Array.isArray(yesSide[0]) ? parseFloat(yesSide[0][0]) : yesSide[0].price / 100;
      console.log(`\n  Best YES level: $${bestYesPrice.toFixed(4)} → P(YES) = ${(bestYesPrice * 100).toFixed(2)}%`);
    }

    // Summary: what our bot would compute
    console.log('\n--- BOT CALCULATION ---');
    if (noSide && noSide.length > 0) {
      let cumNotional = 0;
      for (const level of noSide) {
        const price = Array.isArray(level) ? parseFloat(level[0]) : level.price / 100;
        const count = Array.isArray(level) ? parseFloat(level[1]) : level.quantity;
        cumNotional += count * price;
        if (cumNotional >= LIQUIDITY_THRESHOLD) {
          console.log(`  Bot returns: P(YES) = ${((1 - price) * 100).toFixed(2)}% (thick, marginal NO at $100K)`);
          break;
        }
      }
      if (cumNotional < LIQUIDITY_THRESHOLD) {
        const bestPrice = Array.isArray(noSide[0]) ? parseFloat(noSide[0][0]) : noSide[0].price / 100;
        console.log(`  Bot returns: P(YES) = ${((1 - bestPrice) * 100).toFixed(2)}% (THIN, best NO level, only $${cumNotional.toFixed(0)} depth)`);
      }
    }

  } catch (err) {
    console.log(`  Error: ${err}`);
  }
}

async function main() {
  const ticker = process.argv[2];

  if (!ticker) {
    // Find an active MLB market to test with
    console.log('No ticker provided. Finding active MLB markets...');
    try {
      const resp = await apiRequest('GET', '/markets?status=open&series_ticker=MLBGAME&limit=5') as { markets: Array<Record<string, unknown>> };
      if (resp.markets && resp.markets.length > 0) {
        console.log(`Found ${resp.markets.length} markets:`);
        for (const m of resp.markets) {
          console.log(`  ${m.ticker} - ${m.title} (${m.status})`);
        }
        // Debug first market
        await debugOrderbook(resp.markets[0].ticker as string);
      } else {
        console.log('No active MLB markets found. Try providing a ticker manually.');
      }
    } catch (err) {
      console.log(`Error finding markets: ${err}`);
      console.log('\nUsage: npx tsx scripts/debug-orderbook.ts KXMLBGAME-26MAR282110AZLAD-LAD');
    }
  } else {
    await debugOrderbook(ticker);
  }
}

main().catch(console.error);
