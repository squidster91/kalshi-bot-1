import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

function envStr(key: string, defaultValue?: string): string {
  const val = process.env[key] ?? defaultValue;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function envNum(key: string, defaultValue: number): number {
  const val = process.env[key];
  return val !== undefined ? Number(val) : defaultValue;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val === 'true' || val === '1';
}

export type KalshiEnv = 'demo' | 'production';

const kalshiEnv = envStr('KALSHI_ENV', 'demo') as KalshiEnv;

const BASE_URLS: Record<KalshiEnv, { rest: string; ws: string }> = {
  demo: {
    rest: 'https://demo-api.kalshi.co/trade-api/v2',
    ws: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
  },
  production: {
    rest: 'https://api.elections.kalshi.com/trade-api/v2',
    ws: 'wss://api.elections.kalshi.com/trade-api/ws/v2',
  },
};

export const config = {
  kalshi: {
    env: kalshiEnv,
    apiKeyId: envStr('KALSHI_API_KEY_ID', ''),
    privateKeyPath: envStr('KALSHI_PRIVATE_KEY_PATH', ''),
    baseUrl: BASE_URLS[kalshiEnv].rest,
    wsUrl: BASE_URLS[kalshiEnv].ws,
  },

  risk: {
    maxContractsPerQuote: envNum('MAX_CONTRACTS_PER_QUOTE', 10),
    maxDailyLoss: envNum('MAX_DAILY_LOSS', 250),
    maxExposurePerEvent: envNum('MAX_EXPOSURE_PER_EVENT', 500),
    maxTotalExposure: envNum('MAX_TOTAL_EXPOSURE', 2500),
    minSpread: envNum('MIN_SPREAD', 0.02),
    startingBankroll: envNum('STARTING_BANKROLL', 5000),
    maxCapitalPerCombo: 0.02,
    maxCapitalPerEvent: 0.10,
    maxTotalExposurePct: 0.50,
    confirmationTimeoutMs: 25_000, // 5s buffer on 30s limit
    stalePriceThresholdMs: 60_000, // 60 seconds
  },

  spread: {
    baseSpreads: {
      2: 0.03,
      3: 0.05,
      4: 0.08,
    } as Record<number, number>,
    defaultBaseSpread: 0.10, // for 5+ legs
    sameGameDiscount: 0.7,
    inventoryPenalty: 0.01,
    maxSpread: 0.15,
    minSpread: 0.02,
  },

  telegram: {
    botToken: envStr('TELEGRAM_BOT_TOKEN', ''),
    chatId: envStr('TELEGRAM_CHAT_ID', ''),
  },

  db: {
    path: envStr('DB_PATH', './data/kalshimm.db'),
  },

  bot: {
    paperMode: envBool('PAPER_MODE', true), // Default to paper mode (no real quotes)
    quotingEnabled: envBool('QUOTING_ENABLED', false),
    logLevel: envStr('LOG_LEVEL', 'info'),
  } as { paperMode: boolean; quotingEnabled: boolean; logLevel: string },
} as const;

export function loadPrivateKey(): string {
  const keyPath = path.resolve(config.kalshi.privateKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key file not found: ${keyPath}`);
  }
  return fs.readFileSync(keyPath, 'utf-8');
}
