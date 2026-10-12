import { adviceCatalog } from './advice/advice.catalog.js';
import { ONLINE_CHANNEL } from './advice/advice.channel.js';
import { storageRank } from './advice/advice.parser.js';
import {
  env,
  isAnyChannelConfigured,
  isDiscordConfigured,
  isLineConfigured,
  isTelegramConfigured,
} from './config/env.js';
import { disconnectPrisma, prisma } from './database/prisma.js';
import { stockScheduler } from './scheduler/stock.scheduler.js';
import { historyScheduler } from './scheduler/history.scheduler.js';
import { logger } from './utils/logger.js';

const banner = async (): Promise<void> => {
  // Advice may be unreachable at boot (Cloudflare, network) - the banner must
  // never stop the bot from starting; the scheduler retries on its own.
  const variants = await adviceCatalog.getVariants().catch((error: unknown) => {
    logger.warn('Could not load the Advice catalogue for the banner', error);
    return [];
  });
  const colors =
    variants.length > 0
      ? [...new Set(variants.map((variant) => variant.color))]
      : env.variantFilter.colors.length > 0
        ? env.variantFilter.colors
        : ['(all colours - loaded on first check)'];
  const storages = [
    ...new Set(
      variants.length > 0 ? variants.map((variant) => variant.storage) : env.variantFilter.storages,
    ),
  ].sort(
    (a, b) => storageRank(a) - storageRank(b),
  );

  const schedule =
    env.STOCK_CHECK_CRON.length > 0
      ? `cron "${env.STOCK_CHECK_CRON}"`
      : `${env.STOCK_CHECK_INTERVAL_SECONDS} seconds`;

  logger.raw('');
  logger.raw(`📱 ${env.ADVICE_MODEL_FILTER} Stock Bot - Advice (advice.co.th)`);
  logger.raw('');
  logger.raw('Monitoring:');
  for (const color of colors) logger.raw(`✓ ${color}`);
  logger.raw('');
  logger.raw('Storage:');
  for (const storage of storages) logger.raw(`✓ ${storage}`);
  logger.raw('');
  logger.raw('Store:');
  logger.raw(`✓ ${ONLINE_CHANNEL.name} (${env.ADVICE_PRODUCT_URL})`);
  logger.raw('');
  logger.raw('Available when:');
  logger.raw(
    env.ADVICE_REQUIRE_CART
      ? '✓ instock AND add-to-cart enabled'
      : '✓ instock (add-to-cart flag ignored)',
  );
  logger.raw('');
  logger.raw('Interval:');
  logger.raw(schedule);
  logger.raw('');
  logger.raw('Channels:');
  const channels = [
    ['LINE', isLineConfigured()],
    ['Telegram', isTelegramConfigured()],
    ['Discord', isDiscordConfigured()],
  ] as const;
  for (const [name, on] of channels) logger.raw(`${on ? '✓' : '✗'} ${name}`);
  logger.raw('');
  logger.raw('Status:');
  logger.raw(
    isAnyChannelConfigured() || env.LINE_DRY_RUN
      ? '🟢 Monitoring'
      : '🟡 Monitoring (no notification channel configured)',
  );
  logger.raw('');
};

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal} - shutting down`);
  await stockScheduler.stop();
  await historyScheduler.stop();
  await disconnectPrisma();
  process.exit(0);
};

const main = async (): Promise<void> => {
  await prisma.$queryRaw`SELECT 1`;
  logger.info('Database connection ok');

  if (!isAnyChannelConfigured() && !env.LINE_DRY_RUN) {
    logger.warn(
      'No notification channel configured - stock will be tracked but no alerts will be sent',
      'set LINE_*, TELEGRAM_* or DISCORD_WEBHOOK_URL',
    );
  }

  await banner();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await stockScheduler.start();
  historyScheduler.start();
};

main().catch(async (error: unknown) => {
  logger.error('Fatal startup error', error);
  await disconnectPrisma().catch(() => undefined);
  process.exit(1);
});
