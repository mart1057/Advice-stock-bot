import 'dotenv/config';
import { z } from 'zod';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const booleanish = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  LINE_CHANNEL_ACCESS_TOKEN: z.string().default(''),
  LINE_USER_ID: z.string().default(''),
  LINE_DRY_RUN: booleanish.default('false'),

  /// Telegram Bot API - free, no monthly message quota.
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_DRY_RUN: booleanish.default('false'),

  /// Discord incoming webhook(s) - free, no bot registration needed.
  DISCORD_WEBHOOK_URL: z.string().default(''),
  DISCORD_DRY_RUN: booleanish.default('false'),

  /// Advice group PDP - carries stock for every colour x capacity.
  ADVICE_PRODUCT_URL: z
    .string()
    .url()
    .default('https://www.advice.co.th/product/iphone/iphone-18-pro/iphone-18-pro-max'),
  ADVICE_MODEL_FILTER: z.string().default('iPhone 18 Pro Max'),
  /// Capacities to watch (comma separated). Empty = every capacity.
  ADVICE_STORAGES: z.string().default(''),
  /// Colours to watch (comma separated, English). Empty = every colour.
  ADVICE_COLORS: z.string().default(''),
  /// Require the add-to-cart flag (cart === "T") before calling it AVAILABLE.
  ADVICE_REQUIRE_CART: booleanish.default('true'),

  STOCK_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(60),
  STOCK_CHECK_CRON: z.string().default(''),
  RUN_ON_STARTUP: booleanish.default('true'),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(50).default(500),
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(20).default(3),

  RATE_LIMIT_TRIGGER_FAILURES: z.coerce.number().int().min(1).max(10).default(2),
  RATE_LIMIT_COOLDOWN_BASE_SECONDS: z.coerce.number().int().min(10).default(120),
  RATE_LIMIT_COOLDOWN_MAX_SECONDS: z.coerce.number().int().min(60).default(1800),
  RATE_LIMIT_ALERT_ENABLED: booleanish.default('true'),
  /// Floor between two system notices (cooldown / recovery). Without this a
  /// flapping upstream ping-pongs cooldown -> recover -> cooldown and burns
  /// the message quota on status chatter instead of stock alerts.
  SYSTEM_ALERT_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(30),

  DISTRIBUTED_LOCK_ENABLED: booleanish.default('false'),
  LOCK_TTL_SECONDS: z.coerce.number().int().min(30).default(300),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  /// Which variants of the group are tracked.
  variantFilter: {
    model: raw.ADVICE_MODEL_FILTER,
    storages: csv(raw.ADVICE_STORAGES).map((value) => value.replace(/\s+/g, '').toUpperCase()),
    colors: csv(raw.ADVICE_COLORS),
  },
  /// LINE push targets (userId / groupId / roomId).
  lineRecipients: csv(raw.LINE_USER_ID),
  /// Telegram chat targets.
  telegramChatIds: csv(raw.TELEGRAM_CHAT_ID),
  /// Discord webhook endpoints.
  discordWebhookUrls: csv(raw.DISCORD_WEBHOOK_URL),
} as const;

export type Env = typeof env;

/// Every channel is optional at boot so the collector can be exercised
/// without any of them configured.
export const isLineConfigured = (): boolean =>
  env.LINE_CHANNEL_ACCESS_TOKEN.length > 0 && env.lineRecipients.length > 0;

export const isTelegramConfigured = (): boolean =>
  env.TELEGRAM_BOT_TOKEN.length > 0 && env.telegramChatIds.length > 0;

export const isDiscordConfigured = (): boolean => env.discordWebhookUrls.length > 0;

/// True when at least one channel can actually deliver an alert.
export const isAnyChannelConfigured = (): boolean =>
  isLineConfigured() || isTelegramConfigured() || isDiscordConfigured();
