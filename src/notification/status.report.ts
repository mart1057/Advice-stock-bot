import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { formatThaiDateTime } from '../utils/datetime.js';
import type { OutboundMessage } from './channel.types.js';
import { buildSystemMessage } from './line.flex.js';
import { ONLINE_CHANNEL } from '../advice/advice.channel.js';
import { buildAvailabilityBody, type AvailableItem } from './stock.text.js';

export interface StatusSnapshot {
  total: number;
  available: number;
  unavailable: number;
  unknown: number;
  lastCheckedAt: Date | null;
  /// Display name of the channel the counts describe.
  channelName: string;
  inStock: AvailableItem[];
}

/**
 * Reads what the bot currently believes about every variant/channel pair.
 *
 * The bot itself only ever pushes on a CHANGE, which is what keeps it quiet.
 * This is the on-demand counterpart: "what does it look like right now?".
 */
export const readStatus = async (): Promise<StatusSnapshot> => {
  const stocks = await prisma.stock.findMany({
    include: { variant: true, store: true },
  });

  const inStock: AvailableItem[] = stocks
    .filter((stock) => stock.available)
    .map((stock) => ({
      colorTh: stock.variant.colorTh ?? stock.variant.color,
      storage: stock.variant.storage,
      quantity: stock.quantity,
      url: stock.variant.url,
      priceTHB: stock.variant.priceTHB === null ? null : Number(stock.variant.priceTHB),
    }))
    .sort(
      (a, b) => a.storage.localeCompare(b.storage) || a.colorTh.localeCompare(b.colorTh),
    );

  const lastChecked = stocks
    .map((stock) => stock.lastCheckedAt)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    total: stocks.length,
    available: stocks.filter((stock) => stock.available).length,
    unavailable: stocks.filter((stock) => !stock.available && stock.status === 'UNAVAILABLE').length,
    unknown: stocks.filter((stock) => stock.status === 'UNKNOWN').length,
    lastCheckedAt: lastChecked ?? null,
    channelName: stocks[0]?.store.name ?? ONLINE_CHANNEL.name,
    inStock,
  };
};

export const buildStatusMessage = (snapshot: StatusSnapshot): OutboundMessage => {
  const title = '📊 สถานะสต็อกตอนนี้';
  const headline =
    snapshot.available > 0
      ? `พบสินค้าพร้อมจำหน่าย ${snapshot.available} รายการ`
      : 'ยังไม่มีสินค้าพร้อมจำหน่าย';

  const rows: Array<[string, string]> = [
    ['รุ่น', env.ADVICE_MODEL_FILTER],
    ['ร้าน', snapshot.channelName],
    ['มีของ', `${snapshot.available} / ${snapshot.total}`],
    ['ไม่มีของ', `${snapshot.unavailable}`],
  ];
  if (snapshot.unknown > 0) rows.push(['ไม่ทราบสถานะ', `${snapshot.unknown}`]);
  rows.push([
    'ตรวจล่าสุด',
    snapshot.lastCheckedAt ? formatThaiDateTime(snapshot.lastCheckedAt) : 'ยังไม่เคยตรวจ',
  ]);

  return {
    flex: buildSystemMessage(
      title,
      headline,
      [
        ...rows,
        ...snapshot.inStock.map((item): [string, string] => [
          `${item.colorTh} ${item.storage}`,
          item.quantity !== null && item.quantity > 0 ? `เหลือ ${item.quantity}` : 'พร้อมจำหน่าย',
        ]),
      ],
      snapshot.available > 0 ? 'ok' : 'warn',
    ),
    text: [title, '', headline, '', buildAvailabilityBody(snapshot)].join('\n'),
  };
};
