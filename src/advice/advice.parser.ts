import { parse as parseDevalue } from 'devalue';
import type { ProductStock, StockStatus } from '../stock/stock.types.js';
import { logger } from '../utils/logger.js';
import {
  adviceGroupProductSchema,
  type AdviceChannel,
  type AdviceGroupItem,
  type AdviceGroupProduct,
  type AdviceStock,
  type AdviceVariant,
} from './advice.types.js';

/**
 * Advice renders the PDP with Nuxt 3, which embeds its SSR payload as
 * devalue-serialised JSON in <script id="__NUXT_DATA__">. That payload carries
 * `product.product_group` - every colour x capacity with price and stock - so
 * one page fetch is a full sweep and nothing is hard-coded.
 */
const NUXT_DATA_RE = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

/**
 * Nuxt tags reactive values with its own devalue types. devalue throws on an
 * unknown type, so every Nuxt tag is reduced to the value it wraps.
 */
const identity = <T>(value: T): T => value;

const NUXT_REVIVERS: Record<string, (value: unknown) => unknown> = {
  Reactive: identity,
  ShallowReactive: identity,
  Ref: identity,
  ShallowRef: identity,
  EmptyRef: identity,
  EmptyShallowRef: identity,
  NuxtError: identity,
};

export const extractNuxtPayload = (html: string): unknown => {
  const match = NUXT_DATA_RE.exec(html);
  if (!match?.[1]) return null;

  try {
    return parseDevalue(match[1], NUXT_REVIVERS);
  } catch (error) {
    logger.debug('Failed to parse __NUXT_DATA__', error);
    return null;
  }
};

const hasProductGroup = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Array.isArray((value as Record<string, unknown>).product_group);

/**
 * Finds every node that owns a `product_group` array. The payload is a graph
 * with shared references, so the walk is guarded by a visited set. Searching
 * by shape (not by the Nuxt data key) survives Advice renaming its keys.
 */
export const collectGroupProducts = (payload: unknown): AdviceGroupProduct[] => {
  const found: AdviceGroupProduct[] = [];
  const seen = new Set<object>();

  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (hasProductGroup(value)) {
      const parsed = adviceGroupProductSchema.safeParse(value);
      if (parsed.success) found.push(parsed.data);
      else logger.debug('product_group node has an unexpected shape', parsed.error.issues[0]);
    }
    for (const item of Object.values(value)) walk(item);
  };

  walk(payload);
  return found;
};

export const normaliseSpaces = (value: string): string =>
  value.replace(/[  -​　]/g, ' ').replace(/\s+/g, ' ').trim();

/// Sortable size in GB, so "1TB" ranks above "512GB" instead of below it.
export const storageRank = (storage: string): number => {
  const match = /^(\d+)(GB|TB)$/i.exec(storage.trim());
  if (!match?.[1]) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseInt(match[1], 10);
  return match[2]?.toUpperCase() === 'TB' ? value * 1024 : value;
};

export const normaliseStorage = (value: string): string => value.replace(/\s+/g, '').toUpperCase();

/// Thai display names, matching the wording used by the Apple / True bots.
export const COLOR_EN_TO_TH: Readonly<Record<string, string>> = {
  Black: 'ดำ',
  Silver: 'เงิน',
  Glacier: 'ธารน้ำแข็ง',
  Burgundy: 'เบอร์กันดี',
};

export const toThaiColor = (colorEn: string): string => COLOR_EN_TO_TH[colorEn] ?? colorEn;

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * "Apple iPhone 18 Pro Max 256GB Black (MJXN4ZP/A)" -> { storage, color }.
 * Fallback for when the option ids cannot be resolved.
 */
export const parseProductName = (
  name: string,
): { storage: string; color: string } | null => {
  const match = /(\d+\s?(?:GB|TB))\s+(.+?)\s*(?:\(|$)/i.exec(normaliseSpaces(name));
  if (!match?.[1] || !match[2]) return null;
  return { storage: normaliseStorage(match[1]), color: match[2].trim() };
};

interface OptionLookup {
  colorById: Map<string, { text: string; value: string | null }>;
  storageById: Map<string, string>;
  colorOptionId: string | null;
  storageOptionId: string | null;
}

const buildOptionLookup = (product: AdviceGroupProduct): OptionLookup => {
  const lookup: OptionLookup = {
    colorById: new Map(),
    storageById: new Map(),
    colorOptionId: null,
    storageOptionId: null,
  };

  for (const option of product.options) {
    const id = String(option.option_id);
    const isColor = option.option_type?.toUpperCase() === 'COLOR';
    const looksLikeStorage = option.option_detail.some((detail) =>
      /^\d+\s?(GB|TB)$/i.test((detail.text ?? detail.value ?? '').trim()),
    );

    if (isColor) {
      lookup.colorOptionId = id;
      for (const detail of option.option_detail) {
        const text = detail.text ?? detail.value;
        if (text) {
          lookup.colorById.set(String(detail.option_dtl_id), {
            text: text.trim(),
            value: detail.value?.startsWith('#') ? detail.value : null,
          });
        }
      }
    } else if (looksLikeStorage) {
      lookup.storageOptionId = id;
      for (const detail of option.option_detail) {
        const text = detail.text ?? detail.value;
        if (text) lookup.storageById.set(String(detail.option_dtl_id), normaliseStorage(text));
      }
    }
  }

  return lookup;
};

/// Deep link to this variant's own page, next to the group page.
export const buildVariantUrl = (productUrl: string, item: AdviceGroupItem): string => {
  if (!item.product_url) return productUrl;
  try {
    const base = new URL(productUrl);
    const segments = base.pathname.split('/').filter((part) => part.length > 0);
    segments[segments.length - 1] = item.product_url;
    base.pathname = `/${segments.join('/')}`;
    base.search = '';
    return base.toString();
  } catch {
    return productUrl;
  }
};

export interface VariantFilter {
  model: string;
  /// Upper-case storages to keep, e.g. ["256GB", "512GB"]. Empty = all.
  storages: readonly string[];
  /// Colours to keep (case-insensitive English). Empty = all.
  colors: readonly string[];
}

/// Group item -> AdviceVariant, or null when it cannot be identified.
export const parseVariant = (
  item: AdviceGroupItem,
  lookup: OptionLookup,
  model: string,
  productUrl: string,
): AdviceVariant | null => {
  const fromName = parseProductName(item.product);

  const colorDtl =
    lookup.colorOptionId !== null ? item.option?.[lookup.colorOptionId] : undefined;
  const storageDtl =
    lookup.storageOptionId !== null ? item.option?.[lookup.storageOptionId] : undefined;

  const colorOpt = colorDtl !== undefined ? lookup.colorById.get(String(colorDtl)) : undefined;
  const storage =
    (storageDtl !== undefined ? lookup.storageById.get(String(storageDtl)) : undefined) ??
    fromName?.storage;
  const color = colorOpt?.text ?? fromName?.color;

  if (!storage || !color) return null;

  const price = item.price_sale ?? item.price_srp;

  return {
    sku: item.code,
    model,
    storage,
    color,
    colorTh: toThaiColor(color),
    colorKey: slug(color),
    colorCode: colorOpt?.value ?? item.option_color?.[0] ?? null,
    priceTHB: typeof price === 'number' && price > 0 ? price : null,
    url: buildVariantUrl(productUrl, item),
  };
};

const matchesFilter = (variant: AdviceVariant, filter: VariantFilter): boolean => {
  if (filter.storages.length > 0 && !filter.storages.includes(variant.storage)) return false;
  if (
    filter.colors.length > 0 &&
    !filter.colors.some((color) => color.toLowerCase() === variant.color.toLowerCase())
  ) {
    return false;
  }
  return true;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Picks the group for the tracked model. A PDP can also carry related
 * products elsewhere in the payload, so the group whose name matches wins;
 * otherwise the group whose items mention the model.
 */
const pickGroup = (
  groups: readonly AdviceGroupProduct[],
  model: string,
): AdviceGroupProduct | null => {
  const wanted = normaliseSpaces(model).toLowerCase();
  return (
    groups.find(
      (group) => normaliseSpaces(group.group?.item_group_name ?? '').toLowerCase() === wanted,
    ) ??
    // "iPhone 18 Pro" must not match "iPhone 18 Pro Max 256GB": require the
    // capacity to follow the model name directly.
    groups.find((group) =>
      group.product_group.every((item) =>
        new RegExp(`${escapeRegExp(wanted)}\\s+\\d+\\s?(gb|tb)\\b`).test(
          normaliseSpaces(item.product).toLowerCase(),
        ),
      ),
    ) ??
    null
  );
};

/**
 * Maps one variant's stock flags to our tri-state.
 *
 * AVAILABLE requires ALL of:
 *   - stock.type === "instock"
 *   - stock.instock > 0
 *   - stock.cart === "T"   (the add-to-cart button is enabled)
 *     unless `requireCart` is off.
 *
 * Anything Advice did not tell us is UNKNOWN, never UNAVAILABLE.
 */
export const toStockStatus = (
  stock: AdviceStock | undefined,
  requireCart: boolean,
): StockStatus => {
  if (!stock) return 'UNKNOWN';

  const type = stock.type?.toLowerCase();
  const instock = typeof stock.instock === 'number' ? stock.instock : null;

  if (type === undefined && instock === null) return 'UNKNOWN';

  if (type === 'outstock' || instock === 0) return 'UNAVAILABLE';

  if (type === 'instock' && (instock === null || instock > 0)) {
    if (!requireCart) return 'AVAILABLE';
    if (stock.cart === undefined) return 'UNKNOWN';
    return stock.cart === 'T' ? 'AVAILABLE' : 'UNAVAILABLE';
  }

  // An unfamiliar type ("preorder", "incoming", ...) is not buyable now, but
  // log it so a new state is noticed.
  logger.debug(`Unrecognised Advice stock type "${stock.type}"`, stock.code);
  return 'UNAVAILABLE';
};

export interface ParsedPage {
  /// Tracked variants after the storage/colour filter.
  variants: AdviceVariant[];
  /// One observation per tracked variant.
  stocks: ProductStock[];
}

/**
 * PDP HTML -> tracked variants + their stock, in one pass.
 * Returns null when the page carries no recognisable group (shape drift,
 * challenge page, wrong URL) - the caller degrades the sweep to UNKNOWN.
 */
export const parseProductPage = (
  html: string,
  filter: VariantFilter,
  productUrl: string,
  channel: AdviceChannel,
  requireCart: boolean,
  checkedAt: Date = new Date(),
): ParsedPage | null => {
  const payload = extractNuxtPayload(html);
  if (payload === null) return null;

  const model = normaliseSpaces(filter.model);
  const group = pickGroup(collectGroupProducts(payload), model);
  if (!group) return null;

  const lookup = buildOptionLookup(group);
  const variants: AdviceVariant[] = [];
  const stocks: ProductStock[] = [];
  const seen = new Set<string>();

  for (const item of group.product_group) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);

    const variant = parseVariant(item, lookup, model, productUrl);
    if (!variant || !matchesFilter(variant, filter)) continue;

    const status = toStockStatus(item.product_get?.stock, requireCart);

    variants.push(variant);
    stocks.push({
      model: variant.model,
      color: variant.color,
      colorTh: variant.colorTh,
      storage: variant.storage,
      sku: variant.sku,
      priceTHB: variant.priceTHB,
      url: variant.url,
      storeName: channel.name,
      storeCode: channel.code,
      status,
      available: status === 'AVAILABLE',
      // Advice exposes a 0/1 flag, not a real unit count - never show it as one.
      quantity: null,
      quote: status === 'AVAILABLE' ? 'พร้อมจำหน่าย (สั่งออนไลน์ได้)' : undefined,
      checkedAt,
    });
  }

  const order = (a: AdviceVariant, b: AdviceVariant): number =>
    storageRank(a.storage) - storageRank(b.storage) || a.color.localeCompare(b.color);
  variants.sort(order);

  return { variants, stocks };
};
