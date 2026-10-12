import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { AdviceRequestError } from './advice.types.js';

/// Same UA a normal Chrome on macOS sends. We do not spoof anything else and
/// we do not attempt to defeat any protection - if Advice blocks us we report it.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/// 4xx (other than 408/429) will not become healthy by retrying.
const isRetryableError = (error: unknown): boolean => {
  if (error instanceof AdviceRequestError) return error.retryable;
  return true;
};

/**
 * Advice is fronted by Cloudflare. A bot challenge is served as 403 (or as a
 * 200 "Just a moment..." page on some edges). Both are treated as push-back so
 * the adaptive cooldown kicks in instead of hammering the site.
 */
const looksLikeChallenge = (response: Response, body: string): boolean =>
  response.headers.get('cf-mitigated') === 'challenge' ||
  /<title>\s*Just a moment/i.test(body) ||
  body.includes('/cdn-cgi/challenge-platform/h/b/orchestrate');

export class AdviceClient {
  /// Raw HTML of the PDP. Carries catalogue AND stock for the whole group.
  async getProductPageHtml(url: string = env.ADVICE_PRODUCT_URL): Promise<string> {
    return withRetry(
      async () => {
        const started = Date.now();
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
          },
        });

        if (!response.ok) {
          const retryable =
            response.status >= 500 || response.status === 408 || response.status === 429;
          throw new AdviceRequestError(
            `Advice request failed status=${response.status} url=${url}`,
            response.status,
            retryable,
          );
        }

        const html = await response.text();

        if (looksLikeChallenge(response, html)) {
          throw new AdviceRequestError(
            `Advice served a Cloudflare challenge url=${url}`,
            403,
            false,
          );
        }

        logger.debug('product page ok', { bytes: html.length, ms: Date.now() - started });
        return html;
      },
      {
        retries: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        label: 'Advice product page',
        isRetryable: isRetryableError,
      },
    );
  }
}

export const adviceClient = new AdviceClient();
