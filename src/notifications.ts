import { config } from './config';
import { logger } from './logger';

/**
 * Send a Telegram notification.
 * Silently fails if credentials are not configured.
 */
export async function sendTelegramMessage(message: string): Promise<void> {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    logger.error('Failed to send Telegram message', { error: String(err) });
  }
}

export async function notifyFill(data: {
  quoteId: string;
  rfqId: string;
  yesBid: number;
  contracts: number;
}): Promise<void> {
  const msg = [
    `<b>FILL</b>`,
    `Quote: ${data.quoteId}`,
    `RFQ: ${data.rfqId}`,
    `Price: $${data.yesBid.toFixed(4)}`,
    `Contracts: ${data.contracts}`,
  ].join('\n');
  await sendTelegramMessage(msg);
}

export async function notifyRiskWarning(warnings: string[]): Promise<void> {
  const msg = `<b>RISK WARNING</b>\n${warnings.join('\n')}`;
  await sendTelegramMessage(msg);
}

export async function notifyKillSwitch(reason: string): Promise<void> {
  const msg = `<b>KILL SWITCH ACTIVATED</b>\n${reason}`;
  await sendTelegramMessage(msg);
}

export async function notifyDailySummary(summary: {
  rfqs_seen: number;
  quotes_submitted: number;
  quotes_filled: number;
  pnl: number;
}): Promise<void> {
  const msg = [
    `<b>Daily Summary</b>`,
    `RFQs Seen: ${summary.rfqs_seen}`,
    `Quotes Submitted: ${summary.quotes_submitted}`,
    `Quotes Filled: ${summary.quotes_filled}`,
    `Fill Rate: ${summary.quotes_submitted > 0 ? ((summary.quotes_filled / summary.quotes_submitted) * 100).toFixed(1) : 0}%`,
    `P&L: $${summary.pnl.toFixed(2)}`,
  ].join('\n');
  await sendTelegramMessage(msg);
}

export async function notifyError(error: string): Promise<void> {
  const msg = `<b>ERROR</b>\n${error}`;
  await sendTelegramMessage(msg);
}
