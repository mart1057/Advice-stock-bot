/**
 * Sends one test alert to every configured channel and prints what happened.
 *
 *   npm run notify:test
 *
 * Use it after adding a Discord webhook or a Telegram token to confirm the
 * wiring without waiting for stock to actually appear.
 *
 *   npm run notify:live
 *
 * Fetches Advice for real, and pushes an alert for whatever is in stock RIGHT
 * NOW in ANY capacity (ignores ADVICE_STORAGES) - an end-to-end check of
 * fetch -> parse -> alert. Touches no database.
 */
import { channelDispatcher } from '../notification/channels.js';
import { ONLINE_CHANNEL } from '../advice/advice.channel.js';
import { adviceClient } from '../advice/advice.client.js';
import { parseProductPage } from '../advice/advice.parser.js';
import { env } from '../config/env.js';
import {
  buildPlainText,
  buildStockAlertMessage,
  buildSystemMessage,
  buildSystemPlainText,
} from '../notification/line.flex.js';
import { buildStatusMessage, readStatus } from '../notification/status.report.js';
import { disconnectPrisma } from '../database/prisma.js';
import type { StockTransition } from '../stock/stock.types.js';
import { logger } from '../utils/logger.js';

/// Appended to every sample so a test can never be mistaken for real stock.
const SAMPLE_FOOTER = '\n\n— ตัวอย่างสำหรับทดสอบ ไม่ใช่การแจ้งเตือนจริง —';

const sampleTransition = (
  colorTh: string,
  storage: string,
  quantity: number | null,
): StockTransition => ({
  stockId: `sample-${colorTh}-${storage}`,
  previousStatus: 'UNAVAILABLE',
  currentStatus: 'AVAILABLE',
  stock: {
    model: 'iPhone 18 Pro Max',
    color: 'Burgundy',
    colorTh,
    storage,
    sku: 'A0186086',
    priceTHB: 52900,
    url: 'https://www.advice.co.th/product/iphone/iphone-18-pro/apple-iphone-18-pro-max-256gb-burgundy-mjxq4zp-a-',
    storeName: ONLINE_CHANNEL.name,
    storeCode: ONLINE_CHANNEL.code,
    status: 'AVAILABLE',
    available: true,
    quantity,
    quote:
      quantity !== null && quantity > 0
        ? `พร้อมจำหน่าย (เหลือ ${quantity} เครื่อง)`
        : 'พร้อมจำหน่าย',
    checkedAt: new Date(),
  },
});

/**
 * Sends one of each alert the bot can produce, so the formatting can be
 * reviewed without waiting for Advice to actually restock or block us.
 */
const sendSamples = async (): Promise<boolean> => {
  const single = [sampleTransition('เบอร์กันดี', '256GB', null)];
  const multi = [
    ...single,
    sampleTransition('ธารน้ำแข็ง', '512GB', null),
    sampleTransition('ดำ', '512GB', null),
  ];

  const until = new Date(Date.now() + 30 * 60_000);
  const rateLimitRows: Array<[string, string]> = [
    ['พักนาน', '30 นาที'],
    ['กลับมาตรวจ', until.toTimeString().slice(0, 5)],
    ['ล้มเหลวติดกัน', '4 ครั้ง'],
    ['หมายเหตุ', 'ระหว่างนี้ยังไม่ทราบสถานะสต็อก ไม่ใช่ว่าไม่มีของ'],
  ];

  const samples = [
    {
      label: 'มีของ 1 รายการ',
      flex: buildStockAlertMessage(single),
      text: buildPlainText(single) + SAMPLE_FOOTER,
    },
    {
      label: 'มีของ 3 รายการ',
      flex: buildStockAlertMessage(multi),
      text: buildPlainText(multi) + SAMPLE_FOOTER,
    },
    {
      label: 'Advice บล็อก (429)',
      flex: buildSystemMessage('⚠️ ระบบหยุดตรวจชั่วคราว', 'Advice ปฏิเสธคำขอ (rate limit) - พักการตรวจอัตโนมัติ', rateLimitRows, 'warn'),
      text:
        buildSystemPlainText(
          '⚠️ ระบบหยุดตรวจชั่วคราว',
          'Advice ปฏิเสธคำขอ (rate limit) - พักการตรวจอัตโนมัติ',
          rateLimitRows,
        ) + SAMPLE_FOOTER,
    },
  ];

  let allOk = true;
  logger.raw('Samples:');

  for (const sample of samples) {
    const result = await channelDispatcher.push({ flex: sample.flex, text: sample.text });
    const discord = result.results.find((entry) => entry.channel === 'discord');
    const status = discord?.success
      ? `✅ sent (id=${discord.messageId})`
      : `❌ ${discord?.error ?? 'discord not configured'}`;
    logger.raw(`  ${sample.label.padEnd(22)} ${status}`);
    if (!discord?.success) allOk = false;
    // Stay well clear of Discord's per-webhook rate limit.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  logger.raw('');
  return allOk;
};

/// Real fetch + parse, then alert on every variant that is AVAILABLE now.
const sendLive = async (): Promise<boolean> => {
  logger.raw(`Fetching ${env.ADVICE_PRODUCT_URL} ...`);
  const started = Date.now();
  const html = await adviceClient.getProductPageHtml();
  logger.raw(`  ✓ ${Math.round(html.length / 1024)}KB in ${Date.now() - started}ms`);

  const page = parseProductPage(
    html,
    { ...env.variantFilter, storages: [], colors: [] },
    env.ADVICE_PRODUCT_URL,
    ONLINE_CHANNEL,
    env.ADVICE_REQUIRE_CART,
  );
  if (page === null) {
    logger.error('Page fetched but no product group found - payload shape changed?');
    return false;
  }

  logger.raw('');
  logger.raw(`Live stock (${page.stocks.length} variants):`);
  for (const stock of page.stocks) {
    const icon = stock.status === 'AVAILABLE' ? '🟢' : stock.status === 'UNKNOWN' ? '⚪' : '🔴';
    logger.raw(`  ${icon} ${stock.storage.padEnd(6)} ${stock.color.padEnd(9)} ${stock.sku}  ${stock.status}`);
  }
  logger.raw('');

  const transitions: StockTransition[] = page.stocks
    .filter((stock) => stock.status === 'AVAILABLE')
    .map((stock) => ({
      stockId: `live-${stock.sku}`,
      previousStatus: 'UNAVAILABLE',
      currentStatus: 'AVAILABLE',
      stock,
    }));

  if (transitions.length === 0) {
    logger.raw('Nothing in stock right now in any capacity - no alert sent.');
    return true;
  }

  const footer = '\n\n— ทดสอบด้วยสต๊อคจริงตอนนี้ (ไม่ใช่การแจ้งเตือนจากรอบตรวจ) —';
  const result = await channelDispatcher.push({
    flex: buildStockAlertMessage(transitions),
    text: buildPlainText(transitions) + footer,
  });

  for (const channelResult of result.results) {
    if (channelResult.skipped) continue;
    logger.raw(
      channelResult.success
        ? `  ✅ ${channelResult.channel} - sent ${transitions.length} item(s)`
        : `  ❌ ${channelResult.channel} - ${channelResult.error ?? 'failed'}`,
    );
  }
  logger.raw('');
  return result.success;
};

const main = async (): Promise<void> => {
  const configured = channelDispatcher.configured();

  if (configured.length === 0) {
    logger.error(
      'No notification channel configured',
      'set LINE_*, TELEGRAM_* or DISCORD_WEBHOOK_URL in .env',
    );
    process.exit(1);
  }

  logger.raw('');
  logger.raw('Channels:');
  for (const channel of configured) {
    const available = channel.isAvailable?.() ?? true;
    logger.raw(`  ${available ? '✓' : '⏸'} ${channel.name}${available ? '' : ' (paused)'}`);
  }
  logger.raw('');

  if (process.argv.includes('--status')) {
    const snapshot = await readStatus();
    const result = await channelDispatcher.push(buildStatusMessage(snapshot));
    const discord = result.results.find((entry) => entry.channel === 'discord');
    logger.raw(
      `Status report: ${discord?.success ? `✅ sent (id=${discord.messageId})` : `❌ ${discord?.error ?? 'discord not configured'}`}`,
    );
    logger.raw('');
    await disconnectPrisma();
    process.exit(result.success ? 0 : 1);
  }

  if (process.argv.includes('--live')) {
    const ok = await sendLive();
    process.exit(ok ? 0 : 1);
  }

  if (process.argv.includes('--samples')) {
    const ok = await sendSamples();
    process.exit(ok ? 0 : 1);
  }

  const title = '🧪 ทดสอบการแจ้งเตือน';
  const headline = 'ถ้าเห็นข้อความนี้ แปลว่าช่องทางนี้พร้อมใช้งานแล้ว';
  const rows: Array<[string, string]> = [
    ['สถานะ', 'ทดสอบระบบ ไม่ใช่การแจ้งเตือนสต็อกจริง'],
    ['รอบตรวจ', `ทุก ${process.env.STOCK_CHECK_INTERVAL_SECONDS ?? '30'} วินาที`],
  ];

  const result = await channelDispatcher.push({
    flex: buildSystemMessage(title, headline, rows, 'ok'),
    text: buildSystemPlainText(title, headline, rows),
  });

  logger.raw('');
  logger.raw('Result:');
  for (const channelResult of result.results) {
    if (channelResult.skipped) {
      logger.raw(`  ⏭  ${channelResult.channel} - skipped (not configured)`);
    } else if (channelResult.success) {
      logger.raw(`  ✅ ${channelResult.channel} - sent (id=${channelResult.messageId ?? 'n/a'})`);
    } else {
      logger.raw(`  ❌ ${channelResult.channel} - ${channelResult.error ?? 'failed'}`);
    }
  }
  logger.raw('');

  // Non-zero exit when nothing got through, so this is usable in a health check.
  process.exit(result.success ? 0 : 1);
};

main().catch((error: unknown) => {
  logger.error('Test notification failed', error);
  process.exit(1);
});
