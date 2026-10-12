import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ONLINE_CHANNEL } from './advice.channel.js';
import { adviceClient, type AdviceClient } from './advice.client.js';
import { parseProductPage, type ParsedPage } from './advice.parser.js';
import type { AdviceVariant } from './advice.types.js';

/**
 * Advice's PDP carries catalogue and stock together, so there is no separate
 * catalogue request: every sweep re-reads the lineup. This class just keeps the
 * LAST KNOWN variant list, so a failed sweep still knows which rows to mark
 * UNKNOWN, and the boot banner has something to print.
 */
export class AdviceCatalog {
  private variants: AdviceVariant[] = [];

  constructor(private readonly client: AdviceClient = adviceClient) {}

  /// Parse a freshly fetched page and remember its variants.
  parse(html: string, checkedAt: Date): ParsedPage | null {
    const parsed = parseProductPage(
      html,
      env.variantFilter,
      env.ADVICE_PRODUCT_URL,
      ONLINE_CHANNEL,
      env.ADVICE_REQUIRE_CART,
      checkedAt,
    );

    if (parsed === null || parsed.variants.length === 0) {
      logger.error(
        'Advice page parse returned 0 tracked variants - keeping previous catalogue',
        `model="${env.ADVICE_MODEL_FILTER}" storages=${env.variantFilter.storages.join('/') || 'all'} url=${env.ADVICE_PRODUCT_URL}`,
      );
      return null;
    }

    const before = this.variants.map((variant) => variant.sku).join(',');
    this.variants = parsed.variants;
    if (before !== parsed.variants.map((variant) => variant.sku).join(',')) {
      logger.info(
        `Catalogue loaded: ${parsed.variants.length} variants`,
        `colors=${[...new Set(parsed.variants.map((v) => v.color))].join('/')} storage=${[...new Set(parsed.variants.map((v) => v.storage))].join('/')}`,
      );
    }

    return parsed;
  }

  lastKnown(): AdviceVariant[] {
    return this.variants;
  }

  /// Variants for the boot banner - fetches the page once if nothing is known yet.
  async getVariants(): Promise<AdviceVariant[]> {
    if (this.variants.length > 0) return this.variants;
    const html = await this.client.getProductPageHtml();
    this.parse(html, new Date());
    return this.variants;
  }
}

export const adviceCatalog = new AdviceCatalog();
