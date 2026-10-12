import { env } from '../config/env.js';
import { formatThaiDateTime } from '../utils/datetime.js';
import { storageRank } from '../advice/advice.parser.js';
import type { StatusSnapshot } from './status.report.js';

export interface AvailableItem {
  colorTh: string;
  storage: string;
  /// Sellable units Advice reports. null when the count was not in the response.
  quantity: number | null;
  /// Deep link straight to this colour+capacity - where to tap "buy".
  url?: string | null;
  priceTHB?: number | null;
}

/// "฿52,900" - whole baht, no decimals, for compact chat lines.
export const formatPrice = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : `฿${Math.round(value).toLocaleString('en-US')}`;

/// Identifies one variant, for matching a snapshot row against the
/// transitions that triggered the alert.
export const itemKey = (item: Pick<AvailableItem, 'colorTh' | 'storage'>): string =>
  `${item.colorTh}|${item.storage}`;

/**
 * Groups what is in stock by capacity.
 *
 * Advice sells one online channel, so there is no branch to group by - the
 * decision a person actually makes is "which capacity, and does the colour I
 * want exist at that capacity", which is one glance when grouped this way.
 * Capacities are ordered smallest first, so 1TB ranks above 512GB.
 */
export const groupByStorage = (items: readonly AvailableItem[]): Map<string, AvailableItem[]> => {
  const grouped = new Map<string, AvailableItem[]>();

  for (const item of [...items].sort(
    (a, b) =>
      storageRank(a.storage) - storageRank(b.storage) || a.colorTh.localeCompare(b.colorTh),
  )) {
    const bucket = grouped.get(item.storage);
    if (bucket) bucket.push(item);
    else grouped.set(item.storage, [item]);
  }

  return grouped;
};

/// "เหลือ 3 เครื่อง" - omitted entirely when Advice gave no count, so the
/// message never implies a number we did not actually observe.
const quantityLabel = (quantity: number | null): string =>
  quantity !== null && quantity > 0 ? `  (เหลือ ${quantity})` : '';

/**
 * The shared body: summary counts, then everything in stock grouped by capacity.
 *
 * `newKeys` marks the rows that only just became available, so a person can
 * tell at a glance what changed without losing the full picture.
 */
export const buildAvailabilityBody = (
  snapshot: StatusSnapshot,
  newKeys: ReadonlySet<string> = new Set(),
): string => {
  const lines: string[] = [
    `รุ่น: ${env.ADVICE_MODEL_FILTER}`,
    `ร้าน: ${snapshot.channelName}`,
    `มีของ: ${snapshot.available} / ${snapshot.total}`,
    `ไม่มีของ: ${snapshot.unavailable}`,
  ];

  // Non-zero means Advice could not be reached for those - worth saying so,
  // because "ไม่มีของ" and "ไม่รู้" are very different answers.
  if (snapshot.unknown > 0) lines.push(`ไม่ทราบสถานะ: ${snapshot.unknown}`);

  lines.push(
    `ตรวจล่าสุด: ${
      snapshot.lastCheckedAt ? formatThaiDateTime(snapshot.lastCheckedAt) : 'ยังไม่เคยตรวจ'
    }`,
  );

  if (snapshot.inStock.length === 0) {
    lines.push('', '🔴 ยังไม่มีสินค้าพร้อมจำหน่าย');
    return lines.join('\n');
  }

  lines.push('', '🟢 พร้อมจำหน่าย');

  for (const [storage, items] of groupByStorage(snapshot.inStock)) {
    lines.push('', `💾 ${storage}`);
    for (const item of items) {
      const isNew = newKeys.has(itemKey(item));
      const price = formatPrice(item.priceTHB);
      lines.push(
        `   • ${item.colorTh}${price ? `  ${price}` : ''}${quantityLabel(item.quantity)}${isNew ? '  🆕' : ''}`,
      );
      if (item.url) lines.push(`     🛒 ${item.url}`);
    }
  }

  return lines.join('\n');
};

/**
 * The alert sent when something has just come INTO stock.
 *
 * It leads with what changed (that is why the message exists) but then shows
 * the full current availability, so the reader does not have to go and ask
 * "and what else is there?" separately.
 */
export const buildStockAlertText = (
  transitions: readonly { stock: { model: string; colorTh: string; storage: string } }[],
  snapshot: StatusSnapshot,
): string => {
  const model = transitions[0]?.stock.model ?? env.ADVICE_MODEL_FILTER;
  const newKeys = new Set(
    transitions.map((transition) =>
      itemKey({ colorTh: transition.stock.colorTh, storage: transition.stock.storage }),
    ),
  );

  return [
    `📱 ${model} STOCK ALERT`,
    '',
    `🔔 เพิ่งมีของ ${transitions.length} รายการ`,
    '',
    buildAvailabilityBody(snapshot, newKeys),
  ].join('\n');
};
