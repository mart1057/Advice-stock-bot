import { env } from '../config/env.js';
import { stockRepository, type StockRepository } from '../stock/stock.repository.js';
import type { StockCheckResult, StockTransition } from '../stock/stock.types.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { channelDispatcher, type ChannelDispatcher } from './channels.js';
import {
  buildPlainText,
  buildStockAlertMessage,
  buildSystemMessage,
  buildSystemPlainText,
} from './line.flex.js';
import { buildStockAlertText } from './stock.text.js';
import { readStatus, type StatusSnapshot } from './status.report.js';

export class NotificationService {
  /// Timestamp of the last system notice actually sent, for throttling.
  private lastSystemAlertAt: number | null = null;
  /// How many system notices the throttle has swallowed since the last send.
  private suppressedSystemAlerts = 0;

  constructor(
    private readonly channels: ChannelDispatcher = channelDispatcher,
    private readonly repository: StockRepository = stockRepository,
    /// Injected so the alert can show the full picture, not just what changed.
    private readonly snapshot: () => Promise<StatusSnapshot> = readStatus,
    private readonly pause: (ms: number) => Promise<void> = sleep,
  ) {}

  /**
   * Sends each restock alert twice, three seconds apart. Each copy contains
   * every new-in-stock item and gets its own delivery log and retry key.
   */
  async notify(result: StockCheckResult): Promise<void> {
    const transitions = result.transitions;
    if (transitions.length === 0) return;

    if (result.firstRun) {
      // Belt and braces: the detector already suppresses these.
      logger.warn(`First run - suppressing ${transitions.length} notification(s)`);
      return;
    }

    logger.info(`Sending stock alert for ${transitions.length} item(s)`);

    // Reading the snapshot is a nicety, not a requirement: if it fails, still
    // send the alert with the short form rather than dropping it.
    let text: string;
    try {
      text = buildStockAlertText(transitions, await this.snapshot());
    } catch (error) {
      logger.warn('Could not read stock snapshot - falling back to short alert', error);
      text = buildPlainText(transitions);
    }
    logger.debug('Alert text', `\n${text}`);

    const message = { flex: buildStockAlertMessage(transitions), text };
    for (let copy = 1; copy <= 2; copy += 1) {
      if (copy === 2) await this.pause(3000);
      logger.info(`Sending stock alert copy ${copy}/2`);
      // Each intentional copy needs a new key; transport retries reuse it.
      // Reusing the first key here would make LINE deduplicate the reminder.
      try {
        const pushResult = await this.channels.push(message, crypto.randomUUID());
        if (!pushResult.success) {
          logger.error('Stock alert delivered to no channel', pushResult.error);
        }
        await this.logAll(transitions, pushResult.messageId, pushResult.success, pushResult.error);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Stock alert copy ${copy}/2 failed`, detail);
        await this.logAll(transitions, null, false, detail);
      }
    }
  }

  /// Tells the user the bot is throttling itself, so silence is not mistaken
  /// for "no stock". Sent once per cooldown episode, not once per tick.
  async notifyRateLimited(info: {
    cooldownMs: number;
    until: Date;
    consecutiveFailures: number;
    escalated: boolean;
  }): Promise<void> {
    if (!env.RATE_LIMIT_ALERT_ENABLED) return;

    const minutes = Math.max(1, Math.round(info.cooldownMs / 60_000));
    const title = '⚠️ ระบบหยุดตรวจชั่วคราว';
    const headline = info.escalated
      ? 'Advice ยังปฏิเสธคำขอ - ขยายเวลาพักอัตโนมัติ'
      : 'Advice ปฏิเสธคำขอ (rate limit) - พักการตรวจอัตโนมัติ';
    const rows: Array<[string, string]> = [
      ['พักนาน', `${minutes} นาที`],
      ['กลับมาตรวจ', formatTime(info.until)],
      ['ล้มเหลวติดกัน', `${info.consecutiveFailures} ครั้ง`],
      ['หมายเหตุ', 'ระหว่างนี้ยังไม่ทราบสถานะสต็อก ไม่ใช่ว่าไม่มีของ'],
    ];

    await this.sendSystemAlert(title, headline, rows, 'warn');
  }

  async notifyRecovered(): Promise<void> {
    if (!env.RATE_LIMIT_ALERT_ENABLED) return;

    await this.sendSystemAlert(
      '✅ ระบบกลับมาตรวจแล้ว',
      'Advice ตอบกลับปกติ - กลับสู่รอบตรวจตามปกติ',
      [['รอบตรวจ', `ทุก ${env.STOCK_CHECK_INTERVAL_SECONDS} วินาที`]],
      'ok',
    );
  }

  /**
   * System notices share one throttle window.
   *
   * When Advice flaps, the guard ping-pongs cooldown -> recover -> cooldown and
   * each swing wants to send a message. Left unchecked that drains the whole
   * monthly quota on status chatter and leaves nothing for actual stock
   * alerts - which is exactly what happened in production. Stock alerts never
   * pass through here and are never throttled.
   */
  private async sendSystemAlert(
    title: string,
    headline: string,
    rows: Array<[string, string]>,
    tone: 'warn' | 'ok',
  ): Promise<void> {
    const windowMs = env.SYSTEM_ALERT_MIN_INTERVAL_MINUTES * 60_000;
    const now = Date.now();

    if (windowMs > 0 && this.lastSystemAlertAt !== null && now - this.lastSystemAlertAt < windowMs) {
      this.suppressedSystemAlerts += 1;
      const waitMinutes = Math.ceil((windowMs - (now - this.lastSystemAlertAt)) / 60_000);
      logger.info(
        `System alert suppressed - "${title}"`,
        `suppressed=${this.suppressedSystemAlerts} next in ~${waitMinutes} min`,
      );
      return;
    }

    // Tell the user what they did not see, so the throttle is never silent.
    const finalRows: Array<[string, string]> =
      this.suppressedSystemAlerts > 0
        ? [...rows, ['แจ้งเตือนที่ข้ามไป', `${this.suppressedSystemAlerts} ครั้ง`]]
        : rows;

    // The window opens on the ATTEMPT, not on success. Keying it to success
    // means a permanently dead channel (LINE out of quota) is retried on every
    // single guard swing forever, which is pure log noise and wasted calls.
    this.lastSystemAlertAt = now;

    const result = await this.channels.push({
      kind: 'system',
      flex: buildSystemMessage(title, headline, finalRows, tone),
      text: buildSystemPlainText(title, headline, finalRows),
    });

    if (!result.success) {
      logger.error('System alert delivered to no channel', result.error);
      // Keep the suppressed count so the next successful notice can report it.
      return;
    }

    this.suppressedSystemAlerts = 0;
  }

  private async logAll(
    transitions: readonly StockTransition[],
    messageId: string | null,
    success: boolean,
    error?: string,
  ): Promise<void> {
    for (const transition of transitions) {
      try {
        await this.repository.logNotification({
          stockId: transition.stockId,
          previousStatus: transition.previousStatus,
          currentStatus: transition.currentStatus,
          messageId,
          success,
          error,
        });
      } catch (logError) {
        logger.error('Failed to write NotificationLog', logError);
      }
    }
  }
}

const formatTime = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ ?? 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

export const notificationService = new NotificationService();
