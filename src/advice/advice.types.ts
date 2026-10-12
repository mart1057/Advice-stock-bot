import { z } from 'zod';

/**
 * Shapes below are modelled on the REAL payload observed on Advice
 * (www.advice.co.th), verified 2026-10-12:
 *
 *   GET https://www.advice.co.th/product/iphone/iphone-18-pro/iphone-18-pro-max
 *
 * Advice is a Nuxt 3 storefront. Its JSON API (/_advice-api/...) needs a
 * session token, but the product page is server-rendered and embeds the whole
 * variant group - every colour x capacity, with price and stock flags - in
 * the devalue payload `<script id="__NUXT_DATA__">`. One page fetch therefore
 * answers for the full lineup; no auth, no cookie, no token.
 *
 * Everything is deliberately permissive (`.passthrough()`, optional fields):
 * there is no public contract, so an unexpected shape must degrade to UNKNOWN
 * rather than crash the bot.
 */

/**
 * `product_get.stock` on each variant. Observed values:
 *   in stock : { instock: 1, type: "instock",  cart: "T", online_only: "T" }
 *   sold out : { instock: 0, type: "outstock", cart: "",  online_only: ""  }
 * `cart: "T"` is what enables the "เพิ่มลงตะกร้า" button - i.e. buyable now.
 */
export const adviceStockSchema = z
  .object({
    instock: z.number().optional(),
    book: z.number().optional(),
    inorder: z.number().optional(),
    type: z.string().optional(),
    online_only: z.string().optional(),
    cart: z.string().optional(),
    code: z.string().optional(),
    num_branch: z.number().optional(),
  })
  .passthrough();

/// One entry of `product.product_group` - a single colour x capacity.
export const adviceGroupItemSchema = z
  .object({
    code: z.string().min(1), // "A0186084" - Advice's item code, our SKU
    product: z.string(), // "Apple iPhone 18 Pro Max 256GB Black (MJXN4ZP/A)"
    product_url: z.string().optional(), // slug of this variant's own page
    price_srp: z.number().optional(),
    price_sale: z.number().optional(),
    type: z.string().optional(), // "instock" | "outstock" (mirrors stock.type)
    reservation_url: z.string().optional(),
    menu_sub_url: z.string().optional(),
    menu_dtl_url: z.string().optional(),
    /// { "<option_id>": <option_dtl_id> }, e.g. { "459": 1071, "460": 1074 }
    option: z.record(z.union([z.number(), z.string()])).optional(),
    option_color: z.array(z.string()).optional(),
    product_get: z
      .object({ stock: adviceStockSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const adviceOptionSchema = z
  .object({
    option_id: z.union([z.number(), z.string()]),
    option_name: z.string().optional(),
    option_type: z.string().optional(), // "COLOR" | "TEXT"
    option_detail: z
      .array(
        z
          .object({
            option_dtl_id: z.union([z.number(), z.string()]),
            value: z.string().optional(), // "#3C3C3C" or "256GB"
            text: z.string().optional(), // "Black"     or "256GB"
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/// The PDP's root product when it is a variant group (card_type "group").
export const adviceGroupProductSchema = z
  .object({
    group: z
      .object({ item_group_name: z.string().optional() })
      .passthrough()
      .optional(),
    options: z.array(adviceOptionSchema).default([]),
    product_group: z.array(adviceGroupItemSchema).min(1),
  })
  .passthrough();

export type AdviceStock = z.infer<typeof adviceStockSchema>;
export type AdviceGroupItem = z.infer<typeof adviceGroupItemSchema>;
export type AdviceOption = z.infer<typeof adviceOptionSchema>;
export type AdviceGroupProduct = z.infer<typeof adviceGroupProductSchema>;

/// One sellable configuration on the PDP, e.g. 256GB Black -> A0186084.
export interface AdviceVariant {
  sku: string; // "A0186084" - Advice item code
  model: string; // "iPhone 18 Pro Max"
  storage: string; // "256GB"
  color: string; // canonical English, e.g. "Burgundy"
  colorTh: string; // Thai display name
  colorKey: string; // "burgundy"
  colorCode: string | null; // "#4D1821"
  priceTHB: number | null;
  /// Deep link straight to this colour+capacity's own page.
  url: string;
}

/// The selling channel an observation belongs to. Today only Advice Online.
export interface AdviceChannel {
  code: string; // "ONLINE"
  name: string; // "Advice Online"
  rawName: string;
  country: string;
  storeUrl?: string;
}

/**
 * Statuses that mean "Advice is pushing back", not "the data says unavailable".
 * Advice sits behind Cloudflare, so a bot challenge shows up as 403.
 */
export const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

export class AdviceRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'AdviceRequestError';
  }

  get isRateLimit(): boolean {
    return this.status !== undefined && RATE_LIMIT_STATUSES.has(this.status);
  }
}

export const isRateLimitError = (error: unknown): boolean =>
  error instanceof AdviceRequestError && error.isRateLimit;
