/**
 * Unit tests for sanitizeForSearch — the query-time string normalizer
 * in lib/lookup-utils.ts. Coverage:
 *
 *   - Title with a colon-space subtitle separator splits correctly.
 *   - Title with no separator returns unchanged (modulo wildcard /
 *     punctuation cleanup the function already did).
 *   - Each of the four canonical separators (':', ' — ', ' -- ',
 *     ' – ') triggers a split.
 *   - The earliest-occurring separator wins when multiple appear.
 *   - The author overload (separator in author string) works the same
 *     way — the function is shape-agnostic, just operates on strings.
 *   - Wildcard / exclamation cleanup is preserved.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeForSearch } from '../lookup-utils';

describe('sanitizeForSearch', () => {
  it('strips a colon-space subtitle and keeps only the base title', () => {
    const input = 'Survive!: Essential Skills and Tactics to Get You Out of Anywhere Alive';
    // The leading "!" is also stripped by the wildcard pass; the
    // remaining "Survive: ..." then splits on ": ".
    expect(sanitizeForSearch(input)).toBe('Survive');
  });

  it('returns a no-subtitle title unchanged', () => {
    expect(sanitizeForSearch('The Great Gatsby')).toBe('The Great Gatsby');
  });

  it('splits on em-dash separator', () => {
    expect(sanitizeForSearch('Foundation — A Galactic Empire')).toBe('Foundation');
  });

  it('splits on en-dash separator', () => {
    expect(sanitizeForSearch('Foundation – A Galactic Empire')).toBe('Foundation');
  });

  it('splits on double-hyphen separator', () => {
    expect(sanitizeForSearch('Foundation -- A Galactic Empire')).toBe('Foundation');
  });

  it('splits on colon separator', () => {
    expect(sanitizeForSearch('Foundation: A Galactic Empire')).toBe('Foundation');
  });

  it('uses the earliest separator when multiple appear', () => {
    // Colon comes before em-dash → split at colon.
    expect(sanitizeForSearch('Title: Sub1 — Sub2')).toBe('Title');
    // Em-dash comes before colon → split at em-dash.
    expect(sanitizeForSearch('Title — Sub1: Sub2')).toBe('Title');
  });

  it('handles ratios and tight punctuation without separator-spaces unchanged', () => {
    // "1:1" has no space after the colon, so the ': ' separator
    // doesn't match and the title is preserved.
    expect(sanitizeForSearch('Mixing 1:1 Ratios')).toBe('Mixing 1:1 Ratios');
  });

  it('strips author subtitles the same way', () => {
    expect(sanitizeForSearch('Bell Hooks: Pseudonym for Gloria Watkins')).toBe('Bell Hooks');
  });

  it('preserves wildcard / mention / exclamation cleanup', () => {
    expect(sanitizeForSearch('Holy Sh*t')).toBe('Holy Sht');
    expect(sanitizeForSearch('@author #tag')).toBe('author tag');
  });

  it('returns empty string for empty / whitespace-only input', () => {
    expect(sanitizeForSearch('')).toBe('');
    expect(sanitizeForSearch('   ')).toBe('');
  });
});
