/**
 * Retry wrapper for Anthropic SDK calls. Retries up to 2 times (3 total
 * attempts) on 429 / 5xx with exponential backoff (1s, 3s). Respects a
 * `Retry-After` header on 429 when present. Anything else (4xx other
 * than 429, network errors with no status, parse errors thrown by the
 * caller's continuation) is rethrown immediately so non-transient
 * failures don't get re-tried into Vercel's maxDuration ceiling.
 *
 * When all retries fail, the wrapper throws RetryExhaustedError with
 * the attempts count attached. structuredErrorResponse picks that up
 * automatically and surfaces `retryAttempts` in the API response body
 * so production-trace readers can distinguish "instant failure" from
 * "long wait then failure."
 *
 * Usage:
 *   const resp = await withAnthropicRetry(() =>
 *     client.messages.create({ ... })
 *   );
 */

const RETRY_DELAYS_MS = [1000, 3000];

/**
 * Thrown by withAnthropicRetry when a retryable error (429 / 5xx)
 * runs out of retries. Carries the attempts count and the last
 * underlying error so the route's catch block can surface both.
 *
 * Non-retryable errors (4xx other than 429, parse errors, etc.) are
 * rethrown unchanged — they're not "retry exhaustion," they're just
 * failures on the first attempt.
 */
export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly originalError: unknown;

  constructor(attempts: number, originalError: unknown, label: string) {
    const inner =
      originalError instanceof Error ? originalError.message : String(originalError);
    super(`[${label}] retries exhausted after ${attempts} attempts: ${inner}`);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.originalError = originalError;
  }
}

interface MaybeApiError {
  status?: number;
  headers?: Record<string, string | undefined>;
  message?: string;
}

function shouldRetry(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as MaybeApiError;
  const status = e.status;
  if (typeof status !== 'number') return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function retryAfterMs(err: unknown, fallbackMs: number): number {
  if (!err || typeof err !== 'object') return fallbackMs;
  const e = err as MaybeApiError;
  const raw = e.headers?.['retry-after'];
  if (!raw) return fallbackMs;
  // Retry-After is either a delay-seconds integer or an HTTP-date.
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) {
    // Cap at 10s so a misbehaving header can't stretch us past the
    // route's maxDuration. The user can always retry the whole pipeline.
    return Math.min(asNum * 1000, 10_000);
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    if (delta > 0) return Math.min(delta, 10_000);
  }
  return fallbackMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withAnthropicRetry<T>(
  call: () => Promise<T>,
  label = 'anthropic'
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      // Non-retryable: rethrow original error unchanged. Not "retry
      // exhausted" — the wrapper never even tried to retry.
      if (!shouldRetry(err)) {
        throw err;
      }
      // Retryable but no more retries left: wrap in RetryExhaustedError
      // so the route's catch can surface the attempts count.
      if (attempt === RETRY_DELAYS_MS.length) {
        throw new RetryExhaustedError(attempt + 1, err, label);
      }
      const baseDelay = RETRY_DELAYS_MS[attempt];
      const delay = retryAfterMs(err, baseDelay);
      const status = (err as MaybeApiError).status;
      console.warn(
        `[${label}] retry ${attempt + 1}/${RETRY_DELAYS_MS.length} after ${delay}ms (status ${status})`
      );
      await sleep(delay);
    }
  }
  // Unreachable — the loop either returns or throws.
  throw lastErr;
}
