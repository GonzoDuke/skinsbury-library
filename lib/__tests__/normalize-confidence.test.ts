/**
 * Unit tests for normalizeConfidence — the case-insensitive parser
 * that replaced the strict three-way equality check across the
 * confidence-bearing API routes (read-spine, identify-book,
 * infer-lcc, infer-tags).
 *
 * Coverage matches the audit prompt's spec:
 *   - lowercase variants normalize correctly
 *   - "Very High" synonym normalizes to HIGH
 *   - unexpected strings default to LOW with a console.warn
 *   - undefined defaults to LOW (without a warn — non-string input
 *     short-circuits before the warn branch)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfidence } from '../normalize-confidence';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeConfidence', () => {
  it('lowercase "high" returns "HIGH"', () => {
    expect(normalizeConfidence('high')).toBe('HIGH');
  });

  it('"Very High" returns "HIGH"', () => {
    expect(normalizeConfidence('Very High')).toBe('HIGH');
  });

  it('random string returns "LOW" and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeConfidence('banana')).toBe('LOW');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('unexpected confidence value');
    expect(warnSpy.mock.calls[0][0]).toContain('"banana"');
  });

  it('undefined returns "LOW"', () => {
    // Non-string input short-circuits before the warn branch — no
    // warning expected, just the default.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeConfidence(undefined)).toBe('LOW');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
