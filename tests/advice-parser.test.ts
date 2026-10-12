import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stringify } from 'devalue';
import { describe, expect, it } from 'vitest';
import {
  buildVariantUrl,
  collectGroupProducts,
  extractNuxtPayload,
  parseProductName,
  parseProductPage,
  storageRank,
  toStockStatus,
  toThaiColor,
  type VariantFilter,
} from '../src/advice/advice.parser.js';
import { ONLINE_CHANNEL } from '../src/advice/advice.channel.js';
import type { AdviceGroupItem } from '../src/advice/advice.types.js';

interface Fixture {
  key: string;
  product: Record<string, unknown> & { product_group: AdviceGroupItem[] };
}

/// Pruned from the REAL www.advice.co.th PDP payload (2026-10-12): the same
/// 16 group items, same option ids and stock flags, unused fields removed.
const FIXTURE: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/advice-pdp.json', import.meta.url)), 'utf8'),
);

const PRODUCT_URL = 'https://www.advice.co.th/product/iphone/iphone-18-pro/iphone-18-pro-max';

/**
 * Re-encode the fixture the way Nuxt does: devalue, with the root wrapped in
 * Nuxt's ShallowReactive tag (which plain devalue.parse would reject).
 */
const toHtml = (product: unknown, key = FIXTURE.key): string => {
  const root = { data: { [key]: { product, banner: null } }, state: {}, serverRendered: true };
  const payload = stringify(root, {
    ShallowReactive: (value: unknown) => (value === root ? { ...root } : undefined),
  });
  return `<html><body><div id="__nuxt"></div><script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">${payload}</script></body></html>`;
};

const PDP_HTML = toHtml(FIXTURE.product);

const FILTER: VariantFilter = {
  model: 'iPhone 18 Pro Max',
  storages: ['256GB', '512GB'],
  colors: [],
};

const parse = (html = PDP_HTML, filter = FILTER, requireCart = true) =>
  parseProductPage(html, filter, PRODUCT_URL, ONLINE_CHANNEL, requireCart, new Date(0));

const clone = (): Fixture['product'] => structuredClone(FIXTURE.product);

describe('Nuxt payload extraction', () => {
  it('parses the devalue payload', () => {
    expect(extractNuxtPayload(PDP_HTML)).not.toBeNull();
  });

  it('returns null instead of throwing when the payload is absent or corrupt', () => {
    expect(extractNuxtPayload('<html><body>no payload</body></html>')).toBeNull();
    expect(
      extractNuxtPayload('<script id="__NUXT_DATA__">{not devalue at all</script>'),
    ).toBeNull();
  });

  it('finds the product group by shape, not by the Nuxt data key', () => {
    const html = toHtml(FIXTURE.product, 'some-renamed-key');
    const groups = collectGroupProducts(extractNuxtPayload(html));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.product_group).toHaveLength(16);
  });
});

describe('catalogue + stock parsing (real Advice payload)', () => {
  it('tracks only 256GB and 512GB, in every colour', () => {
    const page = parse();
    expect(page).not.toBeNull();
    expect(page!.variants).toHaveLength(8);
    expect(new Set(page!.variants.map((v) => v.storage))).toEqual(new Set(['256GB', '512GB']));
    expect(new Set(page!.variants.map((v) => v.color))).toEqual(
      new Set(['Black', 'Silver', 'Burgundy', 'Glacier']),
    );
  });

  it('tracks the whole lineup when no storage filter is set', () => {
    const page = parse(PDP_HTML, { ...FILTER, storages: [] });
    expect(page!.variants).toHaveLength(16);
  });

  it('honours a colour filter', () => {
    const page = parse(PDP_HTML, { ...FILTER, colors: ['burgundy'] });
    expect(page!.variants.map((v) => v.sku).sort()).toEqual(['A0186086', 'A0186090']);
  });

  it('maps option ids to colour, capacity, swatch, price and deep link', () => {
    const variant = parse()!.variants.find((v) => v.sku === 'A0186086');
    expect(variant).toEqual({
      sku: 'A0186086',
      model: 'iPhone 18 Pro Max',
      storage: '256GB',
      color: 'Burgundy',
      colorTh: 'เบอร์กันดี',
      colorKey: 'burgundy',
      colorCode: '#4D1821',
      priceTHB: 52900,
      url: 'https://www.advice.co.th/product/iphone/iphone-18-pro/apple-iphone-18-pro-max-256gb-burgundy-mjxq4zp-a-',
    });
  });

  it('sorts by capacity then colour', () => {
    const order = parse()!.variants.map((v) => `${v.storage} ${v.color}`);
    expect(order[0]).toBe('256GB Black');
    expect(order[7]).toBe('512GB Silver');
  });

  it('reads every 256/512 variant as UNAVAILABLE in the captured snapshot', () => {
    const stocks = parse()!.stocks;
    expect(stocks).toHaveLength(8);
    expect(stocks.every((s) => s.status === 'UNAVAILABLE' && !s.available)).toBe(true);
  });

  it('reads the in-stock 1TB / 2TB items as AVAILABLE', () => {
    const stocks = parse(PDP_HTML, { ...FILTER, storages: [] })!.stocks;
    const available = stocks.filter((s) => s.available).map((s) => s.sku).sort();
    expect(available).toEqual(['A0186092', 'A0186096', 'A0186098']);
  });

  it('never invents a unit count from the 0/1 instock flag', () => {
    const stocks = parse(PDP_HTML, { ...FILTER, storages: [] })!.stocks;
    expect(stocks.every((s) => s.quantity === null)).toBe(true);
    expect(stocks.find((s) => s.sku === 'A0186092')?.quote).toBe('พร้อมจำหน่าย (สั่งออนไลน์ได้)');
  });

  it('flips to AVAILABLE when a 256GB variant restocks', () => {
    const product = clone();
    const item = product.product_group.find((i) => i.code === 'A0186085')!;
    item.type = 'instock';
    item.product_get!.stock = { ...item.product_get!.stock, instock: 1, type: 'instock', cart: 'T' };

    const stock = parse(toHtml(product))!.stocks.find((s) => s.sku === 'A0186085');
    expect(stock?.status).toBe('AVAILABLE');
    expect(stock?.storeName).toBe('Advice Online');
  });

  it('degrades to UNKNOWN for an item with no stock block', () => {
    const product = clone();
    delete product.product_group[0]!.product_get;
    const stock = parse(toHtml(product))!.stocks.find((s) => s.sku === 'A0186084');
    expect(stock?.status).toBe('UNKNOWN');
    expect(stock?.available).toBe(false);
  });

  it('falls back to the product name when option ids do not resolve', () => {
    const product = clone();
    product.options = [];
    const page = parse(toHtml(product));
    expect(page!.variants).toHaveLength(8);
    expect(page!.variants.find((v) => v.sku === 'A0186091')?.color).toBe('Glacier');
  });

  it('returns null for a page without a group (challenge page, shape drift)', () => {
    expect(parse('<html><title>Just a moment...</title></html>')).toBeNull();
    expect(parse(toHtml({ hello: 'world' }))).toBeNull();
  });

  it('ignores a group for another model', () => {
    const page = parse(PDP_HTML, { ...FILTER, model: 'iPhone 18 Pro' });
    expect(page).toBeNull();
  });
});

describe('toStockStatus', () => {
  const base = { instock: 1, type: 'instock', cart: 'T' };

  it('requires instock + add-to-cart', () => {
    expect(toStockStatus(base, true)).toBe('AVAILABLE');
    expect(toStockStatus({ ...base, cart: '' }, true)).toBe('UNAVAILABLE');
    expect(toStockStatus({ ...base, cart: undefined }, true)).toBe('UNKNOWN');
  });

  it('ignores the cart flag when requireCart is off', () => {
    expect(toStockStatus({ ...base, cart: '' }, false)).toBe('AVAILABLE');
  });

  it('reads outstock / zero as UNAVAILABLE', () => {
    expect(toStockStatus({ instock: 0, type: 'outstock', cart: '' }, true)).toBe('UNAVAILABLE');
    expect(toStockStatus({ instock: 0, type: 'instock', cart: 'T' }, true)).toBe('UNAVAILABLE');
  });

  it('treats an unfamiliar type as not buyable', () => {
    expect(toStockStatus({ instock: 0, type: 'preorder' }, true)).toBe('UNAVAILABLE');
  });

  it('is UNKNOWN when Advice said nothing', () => {
    expect(toStockStatus(undefined, true)).toBe('UNKNOWN');
    expect(toStockStatus({}, true)).toBe('UNKNOWN');
  });
});

describe('helpers', () => {
  it('parses colour and capacity from the product name', () => {
    expect(parseProductName('Apple iPhone 18 Pro Max 1TB Black (MJXX4ZP/A)')).toEqual({
      storage: '1TB',
      color: 'Black',
    });
  });

  it('builds the variant deep link next to the group page', () => {
    expect(
      buildVariantUrl(PRODUCT_URL, { code: 'x', product: 'x', product_url: 'abc-' }),
    ).toBe('https://www.advice.co.th/product/iphone/iphone-18-pro/abc-');
    expect(buildVariantUrl(PRODUCT_URL, { code: 'x', product: 'x' })).toBe(PRODUCT_URL);
  });

  it('ranks TB above GB', () => {
    expect(storageRank('1TB')).toBeGreaterThan(storageRank('512GB'));
  });

  it('translates colours to Thai', () => {
    expect(toThaiColor('Glacier')).toBe('ธารน้ำแข็ง');
    expect(toThaiColor('Unknown')).toBe('Unknown');
  });
});
