/**
 * Unit tests for withAnthropicRetry — the retry wrapper for Anthropic
 * SDK calls. Coverage:
 *
 *   - First-attempt success (no retry, no error wrapping).
 *   - Retryable failure that recovers (5xx → success on retry).
 *   - Retryable failure that exhausts (5xx three times → throws
 *     RetryExhaustedError with attempts count and originalError).
 *   - Non-retryable failure (4xx other than 429 → rethrows original
 *     error unchanged, NOT wrapped in RetryExhaustedError).
 *
 * Uses fake timers so the 1s + 3s backoff delays don't slow the
 * suite. vi.runAllTimersAsync() drains the timer queue until the
 * retry loop completes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAnthropicRetry, RetryExhaustedError } from '../anthropic-retry';

// Build a fake API error with a `.status` field — that's what
// shouldRetry inspects.
function apiError(status: number, message = `HTTP ${status}`): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Silence the warning emitted on each retry so the test output
  // stays clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withAnthropicRetry', () => {
  it('returns the result on first-attempt success', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const result = await withAnthropicRetry(call, 'test');
    expect(result).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and returns the result when a later attempt succeeds', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue({ ok: true });
    const promise = withAnthropicRetry(call, 'test');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError with attempts=3 when all retries fail', async () => {
    const underlying = apiError(503, 'service unavailable');
    const call = vi.fn().mockRejectedValue(underlying);
    // Attach the .catch handler synchronously when the promise is
    // created — vi.runAllTimersAsync() flushes the rejection before
    // any later try/catch could install one, which vitest reports as
    // an unhandled rejection. The handler converts the rejection into
    // a resolved value so we can `await` and then assert on the
    // captured error.
    const settled = withAnthropicRetry(call, 'test').catch((e) => e);
    await vi.runAllTimersAsync();
    const caught = await settled;
    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as RetryExhaustedError).attempts).toBe(3);
    expect((caught as RetryExhaustedError).originalError).toBe(underlying);
    // 3 total attempts: initial + 2 retries.
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-retryable errors unchanged (does NOT wrap in RetryExhaustedError)', async () => {
    const underlying = apiError(400, 'bad request');
    const call = vi.fn().mockRejectedValue(underlying);
    let caught: unknown;
    try {
      await withAnthropicRetry(call, 'test');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(underlying);
    expect(caught).not.toBeInstanceOf(RetryExhaustedError);
    // Only the initial attempt — no retries for 400.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 (rate limit)', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue({ ok: true });
    const promise = withAnthropicRetry(call, 'test');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
