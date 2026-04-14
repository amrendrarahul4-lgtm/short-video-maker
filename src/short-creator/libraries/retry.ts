import { logger } from "../../logger";

export interface RetryOptions {
  /** Maximum number of attempts (first try + retries). Default: 3 */
  maxAttempts: number;
  /** Base delay in ms for exponential backoff. Default: 500 */
  baseDelayMs: number;
  /** Maximum delay cap in ms. Default: 30_000 */
  maxDelayMs: number;
  /** Human-readable label used in log messages */
  label: string;
  /** Optional extra context fields to include in log messages */
  context?: Record<string, unknown>;
  /**
   * Predicate that returns true when an error is fatal and should NOT be
   * retried (e.g. auth failures, missing API keys).  Defaults to () => false.
   */
  isFatal?: (err: unknown) => boolean;
}

const defaultOptions: Omit<RetryOptions, "label"> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` with automatic exponential-backoff retries.
 *
 * `fn` receives the current attempt number (1-based) so callers can apply
 * progressively degraded settings on retries.
 *
 * On each failure the delay doubles: baseDelayMs * 2^(attempt-1), capped at
 * maxDelayMs.  If `isFatal` returns true for an error it is re-thrown
 * immediately without further retries.
 *
 * @returns The resolved value of `fn` on success.
 * @throws  The last error if all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> & Pick<RetryOptions, "label">,
): Promise<T> {
  const opts: RetryOptions = { ...defaultOptions, ...options };
  const { maxAttempts, baseDelayMs, maxDelayMs, label, context, isFatal } =
    opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      if (attempt > 1) {
        logger.info(
          { ...context, label, attempt },
          `${label} succeeded on attempt ${attempt}`,
        );
      }
      return result;
    } catch (err: unknown) {
      lastError = err;

      // Fatal errors should not be retried
      if (isFatal && isFatal(err)) {
        logger.error(
          {
            ...context,
            label,
            attempt,
            err: err instanceof Error ? err.message : String(err),
          },
          `${label} encountered a fatal error — not retrying`,
        );
        throw err;
      }

      if (attempt === maxAttempts) {
        logger.error(
          {
            ...context,
            label,
            attempt,
            maxAttempts,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          `${label} failed after ${maxAttempts} attempt(s) — giving up`,
        );
        break;
      }

      const delayMs = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1),
        maxDelayMs,
      );
      logger.warn(
        {
          ...context,
          label,
          attempt,
          maxAttempts,
          nextRetryDelayMs: delayMs,
          err: err instanceof Error ? err.message : String(err),
        },
        `${label} failed on attempt ${attempt} — retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}
