import { describe, expect, it } from 'vitest';
import {
  buildAvailabilityBody,
  buildStockAlertText,
  groupByStorage,
  itemKey,
  type AvailableItem,
} from '../src/notification/stock.text.js';
import type { StatusSnapshot } from '../src/notification/status.report.js';

const snapshot = (
  inStock: AvailableItem[],
  overrides: Partial<StatusSnapshot> = {},
): StatusSnapshot => ({
  total: 16,
  available: inStock.length,
  unavailable: 16 - inStock.length,
  unknown: 0,
  lastCheckedAt: new Date('2026-09-20T10:18:20.000Z'), // 17:18:20 Asia/Bangkok
  channelName: 'Advice Online Store',
  inStock,
  ...overrides,
});

const four: AvailableItem[] = [
  { colorTh: 'ดำ', storage: '2TB', quantity: 3 },
  { colorTh: 'ธารน้ำแข็ง', storage: '512GB', quantity: 1 },
  { colorTh: 'ดำ', storage: '512GB', quantity: null },
  { colorTh: 'ธารน้ำแข็ง', storage: '2TB', quantity: 2 },
];

describe('groupByStorage', () => {
  it('puts every item under its capacity, smallest capacity first', () => {
    const grouped = groupByStorage(four);

    // 2TB must rank AFTER 512GB - a plain string sort gets this backwards.
    expect([...grouped.keys()]).toEqual(['512GB', '2TB']);
    expect(grouped.get('512GB')).toHaveLength(2);
    expect(grouped.get('2TB')).toHaveLength(2);
  });

  it('does not mutate the caller array', () => {
    const input = [...four];
    groupByStorage(input);
    expect(input).toEqual(four);
  });
});

describe('buildAvailabilityBody', () => {
  it('lists each capacity with its colours', () => {
    const text = buildAvailabilityBody(snapshot(four));

    expect(text).toContain('ร้าน: Advice Online Store');
    expect(text).toContain('มีของ: 4 / 16');
    expect(text).toContain('ไม่มีของ: 12');
    expect(text).toContain('ตรวจล่าสุด: 20/09/2026 17:18:20');
    expect(text).toContain('💾 512GB');
    expect(text).toContain('💾 2TB');
    expect(text).toContain('   • ดำ');
  });

  it('states the remaining count when Advice reported one', () => {
    const text = buildAvailabilityBody(snapshot(four));
    expect(text).toContain('(เหลือ 3)');
  });

  /// Never imply a number we did not actually observe.
  it('omits the count entirely when Advice sent none', () => {
    const text = buildAvailabilityBody(snapshot([{ colorTh: 'ดำ', storage: '512GB', quantity: null }]));
    expect(text).toContain('   • ดำ');
    expect(text).not.toContain('เหลือ');
  });

  it('says so plainly when nothing is in stock', () => {
    const text = buildAvailabilityBody(snapshot([]));
    expect(text).toContain('🔴 ยังไม่มีสินค้าพร้อมจำหน่าย');
    expect(text).not.toContain('💾');
  });

  /// "ไม่มีของ" and "could not reach Advice" must never look the same.
  it('surfaces unknown count only when it is not zero', () => {
    expect(buildAvailabilityBody(snapshot(four))).not.toContain('ไม่ทราบสถานะ');
    expect(buildAvailabilityBody(snapshot(four, { unknown: 5 }))).toContain('ไม่ทราบสถานะ: 5');
  });
});

describe('buildStockAlertText', () => {
  const transition = (colorTh: string, storage: string) => ({
    stock: { model: 'iPhone 18 Pro Max', colorTh, storage },
  });

  it('leads with what just changed, then shows everything available', () => {
    const text = buildStockAlertText([transition('ดำ', '2TB')], snapshot(four));

    expect(text).toContain('📱 iPhone 18 Pro Max STOCK ALERT');
    expect(text).toContain('🔔 เพิ่งมีของ 1 รายการ');
    expect(text).toContain('💾 512GB');
    expect(text).toContain('💾 2TB');
  });

  /// The 🆕 marker is the whole point: it separates "this is why you got
  /// pinged" from "and here is the rest of what is on the shelf".
  it('marks only the item that just became available', () => {
    const text = buildStockAlertText([transition('ดำ', '2TB')], snapshot(four));

    // ดำ exists at both 512GB and 2TB - only the 2TB row may be marked.
    const marked = text.split('\n').filter((line) => line.includes('🆕'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('ดำ');
    expect(text.indexOf(marked[0]!)).toBeGreaterThan(text.indexOf('💾 2TB'));
  });

  it('marks every item when the whole set is new', () => {
    const transitions = four.map((item) => transition(item.colorTh, item.storage));
    const text = buildStockAlertText(transitions, snapshot(four));

    expect(text).toContain('🔔 เพิ่งมีของ 4 รายการ');
    expect(text.match(/🆕/g)).toHaveLength(4);
  });
});

describe('itemKey', () => {
  it('distinguishes the same colour at different capacities', () => {
    // four[0] is ดำ 2TB, four[2] is ดำ 512GB.
    expect(itemKey(four[0]!)).not.toBe(itemKey(four[2]!));
  });

  it('ignores quantity, so a row still matches as its count changes', () => {
    expect(itemKey({ colorTh: 'ดำ', storage: '2TB', quantity: 3 })).toBe(
      itemKey({ colorTh: 'ดำ', storage: '2TB', quantity: 1 }),
    );
  });
});

describe('buy links', () => {
  it('puts price and a buy link under every in-stock item', () => {
    const text = buildAvailabilityBody(
      snapshot([
        {
          colorTh: 'ดำ',
          storage: '1TB',
          quantity: null,
          priceTHB: 76900,
          url: 'https://www.advice.co.th/product/iphone/iphone-18-pro/apple-iphone-18-pro-max-1tb-black-mjxx4zp-a-',
        },
      ]),
    );
    expect(text).toContain('• ดำ  ฿76,900');
    expect(text).toContain(
      '🛒 https://www.advice.co.th/product/iphone/iphone-18-pro/apple-iphone-18-pro-max-1tb-black-mjxx4zp-a-',
    );
  });

  it('omits the link line when no url is known', () => {
    const text = buildAvailabilityBody(snapshot([{ colorTh: 'ดำ', storage: '1TB', quantity: null }]));
    expect(text).not.toContain('🛒');
  });
});
