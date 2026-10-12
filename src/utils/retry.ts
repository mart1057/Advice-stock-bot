import { logger } from './logger.js';
import { sleep } from './sleep.js';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  label: string;
  /// Return false to fail fast (e.g. 404 - retrying will not help).
  isRetryable?: (error: unknown) => boolean;
}

/// Exponential backoff with full jitter, capped at 30s per wait.
const backoffDelay = (attempt: number, baseDelayMs: number): number => {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, 30_000);
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
};

export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const { retries, baseDelayMs, label, isRetryable } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = isRetryable ? isRetryable(error) : true;
      const exhausted = attempt >= retries;

      if (!retryable || exhausted) {
        logger.error(
          `${label} failed`,
          `${error instanceof Error ? error.message : String(error)} attempt=${attempt + 1}/${retries + 1}${retryable ? '' : ' (non-retryable)'}`,
        );
        throw error;
      }

      const delay = backoffDelay(attempt, baseDelayMs);
      logger.warn(
        `${label} failed`,
        `${error instanceof Error ? error.message : String(error)} retry=${attempt + 1}/${retries} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
};
