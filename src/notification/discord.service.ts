import { env, isDiscordConfigured } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { ChannelResult, NotificationChannel, OutboundMessage } from './channel.types.js';
import { withDivider } from './text.decorate.js';

/// Discord rejects anything longer than this.
const MAX_CONTENT_LENGTH = 2000;
const STOCK_REPEAT_DELAY_MS = 3000;

class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

/**
 * Discord webhook sender - free, unmetered, and needs no bot registration:
 * the user pastes one webhook URL and it works.
 * Docs: https://discord.com/developers/docs/resources/webhook#execute-webhook
 */
export class DiscordNotificationService implements NotificationChannel {
  readonly name = 'discord';

  isConfigured(): boolean {
    return isDiscordConfigured();
  }

  async send(message: OutboundMessage, retryKey?: string): Promise<ChannelResult> {
    if (!this.isConfigured()) {
      return { channel: this.name, success: false, messageId: null, skipped: true };
    }

    if (env.DISCORD_DRY_RUN) {
      logger.warn('DISCORD_DRY_RUN=true - message not sent', message.flex.altText);
      return { channel: this.name, success: true, messageId: 'dry-run', skipped: false };
    }

    const results = await Promise.all(
      env.discordWebhookUrls.map((url) => this.sendTo(url, withDivider(message.text), retryKey)),
    );

    if (message.repeatDiscord && results.some((result) => result.success)) {
      await new Promise((resolve) => setTimeout(resolve, STOCK_REPEAT_DELAY_MS));
      await Promise.all(
        env.discordWebhookUrls.map(async (url, index) => {
          if (!results[index]?.success) return;
          const repeat = await this.sendTo(
            url,
            `🔔 แจ้งเตือนซ้ำ: มีสต๊อกแล้ว\n${withDivider(message.text)}`,
            retryKey,
          );
          if (!repeat.success) logger.warn('Discord stock reminder failed', repeat.error);
        }),
      );
    }

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
    webhookUrl: string,
    text: string,
    retryKey?: string,
  ): Promise<{ success: boolean; messageId: string | null; error?: string }> {
    try {
      return await withRetry(
        async () => {
          // `wait=true` makes Discord return the created message instead of 204,
          // so we can record a real message id.
          const url = `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`;

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
            body: JSON.stringify({
              content: text.slice(0, MAX_CONTENT_LENGTH),
              // Never let a product name turn into an @everyone ping.
              allowed_mentions: { parse: [] },
            }),
          });

          if (!response.ok) {
            const body = await response.text();
            throw new DiscordApiError(
              `Discord webhook failed status=${response.status} body=${body.slice(0, 300)}`,
              response.status,
            );
          }

          const payload = (await response.json().catch(() => ({}))) as { id?: string };
          const messageId = payload.id ?? null;
          logger.info(
            'Discord notification sent',
            `messageId=${messageId}${retryKey ? ` key=${retryKey.slice(0, 8)}` : ''}`,
          );
          return { success: true, messageId };
        },
        {
          retries: env.MAX_RETRIES,
          baseDelayMs: env.RETRY_BASE_DELAY_MS,
          label: 'Discord webhook',
          // A dead or malformed webhook URL will not start working on retry.
          isRetryable: (error) =>
            !(error instanceof DiscordApiError) ||
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

export const discordNotificationService = new DiscordNotificationService();
