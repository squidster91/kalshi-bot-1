# KalshiMM — Combo RFQ Market-Making Bot

Automated market maker for Kalshi's combo/parlay RFQ system. Receives multi-leg combo RFQs via WebSocket, prices them using a correlation-aware Gaussian copula model, and submits competitive quotes.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your Kalshi API credentials

# Run in paper mode (observe + log, no real quotes)
npm run dev

# Calibrate correlations from NBA data
npm run calibrate

# View P&L report
npm run pnl
```

## Architecture

- **Pricing Engine**: Gaussian copula with pairwise correlations for NBA market types (moneyline, spread, totals, player props)
- **Risk Management**: Per-combo, per-event, and total exposure limits with daily loss kill switch
- **RFQ Pipeline**: WebSocket listener → pricing → risk check → quote submission → confirmation (30s window)
- **Database**: SQLite for trade logging, P&L tracking, and correlation data

## Configuration

See `.env.example` for all configuration options. Key settings:

- `KALSHI_ENV=demo` — Start with demo environment
- `PAPER_MODE=true` — Log quotes without submitting (default)
- `MAX_CONTRACTS_PER_QUOTE=10` — Start small

## Project Structure

```
src/
├── index.ts              # Entry point, bot orchestration
├── config.ts             # Configuration from env vars
├── auth.ts               # RSA-PSS request signing
├── api/rest.ts           # Kalshi REST client
├── api/websocket.ts      # WebSocket manager (orderbook + communications)
├── pricing/marginals.ts  # Individual market price lookup
├── pricing/correlation.ts # Pairwise correlation matrix
├── pricing/copula.ts     # Gaussian copula joint probability
├── pricing/spreads.ts    # Spread calculation
├── rfq/listener.ts       # RFQ event processing
├── rfq/quoter.ts         # Quote decision engine
├── rfq/confirmer.ts      # Quote confirmation flow
├── risk/positions.ts     # Position tracking
├── risk/limits.ts        # Risk limit enforcement
├── risk/inventory.ts     # Inventory skew
├── data/nba-stats.ts     # NBA API integration
├── data/correlation-builder.ts # Correlation calibration
├── db/schema.ts          # SQLite schema
└── db/queries.ts         # Database operations
```
