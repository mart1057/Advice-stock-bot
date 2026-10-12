import { env, isTelegramConfigured } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { ChannelResult, NotificationChannel, OutboundMessage } from './channel.types.js';

/// Telegram rejects anything longer than this.
const MAX_TEXT_LENGTH = 4096;

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * Telegram Bot API sender - free and without a monthly message quota, which
 * is why it exists alongside LINE rather than replacing it.
 * Docs: https://core.telegram.org/bots/api#sendmessage
 */
export class TelegramNotificationService implements NotificationChannel {
  readonly name = 'telegram';

  isConfigured(): boolean {
    return isTelegramConfigured();
  }

  async send(message: OutboundMessage, retryKey?: string): Promise<ChannelResult> {
    if (!this.isConfigured()) {
      return { channel: this.name, success: false, messageId: null, skipped: true };
    }

    if (env.TELEGRAM_DRY_RUN) {
      logger.warn('TELEGRAM_DRY_RUN=true - message not sent', message.flex.altText);
      return { channel: this.name, success: true, messageId: 'dry-run', skipped: false };
    }

    const results = await Promise.all(
      env.telegramChatIds.map((chatId) => this.sendTo(chatId, message.text, retryKey)),
    );

    const failed = results.filter((result) => !result.success);
    return {
      channel: this.name,
      success: failed.length === 0,
      messageId: results.find((result) => result.messageId)?.messageId ?? null,
      skipped: false,
      error: failed.length > 0 ? failed.map((result) => result.error).join('; ') : undefined,
    };
  }

  private async sendTo(
    chatId: string,
    text: string,
    retryKey?: string,
  ): Promise<{ success: boolean; messageId: string | null; error?: string }> {
    const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    try {
      return await withRetry(
        async () => {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
            body: JSON.stringify({
              chat_id: chatId,
              // Sent as plain text on purpose: the alert contains Thai product
              // names and '/' in part numbers, which Markdown would mangle.
              text: text.slice(0, MAX_TEXT_LENGTH),
              disable_web_page_preview: true,
            }),
          });

          if (!response.ok) {
            const body = await response.text();
            throw new TelegramApiError(
              `Telegram send failed status=${response.status} body=${body.slice(0, 300)}`,
              response.status,
            );
          }

          const payload = (await response.json()) as { result?: { message_id?: number } };
          const messageId = payload.result?.message_id?.toString() ?? null;
          logger.info(
            'Telegram notification sent',
            `chat=${maskChatId(chatId)} messageId=${messageId}${retryKey ? ` key=${retryKey.slice(0, 8)}` : ''}`,
          );
          return { success: true, messageId };
        },
        {
          retries: env.MAX_RETRIES,
          baseDelayMs: env.RETRY_BASE_DELAY_MS,
          label: `Telegram send to ${maskChatId(chatId)}`,
          // 4xx other than 429 means a bad token or chat id - retrying cannot help.
          isRetryable: (error) =>
            !(error instanceof TelegramApiError) ||
            error.status >= 500 ||
            error.status === 429,
        },
      );
    } catch (error) {
      return {
        success: false,
        messageId: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const maskChatId = (chatId: string): string =>
  chatId.length <= 5 ? chatId : `${chatId.slice(0, 3)}...${chatId.slice(-2)}`;

export const telegramNotificationService = new TelegramNotificationService();
