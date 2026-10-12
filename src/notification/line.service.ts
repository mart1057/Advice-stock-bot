import { env, isLineConfigured } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { FlexMessage } from './line.flex.js';

const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

export interface LinePushResult {
  success: boolean;
  messageId: string | null;
  error?: string;
}

/// How long to stop calling LINE after it reports the monthly quota is gone.
/// Re-probing (rather than waiting for the 1st of the month) means an upgraded
/// plan or a reset is picked up on its own, without a restart.
const QUOTA_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

class LineApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body = '',
  ) {
    super(message);
    this.name = 'LineApiError';
  }

  /**
   * LINE returns 429 for two very different things: short-term rate limiting
   * (worth retrying in a moment) and the monthly quota being used up (not
   * worth retrying until next month). Only the body tells them apart.
   */
  get isMonthlyQuotaExhausted(): boolean {
    return this.status === 429 && /monthly limit/i.test(this.body);
  }
}

/**
 * LINE Messaging API push client (NOT LINE Notify, which is discontinued).
 * Docs: https://developers.line.biz/en/reference/messaging-api/#send-push-message
 */
export class LineNotificationService {
  /// Set when LINE says the monthly quota is gone; until then, calling LINE
  /// only produces 429s and log noise, so we stop calling it entirely.
  private quotaExhaustedUntil: number | null = null;

  /// False while the monthly quota is known to be used up.
  isAvailable(now: number = Date.now()): boolean {
    if (this.quotaExhaustedUntil === null) return true;
    if (now >= this.quotaExhaustedUntil) {
      this.quotaExhaustedUntil = null;
      logger.info('LINE quota cooldown elapsed - probing again');
      return true;
    }
    return false;
  }

  /// Pushes one message to every configured recipient.
  async push(message: FlexMessage, retryKey?: string): Promise<LinePushResult> {
    if (env.LINE_DRY_RUN) {
      logger.warn('LINE_DRY_RUN=true - message not sent', message.altText);
      logger.debug('LINE payload', message);
      return { success: true, messageId: 'dry-run' };
    }

    if (!isLineConfigured()) {
      const error = 'LINE is not configured (LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID)';
      logger.error('LINE notification skipped', error);
      return { success: false, messageId: null, error };
    }

    const results = await Promise.all(
      env.lineRecipients.map((to) => this.pushTo(to, message, retryKey)),
    );

    const failed = results.filter((result) => !result.success);
    return {
      success: failed.length === 0,
      messageId: results.find((result) => result.messageId)?.messageId ?? null,
      error: failed.length > 0 ? failed.map((result) => result.error).join('; ') : undefined,
    };
  }

  private async pushTo(
    to: string,
    message: FlexMessage,
    retryKey?: string,
  ): Promise<LinePushResult> {
    try {
      return await withRetry(
        async () => {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          };
          // Lets LINE de-duplicate if we retry after an ambiguous failure.
          if (retryKey) headers['X-Line-Retry-Key'] = retryKey;

          const response = await fetch(PUSH_ENDPOINT, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
            body: JSON.stringify({ to, messages: [message] }),
          });

          if (!response.ok) {
            const body = await response.text();
            throw new LineApiError(
              `LINE push failed status=${response.status} body=${body.slice(0, 300)}`,
              response.status,
              body,
            );
          }

          const messageId = response.headers.get('x-line-request-id');
          logger.info('LINE notification sent', `to=${maskRecipient(to)} requestId=${messageId}`);
          return { success: true, messageId };
        },
        {
          retries: env.MAX_RETRIES,
          baseDelayMs: env.RETRY_BASE_DELAY_MS,
          label: `LINE push to ${maskRecipient(to)}`,
          // 4xx other than 429 are config/payload errors - retrying is pointless,
          // and so is retrying a 429 that means "monthly quota used up".
          isRetryable: (error) =>
            !(error instanceof LineApiError) ||
            (!error.isMonthlyQuotaExhausted &&
              (error.status >= 500 || error.status === 429)),
        },
      );
    } catch (error) {
      if (error instanceof LineApiError && error.isMonthlyQuotaExhausted) {
        this.enterQuotaCooldown();
      }
      const message_ = error instanceof Error ? error.message : String(error);
      return { success: false, messageId: null, error: message_ };
    }
  }

  private enterQuotaCooldown(now: number = Date.now()): void {
    if (this.quotaExhaustedUntil !== null) return; // already logged
    this.quotaExhaustedUntil = now + QUOTA_RETRY_AFTER_MS;
    logger.error(
      'LINE monthly quota exhausted - pausing LINE for 6h',
      'alerts will keep going out on any other configured channel (Telegram / Discord)',
    );
  }
}

const maskRecipient = (to: string): string =>
  to.length <= 8 ? to : `${to.slice(0, 5)}...${to.slice(-4)}`;

export const lineNotificationService = new LineNotificationService();
