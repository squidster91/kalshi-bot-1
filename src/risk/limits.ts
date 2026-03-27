import { config } from '../config';
import { getPositionSummary, getEventExposure } from './positions';
import { getTodayPnL } from '../db/queries';
import { logger } from '../logger';

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
  details: {
    dailyPnL: number;
    totalExposure: number;
    eventExposure: number;
    comboExposure: number;
    contractsRequested: number;
  };
}

// Global kill switch
let killSwitchActive = false;

export function activateKillSwitch(reason: string): void {
  killSwitchActive = true;
  logger.error(`KILL SWITCH ACTIVATED: ${reason}`);
}

export function deactivateKillSwitch(): void {
  killSwitchActive = false;
  logger.info('Kill switch deactivated');
}

export function isKillSwitchActive(): boolean {
  return killSwitchActive;
}

/**
 * Run all risk checks before submitting a quote.
 * Returns whether the quote is allowed and the reason if not.
 */
export function checkRiskLimits(params: {
  eventTicker: string;
  comboPrice: number;
  contractsRequested: number;
}): RiskCheck {
  const { eventTicker, comboPrice, contractsRequested } = params;

  // 1. Kill switch
  if (killSwitchActive) {
    return reject('Kill switch is active', params);
  }

  // 2. Max contracts per quote
  if (contractsRequested > config.risk.maxContractsPerQuote) {
    return reject(
      `Contracts ${contractsRequested} exceeds max ${config.risk.maxContractsPerQuote}`,
      params
    );
  }

  // 3. Daily loss limit
  const dailyPnL = getTodayPnL();
  if (dailyPnL <= -config.risk.maxDailyLoss) {
    activateKillSwitch(`Daily loss limit reached: $${dailyPnL.toFixed(2)}`);
    return reject(`Daily loss limit reached: $${dailyPnL.toFixed(2)}`, params);
  }

  // 4. Per-combo exposure (max risk on a single combo)
  const comboExposure = (1 - comboPrice) * contractsRequested;
  const maxComboExposure = config.risk.startingBankroll * config.risk.maxCapitalPerCombo;
  if (comboExposure > maxComboExposure) {
    return reject(
      `Combo exposure $${comboExposure.toFixed(2)} exceeds max $${maxComboExposure.toFixed(2)}`,
      params
    );
  }

  // 5. Per-event exposure
  const currentEventExposure = getEventExposure(eventTicker);
  if (currentEventExposure + comboExposure > config.risk.maxExposurePerEvent) {
    return reject(
      `Event exposure would be $${(currentEventExposure + comboExposure).toFixed(2)}, max is $${config.risk.maxExposurePerEvent}`,
      params
    );
  }

  // 6. Total exposure
  const summary = getPositionSummary();
  if (summary.totalExposure + comboExposure > config.risk.maxTotalExposure) {
    return reject(
      `Total exposure would be $${(summary.totalExposure + comboExposure).toFixed(2)}, max is $${config.risk.maxTotalExposure}`,
      params
    );
  }

  return {
    allowed: true,
    details: {
      dailyPnL,
      totalExposure: summary.totalExposure,
      eventExposure: currentEventExposure,
      comboExposure,
      contractsRequested,
    },
  };
}

function reject(
  reason: string,
  params: { comboPrice: number; contractsRequested: number; eventTicker: string }
): RiskCheck {
  logger.warn(`Risk check REJECTED: ${reason}`);
  return {
    allowed: false,
    reason,
    details: {
      dailyPnL: getTodayPnL(),
      totalExposure: getPositionSummary().totalExposure,
      eventExposure: getEventExposure(params.eventTicker),
      comboExposure: (1 - params.comboPrice) * params.contractsRequested,
      contractsRequested: params.contractsRequested,
    },
  };
}

/**
 * Check if we're approaching risk limits (for alerting).
 */
export function getRiskUtilization(): {
  dailyLossUtilization: number;
  totalExposureUtilization: number;
  warnings: string[];
} {
  const dailyPnL = getTodayPnL();
  const summary = getPositionSummary();
  const warnings: string[] = [];

  const dailyLossUtil = Math.abs(Math.min(0, dailyPnL)) / config.risk.maxDailyLoss;
  const totalExposureUtil = summary.totalExposure / config.risk.maxTotalExposure;

  if (dailyLossUtil > 0.8) {
    warnings.push(`Daily loss at ${(dailyLossUtil * 100).toFixed(0)}% of limit`);
  }
  if (totalExposureUtil > 0.8) {
    warnings.push(`Total exposure at ${(totalExposureUtil * 100).toFixed(0)}% of limit`);
  }

  // Check per-event limits
  for (const [event, exposure] of summary.exposureByEvent) {
    const util = exposure / config.risk.maxExposurePerEvent;
    if (util > 0.8) {
      warnings.push(`Event ${event} exposure at ${(util * 100).toFixed(0)}% of limit`);
    }
  }

  return {
    dailyLossUtilization: dailyLossUtil,
    totalExposureUtilization: totalExposureUtil,
    warnings,
  };
}
