import type { ProductStock } from '../stock/stock.types.js';
import { logger } from '../utils/logger.js';
import { ONLINE_CHANNEL } from './advice.channel.js';
import { adviceCatalog, type AdviceCatalog } from './advice.catalog.js';
import { adviceClient, type AdviceClient } from './advice.client.js';
import { isRateLimitError, type AdviceChannel, type AdviceVariant } from './advice.types.js';

export interface AvailabilitySnapshot {
  checkedAt: Date;
  stocks: ProductStock[];
  channels: AdviceChannel[];
  variants: AdviceVariant[];
  /// Requests that failed. Their variants are reported as UNKNOWN by the
  /// caller, never as UNAVAILABLE.
  errors: string[];
  /// True when the failure was Advice pushing back (403/429/503 or a
  /// Cloudflare challenge) rather than a parse or network problem.
  rateLimited: boolean;
}

/**
 * One sweep = ONE request: the product page embeds stock for every
 * colour x capacity in the group.
 */
export class AdviceAvailabilityCollector {
  constructor(
    private readonly client: AdviceClient = adviceClient,
    private readonly catalog: AdviceCatalog = adviceCatalog,
  ) {}

  async collect(): Promise<AvailabilitySnapshot> {
    const checkedAt = new Date();

    try {
      const html = await this.client.getProductPageHtml();
      const parsed = this.catalog.parse(html, checkedAt);

      if (parsed === null) {
        return this.failed(checkedAt, 'Advice page carried no recognisable product group', false);
      }

      logger.debug(`Availability sweep: 1 request`, `variants=${parsed.variants.length}`);
      return {
        checkedAt,
        stocks: parsed.stocks,
        channels: [ONLINE_CHANNEL],
        variants: parsed.variants,
        errors: [],
        rateLimited: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.failed(checkedAt, message, isRateLimitError(error));
    }
  }

  private failed(checkedAt: Date, message: string, rateLimited: boolean): AvailabilitySnapshot {
    return {
      checkedAt,
      stocks: [],
      channels: [ONLINE_CHANNEL],
      variants: this.catalog.lastKnown(),
      errors: [message],
      rateLimited,
    };
  }
}

export const adviceAvailabilityCollector = new AdviceAvailabilityCollector();
