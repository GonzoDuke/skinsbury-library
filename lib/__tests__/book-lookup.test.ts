/**
 * Smoke tests for the lookup pipeline (lib/book-lookup.ts).
 *
 * Coverage in v1 is deliberately narrow — four happy paths that lock
 * in behavior the most recent commits depend on (editor-prefix strip,
 * Phase 1 bail-out, gap-fill provenance, partial-LCC fallback). Future
 * regressions on those paths will fail loudly here.
 *
 * Mock strategy:
 *   - `@/lib/lookup-utils` is partially mocked: `lookupFullMarcByIsbn`,
 *     `lookupLccByIsbn`, `lookupLccByTitleAuthor` become vi.fn()s the
 *     tests configure per-scenario. Pure helpers (normalizeLcc,
 *     isCompleteLcc, sanitizeForSearch, stripEditorPrefix, etc.) come
 *     through unchanged via vi.importActual.
 *   - `global.fetch` is spied per-test with a URL-pattern → response
 *     route table. Cleaner module-boundary mocks for
 *     fetchOpenLibraryCandidates / fetchIsbndbCandidates aren't
 *     reachable in v1 because those helpers live inside book-lookup.ts
 *     and ESM internal references don't resolve through replaced
 *     exports. The Step 3 entry-point unification will extract them
 *     into a separate module; at that point these tests can move to
 *     module-level mocks.
 *
 * Note: tests run with VERBOSE_LOOKUP=0 to keep stdout quiet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import olSearchEssentialGinsberg from '../__fixtures__/lookup/ol-search-essential-ginsberg.json';
import isbndbSearchEssentialGinsberg from '../__fixtures__/lookup/isbndb-search-essential-ginsberg.json';

// Silence verbose tier logging for test runs.
process.env.VERBOSE_LOOKUP = '0';

// Partial mock of lookup-utils — replace network helpers, keep pure
// helpers via vi.importActual.
vi.mock('@/lib/lookup-utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/lookup-utils')>(
    '@/lib/lookup-utils'
  );
  return {
    ...actual,
    lookupFullMarcByIsbn: vi.fn().mockResolvedValue(null),
    lookupLccByIsbn: vi.fn().mockResolvedValue(''),
    lookupLccByTitleAuthor: vi.fn().mockResolvedValue(''),
  };
});

// Imports must come AFTER vi.mock() so the mocked module is in place
// when book-lookup.ts evaluates its import bindings.
const { lookupBook, lookupSpecificEdition } = await import('@/lib/book-lookup');
const lookupUtils = await import('@/lib/lookup-utils');

// Cast the mocked exports back to vi.Mock for set-up convenience.
const mockedMarc = lookupUtils.lookupFullMarcByIsbn as ReturnType<typeof vi.fn>;
const mockedLccByIsbn = lookupUtils.lookupLccByIsbn as ReturnType<typeof vi.fn>;
const mockedLccByTitleAuthor =
  lookupUtils.lookupLccByTitleAuthor as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// fetch mock helper. Each test installs a route table mapping URL
// substrings to fixture-style responses. Unmatched URLs return an
// empty 200 so secondary calls (cover URLs, work-record fetches, etc.)
// don't blow up the lookup pipeline.
// ---------------------------------------------------------------------------

type FetchHandler = (url: string) => unknown;

function installFetchMock(routes: Array<[RegExp | string, FetchHandler]>) {
  // Cast through `unknown` because vi.spyOn's overload set narrows
  // strangely on `globalThis.fetch` under DOM lib types — the spy still
  // wires up correctly at runtime; only the TypeScript signature of
  // `mockImplementation` needs the loosening.
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
    // Default: empty 200 — keeps cover-art and supplementary calls quiet.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as Response;
  });
  return spy;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default mock returns each test resets explicitly anyway.
  mockedMarc.mockResolvedValue(null);
  mockedLccByIsbn.mockResolvedValue('');
  mockedLccByTitleAuthor.mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test 1 — Editor-attributed lookup queries by title alone and finds
//          the canonical edition. Locks in today's editor-prefix fix +
//          editor-attributed empty-author behavior.
// ---------------------------------------------------------------------------
describe('lookupBook — editor-attributed', () => {
  it('queries by title alone and finds canonical edition', async () => {
    installFetchMock([
      // OL title-search: returns the Penguin edition only when the
      // query is title-only. If &author= leaked in, return empty —
      // that's the regression guard for the editor-attributed-empty-
      // author behavior.
      [
        /openlibrary\.org\/search\.json/,
        (url) =>
          /[?&]author=/.test(url) ? { docs: [] } : olSearchEssentialGinsberg,
      ],
      // ISBNdb title search — return the Penguin record (matches OL's pick).
      [
        /api2\.isbndb\.com\/books\//,
        () => isbndbSearchEssentialGinsberg,
      ],
    ]);

    const result = await lookupBook(
      'The Essential Ginsberg',
      'ed. Michael Schumacher'
    );

    expect(result.source).toBe('openlibrary');
    expect(result.isbn).toBe('9780141398990');
    expect(result.publicationYear).toBe(2015);
    expect(result.lcc).toMatch(/^PS3513/);

    // BookLookupResult provenance covers canonicalTitle / isbn / lcc /
    // etc. but NOT title or author — those land on BookRecord at the
    // pipeline-layer assembly (buildBookProvenance), out of scope for
    // this lookup-pipeline test.
    const prov = (result as unknown as {
      __provenance?: Record<string, { source: string }>;
    }).__provenance;
    expect(prov?.canonicalTitle?.source).toBeTruthy();
    expect(prov?.lcc?.source).toBeTruthy();
    expect(prov?.isbn?.source).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Phase 1 returns no winner when both sources return empty.
//          Locks in the bail-out behavior + gap-fill skip.
// ---------------------------------------------------------------------------
describe('lookupBook — no Phase-1 winner', () => {
  it('returns source="none" when OL and ISBNdb both find nothing', async () => {
    installFetchMock([
      [/openlibrary\.org\/search\.json/, () => ({ docs: [] })],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('Some Made Up Title', 'Nobody');

    expect(result.source).toBe('none');
    expect(result.isbn).toBe('');
    expect(result.lcc).toBe('');
    // gap-fill bails out cleanly when source === 'none'; MARC mock
    // should NOT have been invoked at all in that path.
    expect(mockedMarc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Gap-fill fills empty fields from MARC. Locks in field-by-
//          field provenance attribution to "marc".
// ---------------------------------------------------------------------------
describe('lookupBook — gap-fill from MARC', () => {
  it('fills lcshSubjects + ddc from MARC and stamps provenance', async () => {
    // Phase 1: OL returns a winner with empty lcsh/ddc.
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              key: '/works/OLAGNW',
              title: 'Agnotology',
              author_name: ['Robert N. Proctor'],
              isbn: ['9780804759014'],
              publisher: ['Stanford University Press'],
              first_publish_year: 2008,
              publish_year: [2008],
              lcc: ['BD221 .A36 2008'],
              subject: ['Knowledge, Theory of'],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    // MARC returns a complete record on gap-fill's MARC call.
    mockedMarc.mockResolvedValue({
      lcc: 'BD221 .A36 2008',
      ddc: '001.4',
      lcshSubjects: [
        'Knowledge, Theory of',
        'Ignorance (Theory of knowledge)',
        'Agnoiology',
        'Truthfulness and falsehood',
        'Science — Social aspects',
        'Information theory',
        'Epistemics',
      ],
      marcGenres: [],
      author: 'Proctor, Robert N.',
      title: 'Agnotology',
      publisher: 'Stanford University Press',
      pageCount: 312,
      edition: null,
      coAuthors: [],
    });

    const result = await lookupBook('Agnotology', 'Robert N. Proctor');

    expect(result.source).toBe('openlibrary');
    expect(result.lcshSubjects?.length).toBe(7);
    expect(result.ddc).toBe('001.4');

    const prov = (result as unknown as {
      __provenance?: Record<string, { source: string }>;
    }).__provenance;
    expect(prov?.lcshSubjects?.source).toBe('marc');
    expect(prov?.ddc?.source).toBe('marc');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — LCC fallback fires when Phase 1 returns partial LCC. Locks
//          in the post-Phase-2 LoC SRU title+author upgrade.
// ---------------------------------------------------------------------------
describe('lookupBook — partial LCC upgrade', () => {
  it('upgrades partial Phase-1 LCC to complete LoC SRU LCC and demotes loser to alternates', async () => {
    // Phase 1 OL: winner with partial LCC ("HV5825" — no cutter).
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              key: '/works/OLPARTIALW',
              title: "Can't Find My Way Home",
              author_name: ['Martin Torgoff'],
              isbn: ['9780743230117'],
              publisher: ['Simon & Schuster'],
              first_publish_year: 2005,
              publish_year: [2005],
              lcc: ['HV5825'],
              subject: ['Drug abuse — United States'],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    // LoC SRU title+author returns the complete LCC.
    mockedLccByTitleAuthor.mockResolvedValue('HV5825 .T67 2005');

    const result = await lookupBook("Can't Find My Way Home", 'Martin Torgoff');

    expect(result.lcc).toBe('HV5825 .T67 2005');

    const prov = (result as unknown as {
      __provenance?: {
        lcc?: { source: string; alternates?: Array<{ source: string; value: unknown }> };
      };
    }).__provenance;
    // Source upgraded to LoC SRU.
    expect(prov?.lcc?.source).toBe('loc-sru');
    // Original partial captured in alternates with its prior tier as source.
    expect(prov?.lcc?.alternates?.length).toBeGreaterThan(0);
    const altValues = prov?.lcc?.alternates?.map((a) => a.value) ?? [];
    expect(altValues).toContain('HV5825');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Edition-level OL endpoint preferred over work-level for
//          ISBN-direct lookup. Locks in the Cymbeline regression: the
//          work-level search.json?isbn= returns the WORK's union-of-
//          editions publisher list, where Signet Classics happens to
//          be first; the edition-level /api/books?bibkeys=ISBN: returns
//          the publisher of THAT specific ISBN's edition.
// ---------------------------------------------------------------------------
describe('lookupSpecificEdition — edition-level OL endpoint', () => {
  it('prefers edition endpoint over search.json for ISBN-direct lookup', async () => {
    // Track only the *tier-1 fallback* call to search.json. The
    // Phase-2 fan-out also hits search.json?isbn= as part of its
    // OL-by-ISBN gap-filler, but with a much narrower `&fields=` list.
    // The tier-1 fallback URL includes `publisher` in its fields; the
    // fan-out URL does not. Match on the discriminator.
    let tier1SearchJsonCalled = false;
    installFetchMock([
      // Edition endpoint — the Folger publisher.
      [
        /openlibrary\.org\/api\/books\?bibkeys=ISBN:9781982156916/,
        () => ({
          'ISBN:9781982156916': {
            title: 'Cymbeline',
            authors: [{ name: 'William Shakespeare' }],
            publishers: [{ name: 'Simon & Schuster' }],
            publish_date: '2020',
            number_of_pages: 384,
            classifications: { lc_classifications: ['PR2807 .S5 2020'] },
            subjects: [{ name: 'Drama, Renaissance' }],
          },
        }),
      ],
      // Tier-1 search.json fallback — what would be returned if the
      // edition endpoint were skipped. Distinguished from the fan-out
      // and gap-fill OL helpers by `author_name` appearing in the
      // `&fields=` list (only tier-1's URL includes it).
      [
        /openlibrary\.org\/search\.json\?isbn=.+author_name/,
        () => {
          tier1SearchJsonCalled = true;
          return {
            docs: [
              {
                key: '/works/OLSIGNET',
                title: 'Cymbeline',
                author_name: ['William Shakespeare'],
                isbn: ['9781982156916'],
                publisher: ['Signet Classics'],
                first_publish_year: 1998,
                publish_year: [1998],
                lcc: ['PR2807'],
              },
            ],
          };
        },
      ],
      // Phase-2 fan-out's OL gap-filler — narrower fields, returns
      // empty so it doesn't poison anything.
      [/openlibrary\.org\/search\.json\?isbn=/, () => ({ docs: [] })],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupSpecificEdition(
      'Cymbeline',
      'William Shakespeare',
      { isbn: '9781982156916' }
    );

    // Most important assertion — the actual bug.
    expect(result.publisher).toBe('Simon & Schuster');
    expect(result.publisher).not.toBe('Signet Classics');
    expect(result.isbn).toBe('9781982156916');
    expect(result.publicationYear).toBe(2020);
    expect(result.pageCount).toBe(384);
    expect(result.lcc).toMatch(/^PR2807/);
    // The work-level fallback was never consulted.
    expect(tier1SearchJsonCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Falls back to search.json when the edition endpoint
//          returns no doc for the ISBN. Locks in the fallback path so
//          ISBNs that exist in OL's work-level index but not its
//          edition-level data still resolve.
// ---------------------------------------------------------------------------
describe('lookupSpecificEdition — work-level fallback', () => {
  it('falls back to search.json when edition endpoint has no doc', async () => {
    let editionEndpointCalled = false;
    let searchJsonCalled = false;
    installFetchMock([
      // Edition endpoint — empty body (no `ISBN:...` key in the
      // response object). Helper returns null and tier 1 falls through.
      [
        /openlibrary\.org\/api\/books\?bibkeys=ISBN:/,
        () => {
          editionEndpointCalled = true;
          return {};
        },
      ],
      // search.json fallback — returns a real doc.
      [
        /openlibrary\.org\/search\.json/,
        () => {
          searchJsonCalled = true;
          return {
            docs: [
              {
                key: '/works/OLFALLBACK',
                title: 'Fallback Test Book',
                author_name: ['Fallback Author'],
                isbn: ['9780000000001'],
                publisher: ['Fallback Press'],
                first_publish_year: 2010,
                publish_year: [2010],
                lcc: ['PZ7'],
                number_of_pages_median: 200,
              },
            ],
          };
        },
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupSpecificEdition(
      'Fallback Test Book',
      'Fallback Author',
      { isbn: '9780000000001' }
    );

    expect(editionEndpointCalled).toBe(true);
    expect(searchJsonCalled).toBe(true);
    // Result built from search.json's doc.
    expect(result.publisher).toBe('Fallback Press');
    expect(result.publicationYear).toBe(2010);
    expect(result.pageCount).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Below-threshold winner returns no match. Locks in the
//          Phase 1 score floor: when the best candidate scores below
//          MIN_PHASE1_SCORE (6), we treat Phase 1 as a miss and let
//          the no-Phase-1-winner fallbacks take over rather than save
//          a low-scoring wrong-edition pick.
//
// Crafted scoring: candidates have an exact title match (+2) but
// almost nothing else — no LCC, no ISBN, no publisher hit, mismatched
// authors. Total scores 2–4, all below the 6 floor. lookupBook should
// return source='none' (no candidate adopted).
// ---------------------------------------------------------------------------
describe('lookupBook — Phase 1 below-threshold bail-out', () => {
  it('returns source="none" when the best candidate scores below MIN_PHASE1_SCORE', async () => {
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              // Exact title match (+2) — that's it. No isbn, no lcc,
              // no publisher, no year, mismatched author.
              key: '/works/OLLOW1',
              title: 'Weak Match Title',
              author_name: ['Some Other Author'],
              subject: [],
            },
            {
              key: '/works/OLLOW2',
              title: 'Weak Match Title',
              author_name: ['Yet Another Author'],
              subject: [],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('Weak Match Title', 'Some Author');

    // Below threshold → no Phase-1 winner.
    expect(result.source).toBe('none');
    expect(result.isbn).toBe('');
    expect(result.lcc).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Test 8 — Above-threshold winner returns normally. Locks in the
//          guarantee that the threshold doesn't break high-quality
//          matches: a fully-described candidate (isbn + lcc +
//          publisher + year + exact title + full author match) easily
//          clears the 6 floor and is returned as before.
// ---------------------------------------------------------------------------
describe('lookupBook — Phase 1 above-threshold winner', () => {
  it('returns the winner when its score is at or above MIN_PHASE1_SCORE', async () => {
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              // Strong match: isbn(+2) + lcc(+3) + publisher(+1) +
              // year(+1) + title exact(+2) + author full(+3) = 12.
              key: '/works/OLSTRONG',
              title: 'Strong Match Title',
              author_name: ['Strong Author'],
              isbn: ['9780000000002'],
              publisher: ['Strong Press'],
              first_publish_year: 2015,
              publish_year: [2015],
              lcc: ['PZ7 .S767 2015'],
              subject: ['Test fiction'],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('Strong Match Title', 'Strong Author');

    expect(result.source).toBe('openlibrary');
    expect(result.isbn).toBe('9780000000002');
    expect(result.publisher).toBe('Strong Press');
    expect(result.publicationYear).toBe(2015);
    expect(result.lcc).toMatch(/^PZ7/);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — Phase 1 winner with score above threshold but title:0 and
//          author:0 returns no match. Locks in the relevance
//          requirement: even score=7+ candidates must show at least
//          one of (title-token match, author-token match) to be
//          adopted as a winner. Otherwise the score is entirely from
//          metadata-presence rules and the candidate isn't actually
//          related to the query.
//
// Production failure mode this guards against: a manual entry like
// "The Portable" with empty author hits dozens of well-cataloged
// "The Portable X" books, all scoring 7 from isbn+lcc+publisher+year
// alone, none of them actually matching what was searched.
// ---------------------------------------------------------------------------
describe('lookupBook — Phase 1 relevance requirement', () => {
  it('returns source="none" when winner has score >= threshold but title:0 and author:0', async () => {
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              key: '/works/OLNORELEVANCE',
              // Title doesn't match the query at all (no substring,
              // no exact). Author doesn't share any tokens with the
              // query author. Score will be 7 from metadata only.
              title: 'Random Unrelated Book',
              author_name: ['Different Person'],
              isbn: ['9780000000003'],
              publisher: ['Some Press'],
              first_publish_year: 2010,
              publish_year: [2010],
              lcc: ['PZ7 .R36 2010'],
              subject: [],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('Whozit Whatsit Query', 'Joe Schmoe');

    // Relevance bail-out → no Phase-1 winner.
    expect(result.source).toBe('none');
    expect(result.isbn).toBe('');
  });

  it('returns the winner when score is above threshold and author>0 (even with title:0)', async () => {
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              key: '/works/OLAUTHORONLY',
              // Title doesn't substring-match the query but author
              // does. Score: isbn:2 + lcc:3 + publisher:1 + year:1 +
              // title:0 + author:3 = 10. Relevance present via author.
              title: 'A Different Book Name',
              author_name: ['John Smith'],
              isbn: ['9780000000004'],
              publisher: ['Author Press'],
              first_publish_year: 2017,
              publish_year: [2017],
              lcc: ['PZ7 .S56 2017'],
              subject: [],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('Some Lookup Query Title', 'John Smith');

    expect(result.source).toBe('openlibrary');
    expect(result.isbn).toBe('9780000000004');
    expect(result.publisher).toBe('Author Press');
  });

  it('returns the winner when score is above threshold and title>0 (even with author:0)', async () => {
    installFetchMock([
      [
        /openlibrary\.org\/search\.json/,
        () => ({
          docs: [
            {
              key: '/works/OLTITLEONLY',
              // Title exact-matches the query but author doesn't.
              // Score: isbn:2 + lcc:3 + publisher:1 + year:1 +
              // title:2 + author:0 = 9. Relevance present via title.
              title: 'Exact Match Title',
              author_name: ['Some Different Person'],
              isbn: ['9780000000005'],
              publisher: ['Title Press'],
              first_publish_year: 2019,
              publish_year: [2019],
              lcc: ['PZ7 .T58 2019'],
              subject: [],
            },
          ],
        }),
      ],
      [/api2\.isbndb\.com\/books\//, () => ({ books: [] })],
    ]);

    const result = await lookupBook('Exact Match Title', 'Mismatched Author');

    expect(result.source).toBe('openlibrary');
    expect(result.isbn).toBe('9780000000005');
    expect(result.publisher).toBe('Title Press');
  });
});
