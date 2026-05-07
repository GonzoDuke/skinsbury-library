/**
 * Unit tests for the spine LCC class match rule in Phase 1 candidate
 * scoring. Two layers of coverage:
 *
 *   1. Direct unit tests against the lccClass() helper — class
 *      extraction across raw call-number formats.
 *   2. Direct unit tests against scoreDocBreakdown — the per-rule
 *      contribution of the new lccClass rule under match / mismatch /
 *      missing-data scenarios.
 *   3. Integration test through lookupBook — the end-to-end "right
 *      class wins despite weaker text match" scenario from the
 *      production trace that motivated this change.
 *
 * Layer 1 + 2 use direct calls; layer 3 mocks fetch the same way the
 * book-lookup smoke tests do. The integration test stresses the full
 * stack including pre-filter + threshold + relevance check + ranking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ANTHROPIC + ISBNDB env vars before importing the module (the
// module reads them at lookup time; harmless when nothing actually
// calls Anthropic, but ISBNdb-related tests need the key set so the
// helper doesn't short-circuit).
process.env.VERBOSE_LOOKUP = '0';
process.env.ISBNDB_API_KEY = 'test-key';

const { lccClass, scoreDocBreakdown, lookupBook } = await import('@/lib/book-lookup');

// Loose typing so tests can construct minimal docs without satisfying
// the full OpenLibraryDoc shape. The fields the scorer reads
// (title/author_name/lcc/isbn/publisher/first_publish_year) are all
// optional on the real type anyway.
type LooseDoc = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Layer 1 — lccClass() helper.
// ---------------------------------------------------------------------------
describe('lccClass — class extraction from raw call numbers', () => {
  it('strips cutter and year, keeps letters + class digits', () => {
    expect(lccClass('PS3521.E735 A6 1995')).toBe('PS3521');
  });

  it('handles whitespace between letters and class digits', () => {
    expect(lccClass('PS 3521 .E735 A6 1995')).toBe('PS3521');
  });

  it('handles two-letter class', () => {
    expect(lccClass('HV5825 .T67 2005')).toBe('HV5825');
  });

  it('collapses decimal class to integer portion', () => {
    expect(lccClass('PS3521.5.E735')).toBe('PS3521');
  });

  it('returns empty string for DDC numbers (no leading letters)', () => {
    expect(lccClass('973.7')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(lccClass('')).toBe('');
  });

  it('uppercases lowercase input', () => {
    expect(lccClass('ps3521.e735')).toBe('PS3521');
  });

  it('strips leading zeros from the class digits (OL data normalization)', () => {
    // Production failure mode: OL stored "HM0721" with a zero-pad,
    // spine sticker had "HM721" without — string-equality compare
    // treated them as a mismatch and the lccClass rule silently
    // fired with 0 on a record that actually agreed.
    expect(lccClass('HM0721')).toBe('HM721');
    expect(lccClass('HM721')).toBe('HM721');
    expect(lccClass('PS03521')).toBe('PS3521');
    expect(lccClass('PS00001')).toBe('PS1');
    // Both normalized variants compare equal — the property the
    // scorer's `=== ` check depends on.
    expect(lccClass('HM0721')).toBe(lccClass('HM721'));
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — scoreDocBreakdown() rule contribution.
// ---------------------------------------------------------------------------
describe('scoreDocBreakdown — lccClass rule', () => {
  it('awards +4 when candidate LCC class matches spine LCC class', () => {
    const doc: LooseDoc = {
      lcc: ['PS3521.E735 A6 1995'],
    };
    const breakdown = scoreDocBreakdown(
      doc as never,
      'Some Title',
      'Some Author',
      { extractedLccClass: 'PS3521' }
    );
    expect(breakdown.rules.lccClass).toBe(4);
  });

  it('awards −4 when candidate LCC class disagrees with spine LCC class', () => {
    const doc: LooseDoc = {
      lcc: ['PS3568 .O243'],
    };
    const breakdown = scoreDocBreakdown(
      doc as never,
      'Some Title',
      'Some Author',
      { extractedLccClass: 'PS3521' }
    );
    expect(breakdown.rules.lccClass).toBe(-4);
  });

  it('contributes 0 when no spine LCC hint is provided', () => {
    const doc: LooseDoc = {
      lcc: ['PS3568 .O243'],
    };
    const breakdown = scoreDocBreakdown(doc as never, 'Some Title', 'Some Author');
    expect(breakdown.rules.lccClass).toBe(0);
  });

  it('contributes 0 when candidate has no LCC at all (no penalty for missing data)', () => {
    const doc: LooseDoc = {};
    const breakdown = scoreDocBreakdown(
      doc as never,
      'Some Title',
      'Some Author',
      { extractedLccClass: 'PS3521' }
    );
    expect(breakdown.rules.lccClass).toBe(0);
  });

  it('reads from lc_classifications when lcc field is absent', () => {
    const doc: LooseDoc = {
      lc_classifications: ['PS3521.E735'],
    };
    const breakdown = scoreDocBreakdown(
      doc as never,
      'Some Title',
      'Some Author',
      { extractedLccClass: 'PS3521' }
    );
    expect(breakdown.rules.lccClass).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — lookupBook integration.
//
// The Kerouac production failure mode in miniature:
//   - Spine sticker: "PS 3521 .E735 A6 1995" (Kerouac class)
//   - Candidate A scores higher on text rules (exact title, full
//     author match) but its database LCC is PS3568 (a different
//     author entirely, "Ro–Ry" surname range)
//   - Candidate B scores lower on text rules but its database LCC is
//     PS3521 (matching the sticker)
//
// Without the lccClass rule, A wins. With the rule (+4 for B, −4
// for A), B wins.
// ---------------------------------------------------------------------------

type FetchHandler = (url: string) => unknown;

function installFetchMock(routes: Array<[RegExp | string, FetchHandler]>) {
  const spy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
  spy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, handler] of routes) {
      const matches =
        typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url);
      if (matches) {
        const body = handler(url);
        return new Response(
          typeof body === 'string' ? body : JSON.stringify(body),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ) as Response;
      }
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as Response;
  });
  return spy;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lookupBook integration — spine LCC class match overrides weaker text match', () => {
  it("picks the LCC-class-matching candidate even when another scores higher on title/author alone", async () => {
    // Candidate A — strong text match, wrong-author LCC class.
    // Without lccClass: title:2 + author:3 + lcc:3 + isbn:0 + ... = 8.
    // With lccClass:    8 − 4 = 4 (below MIN_PHASE1_SCORE=6).
    //
    // Candidate B — weak title match (substring not exact), weak
    // author match (last-name only), matching LCC class.
    // Without lccClass: title:0 + author:1 + lcc:3 + ... = 4.
    // With lccClass:    4 + 4 = 8 (above threshold, passes relevance
    // check via author:1).
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              key: '/works/A',
              title: 'Right Title',
              author_name: ['Right Author'],
              lcc: ['PS3568 .O243 1990'],
            },
            {
              key: '/works/B',
              title: 'Right Title Annotated Edition',
              author_name: ['Different Author'],
              lcc: ['PS3521.E735 A6 1995'],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('Right Title', 'Right Author', {
      extractedCallNumber: 'PS 3521 .E735 A6 1995',
      extractedCallNumberSystem: 'lcc',
    });

    // B's LCC starts with PS3521 — A's starts with PS3568. The
    // sticker matches B's class.
    expect(result.lcc).toMatch(/^PS3521/);
    expect(result.canonicalTitle).toBe('Right Title Annotated Edition');
  });

  it('falls back to text-match winner when no spine LCC hint is provided', async () => {
    // Same candidate shape but different title/author so the
    // module-level lookupCache doesn't return the previous test's
    // cached result (the cache keys by title|author and persists
    // across tests within a worker).
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              key: '/works/AA',
              title: 'No Hint Book',
              author_name: ['No Hint Author'],
              lcc: ['PS3568 .O243 1990'],
            },
            {
              key: '/works/BB',
              title: 'No Hint Book Annotated Edition',
              author_name: ['Different Author'],
              lcc: ['PS3521.E735 A6 1995'],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('No Hint Book', 'No Hint Author');

    // No hint → A wins on title:2 + author:3 + lcc:3 = 8.
    expect(result.lcc).toMatch(/^PS3568/);
    expect(result.canonicalTitle).toBe('No Hint Book');
  });
});
