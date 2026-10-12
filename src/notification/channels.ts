import { isLineConfigured } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { ChannelResult, NotificationChannel, OutboundMessage } from './channel.types.js';
import { discordNotificationService } from './discord.service.js';
import { lineNotificationService, type LineNotificationService } from './line.service.js';
import { telegramNotificationService } from './telegram.service.js';

export interface DispatchResult {
  success: boolean;
  messageId: string | null;
  error?: string;
  results: ChannelResult[];
}

/// Adapts the existing Flex-only LINE client to the channel interface.
class LineChannel implements NotificationChannel {
  readonly name = 'line';

  constructor(private readonly line: LineNotificationService = lineNotificationService) {}

  isConfigured(): boolean {
    return isLineConfigured();
  }

  isAvailable(): boolean {
    return this.line.isAvailable();
  }

  async send(message: OutboundMessage, retryKey?: string): Promise<ChannelResult> {
    const result = await this.line.push(message.flex, retryKey);
    return {
      channel: this.name,
      success: result.success,
      messageId: result.messageId,
      skipped: false,
      error: result.error,
    };
  }
}

/**
 * Fans one notification out to every configured channel.
 *
 * A notification counts as delivered when AT LEAST ONE channel accepted it.
 * That is deliberate: when LINE's monthly quota runs out mid-month, Telegram
 * or Discord keeps the alerts flowing instead of the whole bot going silent.
 */
export class ChannelDispatcher {
  constructor(
    private readonly channels: readonly NotificationChannel[] = [
      new LineChannel(),
      telegramNotificationService,
      discordNotificationService,
    ],
  ) {}

  configured(): readonly NotificationChannel[] {
    return this.channels.filter((channel) => channel.isConfigured());
  }

  /// Configured AND currently usable - a quota-exhausted channel is excluded
  /// so we stop making calls that can only fail.
  private usable(): readonly NotificationChannel[] {
    return this.configured().filter((channel) => channel.isAvailable?.() ?? true);
  }

  async push(message: OutboundMessage, retryKey?: string): Promise<DispatchResult> {
    const active = this.usable();

    if (active.length === 0) {
      // Say which of the two it is - "not configured" and "all channels are
      // temporarily down" need very different fixes from the user.
      const error =
        this.configured().length === 0
          ? 'No notification channel configured (LINE / Telegram / Discord)'
          : `Every configured channel is unavailable (${this.configured()
              .map((channel) => channel.name)
              .join(', ')}) - configure Telegram or Discord as a backup`;
      logger.error('Notification skipped', error);
      return { success: false, messageId: null, error, results: [] };
    }

    const recipients = active.filter(
      (channel) => message.kind !== 'system' || channel.name !== 'telegram',
    );
    // An intentional Telegram-only skip is not a delivery failure.
    if (recipients.length === 0) {
      return { success: true, messageId: null, results: [] };
    }

    const results = await Promise.all(
      recipients.map((channel) =>
        channel.send(message, retryKey).catch(
          (error: unknown): ChannelResult => ({
            channel: channel.name,
            success: false,
            messageId: null,
            skipped: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    );

    const delivered = results.filter((result) => result.success);
    const failed = results.filter((result) => !result.success && !result.skipped);

    for (const failure of failed) {
      logger.error(`Channel "${failure.channel}" failed`, failure.error);
    }

    return {
      success: delivered.length > 0,
      messageId: delivered.find((result) => result.messageId)?.messageId ?? null,
      error:
        failed.length > 0
          ? failed.map((result) => `${result.channel}: ${result.error}`).join('; ')
          : undefined,
      results,
    };
  }
}

export const channelDispatcher = new ChannelDispatcher();
