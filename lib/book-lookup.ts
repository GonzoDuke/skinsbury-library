import type { BookLookupResult } from './types';
import {
  normalizeLcc,
  lookupLccByIsbn,
  lookupLccByTitleAuthor,
  lookupFullMarcByIsbn,
  sanitizeForSearch,
  type MarcResult,
} from './lookup-utils';

// Re-export the env-free helpers so existing callers of this module
// keep their imports unchanged. The actual implementations now live in
// lookup-utils so scan-pipeline (client-bundled) can import them
// without dragging this module's `process.env.*` references along.
export { normalizeLcc, lookupLccByIsbn, lookupLccByTitleAuthor };

const UA = 'Carnegie/1.0 (personal cataloging tool)';
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// One-shot warning so the dev console doesn't get spammed when the env
// var is unset across hundreds of book lookups.
let isbndbKeyMissingWarned = false;

// ---------------------------------------------------------------------------
// Verbose per-book lookup logging. Default on; set VERBOSE_LOOKUP=0 to mute.
// Each lookupBook / lookupSpecificEdition call gets a stable label so the
// per-tier lines for one book stay grouped in the dev terminal:
//
//   [lookup "Hobbit"] start title="The Hobbit" author="Tolkien"
//   [lookup "Hobbit"]   ol-t1            GET https://openlibrary.org/search.json?title=…&author=… → 200 → 1 hit → isbn,publisher,year,lcc filled
//   [lookup "Hobbit"]   gb               skipped — OL filled
//   [lookup "Hobbit"]   loc-by-isbn      skipped — LCC already set (ol)
//   [lookup "Hobbit"]   isbndb-direct    GET https://api2.isbndb.com/book/9780395071229 → 200 → matched
//   [lookup "Hobbit"]   wikidata         skipped — LCC already set (ol)
//   [lookup "Hobbit"] result source=openlibrary tier=ol-t1 isbn=9780395071229 year=1937 lcc="PZ7 .T5744 Ho 1984" filled=[isbn,publisher,year,lcc]
// ---------------------------------------------------------------------------
const LOOKUP_VERBOSE = process.env.VERBOSE_LOOKUP !== '0';

interface LookupLogger {
  label: string;
  start(input: { title: string; author: string; isbn?: string }): void;
  tier(stage: string, msg: string): void;
  finish(result: BookLookupResult & { tier?: string }): void;
}

function shortLabel(s: string, max = 32): string {
  const t = (s || '').trim();
  if (!t) return '?';
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

function createLookupLogger(label: string): LookupLogger {
  const prefix = `[lookup "${shortLabel(label)}"]`;
  const emit = (line: string) => {
    if (!LOOKUP_VERBOSE) return;
    console.log(`${prefix} ${line}`);
  };
  return {
    label,
    start(input) {
      emit(
        `start title=${JSON.stringify(input.title)} author=${JSON.stringify(input.author)}` +
          (input.isbn ? ` isbn=${input.isbn}` : '')
      );
    },
    tier(stage, msg) {
      emit(`  ${stage.padEnd(16)} ${msg}`);
    },
    finish(result) {
      const filled: string[] = [];
      const empty: string[] = [];
      if (result.isbn) filled.push('isbn'); else empty.push('isbn');
      if (result.publisher) filled.push('publisher'); else empty.push('publisher');
      if (result.publicationYear) filled.push('year'); else empty.push('year');
      if (result.lcc) filled.push('lcc'); else empty.push('lcc');
      emit(
        `result source=${result.source} tier=${result.tier ?? ''}` +
          (result.isbn ? ` isbn=${result.isbn}` : '') +
          (result.publicationYear ? ` year=${result.publicationYear}` : '') +
          (result.lcc ? ` lcc=${JSON.stringify(result.lcc)}` : '') +
          ` filled=[${filled.join(',')}] empty=[${empty.join(',')}]`
      );
    },
  };
}

/**
 * Pull the first non-empty field name from a BookLookupResult so the
 * per-tier log line can summarize what filled in one short string.
 */
function describeFilled(r: BookLookupResult | null | undefined): string {
  if (!r) return '(no hit)';
  const fields: string[] = [];
  if (r.isbn) fields.push('isbn');
  if (r.publisher) fields.push('publisher');
  if (r.publicationYear) fields.push('year');
  if (r.lcc) fields.push('lcc');
  return fields.length > 0 ? `filled=[${fields.join(',')}]` : '(no fields)';
}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  isbn?: string[];
  publisher?: string[];
  first_publish_year?: number;
  publish_year?: number[];
  publish_date?: string[];
  lcc?: string[];
  lc_classifications?: string[];
  subject?: string[];
  number_of_pages_median?: number;
}

interface OpenLibraryWork {
  lc_classifications?: string[];
  lcc?: string[];
  subjects?: string[];
}

const STUDY_GUIDE_PATTERNS = [
  'study guide',
  'cliffsnotes',
  "cliff's notes",
  'cliffs notes',
  'sparknotes',
  "barron's",
  'barrons',
  'maxnotes',
  'companion',
  "reader's guide",
  'readers guide',
  'critical essays',
  'criticism and interpretation',
  'for dummies',
  'made simple',
  'quick study',
  'masterplots',
  'bookrags',
  'literature guide',
  'coles notes',
];

function isStudyGuide(d: OpenLibraryDoc): boolean {
  const t = (d.title ?? '').toLowerCase();
  if (!t) return false;
  return STUDY_GUIDE_PATTERNS.some((p) => t.includes(p));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Strip editor / translator / introducer markers from an author string
 * before sending it to a metadata API. The display author keeps the prefix
 * (so the reviewer sees "ed. Barney Hoskyns"); only the lookup query is
 * cleaned ("Barney Hoskyns").
 */
export function cleanAuthorForQuery(author: string): string {
  if (!author) return '';
  let a = author.trim();
  // Repeatedly strip leading editor/translator markers + ampersand junk.
  for (let i = 0; i < 5; i++) {
    const before = a;
    a = a
      .replace(/^(?:edited\s+by|translated\s+by|trans(?:lated)?\.|intro(?:duction)?\s+by|foreword\s+by|preface\s+by|edited|eds?\.)\s+/i, '')
      .replace(/^(?:and|&|,)\s+/i, '')
      .trim();
    if (a === before) break;
  }
  return a;
}

/**
 * Return everything before the first " : " or ": " in the title — i.e., drop
 * the subtitle. "Foolproof: Why Misinformation Infects…" → "Foolproof".
 * Leaves the original alone if there's no colon at a word boundary
 * (avoids stripping ratios like "1:1" or "Part 2: A New Hope" where the
 * colon is meaningful).
 */
export function stripSubtitle(title: string): string {
  if (!title) return '';
  const m = title.match(/^([^:]+?)\s*:\s+\S/);
  return m ? m[1].trim() : title.trim();
}

function titleExactMatch(query: string, candidate?: string): boolean {
  if (!candidate) return false;
  return normalize(query) === normalize(candidate);
}

/**
 * Bidirectional substring match. The candidate matches the query if either
 * is contained in the other (with word-boundary alignment). Lets short
 * canonical titles ("Foolproof") match long subtitle queries
 * ("Foolproof: Why Misinformation…") and vice versa.
 */
function titleSubstringMatch(query: string, candidate?: string): boolean {
  if (!candidate) return false;
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return false;
  if (q === c) return true;
  // q ⊂ c
  if (c.startsWith(q + ' ') || c.endsWith(' ' + q) || c.includes(' ' + q + ' ')) return true;
  // c ⊂ q
  if (q.startsWith(c + ' ') || q.endsWith(' ' + c) || q.includes(' ' + c + ' ')) return true;
  return false;
}

const AUTHOR_TOKEN_STOPWORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'sr', 'jr', 'phd', 'md',
  'ed', 'eds', 'trans', 'translated', 'edited', 'intro', 'introduction',
  'foreword', 'preface', 'and', 'with', 'by',
]);

function authorTokens(s: string): string[] {
  // Tokenize, lowercase, drop honorifics/role-markers and single-letter
  // initials (which spineread may or may not include).
  return normalize(s)
    .split(' ')
    .filter((t) => t.length >= 2)
    .filter((t) => !AUTHOR_TOKEN_STOPWORDS.has(t));
}

/**
 * Every non-stopword, multi-letter token of the queried author must appear
 * somewhere in at least one of the candidate's author_name strings.
 * "Sander van der Linden" requires {sander, van, der, linden} all present
 * — prevents matching some other Linden's book.
 */
function authorMatches(query: string, candidates?: string[]): boolean {
  if (!query || !candidates || candidates.length === 0) return false;
  const qTokens = authorTokens(query);
  if (qTokens.length === 0) return false;
  const candidateBlob = candidates.map((c) => normalize(c)).join(' ');
  return qTokens.every((t) => new RegExp(`(?:^|\\s)${t}(?:\\s|$)`).test(candidateBlob));
}

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/** Kept for the score function — coarse signal alongside authorMatches. */
function authorLastNameMatch(query: string, candidates?: string[]): boolean {
  if (!query || !candidates || candidates.length === 0) return false;
  const ql = normalize(lastName(query));
  if (!ql) return false;
  return candidates.some((c) => normalize(lastName(c)) === ql);
}

function pickIsbn(arr?: string[]): string {
  if (!arr || arr.length === 0) return '';
  // Prefer ISBN-13 that is NOT 979-8 (KDP/self-published). Then any ISBN-13. Then ISBN-10.
  const cleaned = arr.map((i) => i.replace(/[^\dxX]/g, ''));
  const isbn13Real = cleaned.find((i) => i.length === 13 && !i.startsWith('9798'));
  if (isbn13Real) return isbn13Real;
  const isbn13Any = cleaned.find((i) => i.length === 13);
  if (isbn13Any) return isbn13Any;
  const isbn10 = cleaned.find((i) => i.length === 10);
  if (isbn10) return isbn10;
  return cleaned[0] ?? '';
}

function scoreDoc(d: OpenLibraryDoc, title: string, author: string): number {
  let s = 0;
  if (d.isbn && d.isbn.length > 0) s += 2;
  if ((d.lcc && d.lcc.length > 0) || (d.lc_classifications && d.lc_classifications.length > 0)) s += 3;
  if (d.publisher && d.publisher.length > 0) s += 1;
  if (d.first_publish_year) s += 1;
  if (titleExactMatch(title, d.title)) s += 2;
  // Full-token author match is the strong signal; last-name match is a
  // coarser fallback worth a smaller bump.
  if (authorMatches(author, d.author_name)) s += 3;
  else if (authorLastNameMatch(author, d.author_name)) s += 1;
  // KDP/self-published penalty
  if (d.isbn && d.isbn.some((i) => i.replace(/[^\d]/g, '').startsWith('9798'))) s -= 3;
  return s;
}

function pickBestDoc(
  docs: OpenLibraryDoc[],
  title: string,
  author: string
): OpenLibraryDoc | undefined {
  if (docs.length === 0) return undefined;

  // Filter out study guides / companion texts BEFORE ranking.
  const candidates = docs.filter((d) => !isStudyGuide(d));
  if (candidates.length === 0) return undefined;

  // Restrict to docs whose title or author plausibly matches — protects
  // against off-target relevance hits.
  const relevant = candidates.filter(
    (d) =>
      titleSubstringMatch(title, d.title) ||
      (author && authorMatches(author, d.author_name))
  );
  const pool = relevant.length > 0 ? relevant : candidates;

  let best: OpenLibraryDoc | undefined;
  let bestScore = -Infinity;
  for (const d of pool) {
    const s = scoreDoc(d, title, author);
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  return best;
}

interface OpenLibraryWorkFull {
  lc_classifications?: string[];
  lcc?: string[];
  subjects?: string[];
  first_publish_date?: string;
  description?: string | { value?: string };
}

async function fetchWork(workKey: string): Promise<OpenLibraryWorkFull | null> {
  if (!workKey || !workKey.startsWith('/works/')) return null;
  try {
    const url = `https://openlibrary.org${workKey}.json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store', headers: DEFAULT_HEADERS });
    if (!res.ok) return null;
    return (await res.json()) as OpenLibraryWorkFull;
  } catch {
    return null;
  }
}

async function fetchWorkLcc(workKey: string): Promise<string> {
  const work = await fetchWork(workKey);
  if (!work) return '';
  const fromLcc = work.lcc && work.lcc[0];
  const fromLc = work.lc_classifications && work.lc_classifications[0];
  return fromLcc ?? fromLc ?? '';
}

/**
 * Same /works fetch as fetchWorkLcc but returns the full record so
 * tryOpenLibrary can also extract the work-level description as a
 * synopsis fallback. Old fetchWorkLcc kept untouched for back-compat.
 */
async function fetchWorkRecord(workKey: string): Promise<OpenLibraryWorkFull | null> {
  return fetchWork(workKey);
}

interface GbIsbnEnrichment {
  publisher: string;
  publicationYear: number;
  coverUrl: string;
  subjects: string[];
}

/**
 * Google Books direct ISBN lookup, used as a Phase-B gap-filler when an
 * earlier tier produced an ISBN but didn't fill publisher / year /
 * cover / subjects. We hit the unauth'd endpoint by default since the
 * keyed quota is small and ISBN-direct queries are cheap there.
 */
async function gbEnrichByIsbn(isbn: string): Promise<GbIsbnEnrichment | null> {
  if (!isbn) return null;
  try {
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
    const base = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`;
    const url = apiKey ? `${base}&key=${apiKey}` : base;
    let res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok && apiKey) {
      res = await fetch(base, {
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
        headers: DEFAULT_HEADERS,
      });
    }
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{
        volumeInfo: {
          publisher?: string;
          publishedDate?: string;
          categories?: string[];
          imageLinks?: { thumbnail?: string; smallThumbnail?: string };
        };
      }>;
    };
    const vi = data.items?.[0]?.volumeInfo;
    if (!vi) return null;
    const cover = (vi.imageLinks?.thumbnail || vi.imageLinks?.smallThumbnail || '').replace(
      /^http:\/\//i,
      'https://'
    );
    return {
      publisher: vi.publisher ?? '',
      publicationYear: vi.publishedDate ? parseInt(vi.publishedDate.slice(0, 4), 10) || 0 : 0,
      coverUrl: cover,
      subjects: vi.categories ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Given an ISBN (typically from Google Books), use Open Library's search.json
 * API to find the work-level metadata. Returns:
 * - first_publish_year (the work's original year, e.g. 1942 for The Stranger)
 * - lcc
 *
 * Uses search.json instead of /isbn/{isbn}.json because the latter requires
 * following a redirect to /books/{key}.json and then a second fetch to
 * /works/{key}.json, which is slow and prone to failure.
 */
async function enrichFromIsbn(
  isbn: string
): Promise<{ firstPublishYear: number; lcc: string }> {
  const empty = { firstPublishYear: 0, lcc: '' };
  if (!isbn) return empty;
  try {
    const url =
      `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}` +
      `&fields=key,first_publish_year,lcc,lc_classifications`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) return empty;
    const data = (await res.json()) as {
      docs?: Array<{
        key?: string;
        first_publish_year?: number;
        lcc?: string[];
        lc_classifications?: string[];
      }>;
    };
    const doc = data.docs?.[0];
    if (!doc) return empty;
    let lcc =
      (doc.lcc && doc.lcc[0]) ||
      (doc.lc_classifications && doc.lc_classifications[0]) ||
      '';
    const firstPublishYear = doc.first_publish_year ?? 0;
    // If the search-level LCC is empty but we have a work key, fetch the work record.
    if (!lcc && doc.key) {
      const work = await fetchWork(doc.key);
      if (work) {
        lcc =
          (work.lcc && work.lcc[0]) ||
          (work.lc_classifications && work.lc_classifications[0]) ||
          '';
      }
    }
    return { firstPublishYear, lcc };
  } catch {
    return empty;
  }
}

function parsePublishDateYear(arr?: string[]): number {
  if (!arr || arr.length === 0) return 0;
  // Find the smallest 4-digit year across all publish_date strings (closest to first publication).
  let earliest = 0;
  for (const s of arr) {
    const m = s.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
    if (m) {
      const y = parseInt(m[1], 10);
      if (!earliest || y < earliest) earliest = y;
    }
  }
  return earliest;
}

/**
 * Edition-specific lookup. Used by the "Match a specific edition" Reread
 * mode when the user has corrected year / publisher / ISBN to a specific
 * printing they own. We trust those hints and scope the lookup tightly:
 *
 * 1. ISBN (when provided) is conclusive — query Open Library by ISBN.
 * 2. Otherwise scope by year (`publish_year={year}`) and prefer docs
 *    whose publisher matches the hint.
 * 3. Fall back to the unscoped `lookupBook` if the scoped search misses.
 */
export async function lookupSpecificEdition(
  title: string,
  author: string,
  hints: { year?: number; publisher?: string; isbn?: string }
): Promise<BookLookupResult> {
  const log = createLookupLogger(`edition:${title}`);
  log.start({ title, author, isbn: hints.isbn });
  // 1) ISBN path — by far the most specific signal.
  if (hints.isbn) {
    const cleaned = hints.isbn.replace(/[^\dxX]/g, '');
    if (cleaned.length === 10 || cleaned.length === 13) {
      try {
        const url =
          `https://openlibrary.org/search.json?isbn=${encodeURIComponent(cleaned)}` +
          `&fields=key,title,author_name,isbn,publisher,first_publish_year,publish_year,publish_date,lcc,lc_classifications,subject`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          cache: 'no-store',
          headers: DEFAULT_HEADERS,
        });
        if (!res.ok) {
          log.tier('ol-by-isbn', `GET ${url} → ${res.status} (skip)`);
        } else {
          const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
          const doc = data.docs?.[0];
          if (doc) {
            const publicationYear =
              doc.first_publish_year ||
              parsePublishDateYear(doc.publish_date) ||
              (doc.publish_year && doc.publish_year[0]) ||
              hints.year ||
              0;
            const lcc = normalizeLcc(
              (doc.lcc && doc.lcc[0]) ||
                (doc.lc_classifications && doc.lc_classifications[0]) ||
                ''
            );
            const finalLcc = lcc || normalizeLcc(await lookupLccByIsbn(cleaned));
            const out: BookLookupResult = {
              isbn: cleaned,
              publisher: doc.publisher?.[0] ?? hints.publisher ?? '',
              publicationYear,
              lcc: finalLcc,
              subjects: doc.subject?.slice(0, 10),
              source: 'openlibrary',
            };
            log.tier('ol-by-isbn', `GET ${url} → ${res.status} → matched ${describeFilled(out)}`);
            log.finish({ ...out, tier: 'ol-by-isbn' });
            return out;
          }
          log.tier('ol-by-isbn', `GET ${url} → ${res.status} → 0 docs (fall through to year-scoped)`);
        }
      } catch (err) {
        log.tier('ol-by-isbn', `error ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      log.tier('ol-by-isbn', `skipped — hint ISBN length ${cleaned.length} not 10 or 13`);
    }
  }

  // 2) Year-scoped search (with publisher tie-breaker).
  if (title && hints.year) {
    try {
      const cleanedAuthor = cleanAuthorForQuery(author);
      const shortTitle = stripSubtitle(title);
      const params = new URLSearchParams();
      params.set('title', shortTitle);
      if (cleanedAuthor) params.set('author', cleanedAuthor);
      params.set('publish_year', String(hints.year));
      params.set('limit', '5');
      params.set(
        'fields',
        'key,title,author_name,isbn,publisher,first_publish_year,publish_year,publish_date,lcc,lc_classifications,subject'
      );
      const res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`, {
        signal: AbortSignal.timeout(10000),
        cache: 'no-store',
        headers: DEFAULT_HEADERS,
      });
      if (res.ok) {
        const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
        const docs = data.docs ?? [];
        // Prefer publisher match if hint provided.
        const publisherHint = (hints.publisher ?? '').toLowerCase().trim();
        const cleanedAuthorForScore = cleanAuthorForQuery(author);
        const ranked = docs
          .filter((d) => !isStudyGuide(d))
          .map((d) => {
            let score = scoreDoc(d, title, cleanedAuthorForScore);
            if (publisherHint && d.publisher) {
              const pubMatch = d.publisher.some((p) =>
                p.toLowerCase().includes(publisherHint) ||
                publisherHint.includes(p.toLowerCase())
              );
              if (pubMatch) score += 4;
            }
            return { d, score };
          })
          .sort((a, b) => b.score - a.score);
        const best = ranked[0]?.d;
        if (best) {
          const isbn = pickIsbn(best.isbn);
          const publicationYear =
            best.first_publish_year ||
            parsePublishDateYear(best.publish_date) ||
            (best.publish_year && best.publish_year[0]) ||
            hints.year;
          let lcc = normalizeLcc(
            (best.lcc && best.lcc[0]) ||
              (best.lc_classifications && best.lc_classifications[0]) ||
              ''
          );
          if (!lcc && isbn) lcc = normalizeLcc(await lookupLccByIsbn(isbn));
          const out: BookLookupResult = {
            isbn,
            publisher: best.publisher?.[0] ?? hints.publisher ?? '',
            publicationYear,
            lcc,
            subjects: best.subject?.slice(0, 10),
            source: 'openlibrary',
          };
          log.tier('ol-year-scoped', `matched ${describeFilled(out)}`);
          log.finish({ ...out, tier: 'ol-year-scoped' });
          return out;
        }
        log.tier('ol-year-scoped', `0 docs after ranking — falling back to unscoped chain`);
      } else {
        log.tier('ol-year-scoped', `OL search → ${res.status} (skip)`);
      }
    } catch (err) {
      log.tier('ol-year-scoped', `error ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3) ISBNdb direct, when we have an ISBN hint. ISBNdb's /book/{isbn}
  // is exact and broader than OL — it commonly resolves edition-level
  // metadata that OL doesn't have, especially for recent printings.
  // This closes the gap where a real ISBN existed but lookupSpecificEdition
  // returned empty after OL missed.
  if (hints.isbn) {
    const cleaned = hints.isbn.replace(/[^\dxX]/g, '');
    if (cleaned.length === 10 || cleaned.length === 13) {
      const hit = await lookupIsbndb(title, author, cleaned, log);
      if (hit && (hit.isbn || hit.publisher || hit.publicationYear)) {
        const sruLcc = await lookupLccByIsbn(cleaned);
        const out: BookLookupResult = {
          isbn: hit.isbn || cleaned,
          publisher: hit.publisher || hints.publisher || '',
          publicationYear: hit.publicationYear || hints.year || 0,
          lcc: normalizeLcc(sruLcc) || '',
          subjects: hit.subjects.length > 0 ? hit.subjects.slice(0, 10) : undefined,
          source: 'isbndb',
          coverUrl: hit.coverUrl || undefined,
          ddc: hit.ddc || undefined,
        };
        log.tier('isbndb-fallback', `matched ${describeFilled(out)}`);
        log.finish({ ...out, tier: 'isbndb-direct' });
        return out;
      }
    }
  }

  // 4) Fall back to the unscoped chain.
  log.tier('fallback', 'invoking unscoped lookupBook');
  return lookupBook(title, author);
}

const OL_FIELDS =
  'key,title,subtitle,author_name,isbn,publisher,first_publish_year,publish_year,publish_date,lcc,lc_classifications,subject,number_of_pages_median';

/**
 * Run one Open Library search.json query, score & pick the best matching
 * doc against the (cleaned) title + author, and convert it to a
 * BookLookupResult. Returns null on no match / no usable identifiers /
 * network error — the caller falls through to the next tier.
 */
async function tryOpenLibrary(
  params: URLSearchParams,
  matchTitle: string,
  matchAuthor: string,
  logger?: LookupLogger,
  stage = 'ol'
): Promise<BookLookupResult | null> {
  try {
    params.set('limit', '10');
    params.set('fields', OL_FIELDS);
    const url = `https://openlibrary.org/search.json?${params.toString()}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) {
      logger?.tier(stage, `GET ${url} → ${res.status} (skip)`);
      return null;
    }
    const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
    const docs = data.docs ?? [];
    const best = pickBestDoc(docs, matchTitle, matchAuthor);
    if (!best) {
      logger?.tier(
        stage,
        `GET ${url} → ${res.status} → ${docs.length} hit(s), none scored above threshold`
      );
      return null;
    }
    const isbn = pickIsbn(best.isbn);
    const publisher = best.publisher?.[0] ?? '';
    const publicationYear =
      best.first_publish_year ||
      parsePublishDateYear(best.publish_date) ||
      (best.publish_year && best.publish_year[0]) ||
      0;
    let lcc =
      (best.lcc && best.lcc[0]) ??
      (best.lc_classifications && best.lc_classifications[0]) ??
      '';
    // Work-level fetch for both LCC fallback and synopsis extraction.
    // Done as a single fetch so we don't pay two roundtrips when the
    // work record is needed for either piece.
    let workRecord: OpenLibraryWorkFull | null = null;
    if (best.key && (!lcc || true)) {
      workRecord = await fetchWorkRecord(best.key);
      if (!lcc && workRecord) {
        lcc =
          (workRecord.lcc && workRecord.lcc[0]) ||
          (workRecord.lc_classifications && workRecord.lc_classifications[0]) ||
          '';
      }
    }
    if (!isbn && !publisher && !lcc && !publicationYear) {
      logger?.tier(stage, `GET ${url} → ${res.status} → matched but no usable identifiers`);
      return null;
    }
    const out: BookLookupResult = {
      isbn,
      publisher,
      publicationYear,
      lcc,
      subjects: best.subject?.slice(0, 10),
      source: 'openlibrary',
    };
    // Phase-1/2 enrichment — additive, optional fields. Nothing reads
    // these yet; later commits surface them downstream.
    if (best.title) out.canonicalTitle = best.title;
    if (best.subtitle) out.subtitle = best.subtitle;
    if (best.author_name?.[0]) out.canonicalAuthor = best.author_name[0];
    if (best.author_name && best.author_name.length > 0) out.allAuthors = [...best.author_name];
    if (best.number_of_pages_median) out.pageCount = best.number_of_pages_median;
    if (workRecord?.description) {
      out.synopsis =
        typeof workRecord.description === 'string'
          ? workRecord.description
          : workRecord.description.value;
    }
    logger?.tier(stage, `GET ${url} → ${res.status} → ${describeFilled(out)}`);
    return out;
  } catch (err) {
    logger?.tier(stage, `error ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 3: ISBNdb (paid, key required, ~110M titles, broadest single source)
// ---------------------------------------------------------------------------

interface IsbndbBook {
  isbn?: string;
  isbn13?: string;
  title?: string;
  title_long?: string;
  authors?: string[];
  publisher?: string;
  date_published?: string;
  pages?: number;
  binding?: string;
  subjects?: string[];
  dewey_decimal?: string | string[];
  language?: string;
  /** Cover image URL (used as a tertiary fallback in BookLookupResult.coverUrl). */
  image?: string;
  /** Edition statement, e.g. "1st", "Reprint", "Revised". */
  edition?: string;
  /** ISBNdb's per-book synopsis when available. */
  synopsis?: string;
}

// Module-level rate-limit gate. ISBNdb basic plan = 1 req/sec. Concurrent
// book lookups in a batch all funnel through here; each one claims the
// next 1-second slot. Within a single Vercel function instance this
// produces clean spacing; across cold-started instances we may exceed
// briefly, which is what the 429-retry handler below covers.
let isbndbNextSlot = 0;
async function isbndbWaitSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, isbndbNextSlot);
  isbndbNextSlot = slot + 1000;
  if (slot > now) await sleep(slot - now);
}

function parseIsbndbYear(s: string | undefined): number {
  if (!s) return 0;
  const m = s.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : 0;
}

async function isbndbFetch(url: string, apiKey: string): Promise<Response | null> {
  // One retry on 429 per the spec. Any other non-OK is surfaced to the
  // caller for skip-and-continue handling.
  for (let attempt = 0; attempt < 2; attempt++) {
    await isbndbWaitSlot();
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
    });
    if (res.status === 429 && attempt === 0) {
      await sleep(2000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      console.error('[isbndb] ISBNDB_API_KEY is invalid or subscription has expired.');
      return null;
    }
    return res;
  }
  return null;
}

interface IsbndbHit {
  isbn: string;
  publisher: string;
  publicationYear: number;
  author: string;
  ddc: string;
  subjects: string[];
  /** Cover image URL, when ISBNdb returned one. Used as a fallback in coverUrl. */
  coverUrl: string;
  // Phase-2 enrichment fields. Optional so existing call sites that
  // only read isbn/publisher/etc still compile. Populated by the
  // mapper from the wider IsbndbBook surface area.
  title?: string;
  titleLong?: string;
  allAuthors?: string[];
  pages?: number;
  binding?: string;
  language?: string;
  edition?: string;
  synopsis?: string;
}

function isbndbBookToHit(b: IsbndbBook): IsbndbHit {
  const isbn = (b.isbn13 || b.isbn || '').replace(/[^\dxX]/g, '');
  const ddcRaw = Array.isArray(b.dewey_decimal) ? b.dewey_decimal[0] : b.dewey_decimal;
  const allAuthors = Array.isArray(b.authors)
    ? b.authors.map((a) => String(a).trim()).filter(Boolean)
    : [];
  return {
    isbn,
    publisher: (b.publisher ?? '').trim(),
    publicationYear: parseIsbndbYear(b.date_published),
    author: allAuthors[0] ?? '',
    ddc: (ddcRaw ?? '').toString().trim(),
    subjects: Array.isArray(b.subjects) ? b.subjects.map((s) => String(s).trim()).filter(Boolean) : [],
    coverUrl: (b.image ?? '').trim(),
    // Phase-2 enrichment fields — undefined when ISBNdb didn't supply
    // them, so optional-chaining at the merge site stays clean.
    title: b.title ? String(b.title).trim() : undefined,
    titleLong: b.title_long ? String(b.title_long).trim() : undefined,
    allAuthors: allAuthors.length > 0 ? allAuthors : undefined,
    pages: typeof b.pages === 'number' && b.pages > 0 ? b.pages : undefined,
    binding: b.binding ? String(b.binding).trim() : undefined,
    language: b.language ? String(b.language).trim() : undefined,
    edition: b.edition ? String(b.edition).trim() : undefined,
    synopsis: b.synopsis ? String(b.synopsis).trim() : undefined,
  };
}

/**
 * ISBNdb tier. Fills gaps in an in-progress BookLookupResult — does NOT
 * replace fields a higher-priority tier already populated. Returns null
 * when the key is missing, the lookup misses, or the call errors.
 *
 * Two query modes:
 *  - Direct ISBN endpoint (precise) when we already have an ISBN
 *  - Search endpoint when we don't, with a Levenshtein title-match guard
 *    to avoid spurious hits from broad text queries
 */
export async function lookupIsbndb(
  title: string,
  author: string,
  isbn?: string,
  logger?: LookupLogger
): Promise<IsbndbHit | null> {
  const apiKey = process.env.ISBNDB_API_KEY;
  if (!apiKey) {
    if (!isbndbKeyMissingWarned) {
      console.warn('[isbndb] ISBNDB_API_KEY not set — tier 3 (ISBNdb) disabled.');
      isbndbKeyMissingWarned = true;
    }
    logger?.tier('isbndb', 'skipped — ISBNDB_API_KEY not set');
    return null;
  }

  try {
    // Path 1: direct ISBN lookup. Most precise; one record returned.
    if (isbn) {
      const cleaned = isbn.replace(/[^\dxX]/g, '');
      if (cleaned.length === 10 || cleaned.length === 13) {
        const url = `https://api2.isbndb.com/book/${encodeURIComponent(cleaned)}`;
        const res = await isbndbFetch(url, apiKey);
        if (!res) {
          logger?.tier('isbndb-direct', `${url} → no response (auth or rate-limit)`);
        } else if (!res.ok) {
          logger?.tier('isbndb-direct', `GET ${url} → ${res.status} (skip)`);
        } else {
          const data = (await res.json()) as { book?: IsbndbBook };
          if (data.book) {
            const hit = isbndbBookToHit(data.book);
            logger?.tier(
              'isbndb-direct',
              `GET ${url} → 200 → matched isbn=${hit.isbn} publisher=${JSON.stringify(hit.publisher)} year=${hit.publicationYear || '-'}`
            );
            return hit;
          }
          logger?.tier('isbndb-direct', `GET ${url} → 200 but body had no book{}`);
        }
      } else {
        logger?.tier('isbndb-direct', `skipped — ISBN length ${cleaned.length} not 10 or 13`);
      }
    } else {
      logger?.tier('isbndb-direct', 'skipped — no ISBN known yet (will fall through to title search)');
    }

    // Path 2: search by title + author last name. ISBNdb's relevance
    // ranking is decent but we still verify the top result's title is
    // close enough to ours before trusting it.
    const queryTokens = [
      title.trim(),
      lastName(author).trim(),
    ].filter(Boolean).join(' ');
    if (!queryTokens) {
      logger?.tier('isbndb-search', 'skipped — empty title and author');
      return null;
    }
    const url = `https://api2.isbndb.com/books/${encodeURIComponent(queryTokens)}`;
    const res = await isbndbFetch(url, apiKey);
    if (!res) {
      logger?.tier('isbndb-search', `${url} → no response`);
      return null;
    }
    if (!res.ok) {
      logger?.tier('isbndb-search', `GET ${url} → ${res.status} (skip)`);
      return null;
    }
    const data = (await res.json()) as { books?: IsbndbBook[] };
    const books = data.books ?? [];
    // Pick the first result whose normalized title is plausibly the same
    // book — substring-bidirectional match catches subtitle variants.
    const best = books.find((b) => {
      const t = b.title_long || b.title || '';
      return titleSubstringMatch(title, t) || normalize(t) === normalize(title);
    });
    if (!best) {
      logger?.tier(
        'isbndb-search',
        `GET ${url} → 200 → ${books.length} hit(s), none with a plausible title match`
      );
      return null;
    }
    const hit = isbndbBookToHit(best);
    logger?.tier(
      'isbndb-search',
      `GET ${url} → 200 → matched ${JSON.stringify(best.title_long || best.title || '')} isbn=${hit.isbn || '-'}`
    );
    return hit;
  } catch (err) {
    logger?.tier('isbndb', `error ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 5: Wikidata (free SPARQL endpoint, primary purpose: LCC gap-filling)
// ---------------------------------------------------------------------------

interface WikidataHit {
  lcc: string;
  ddc: string;
  isbn: string;
  publisher: string;
  publicationYear: number;
  // Phase-2 enrichment fields. Optional/string-valued so the
  // consumer can gap-fill cleanly into BookLookupResult.
  genre?: string;
  subject?: string;
  pageCount?: number;
  series?: string;
}

function buildWikidataSparql(title: string): string {
  // Sanitize before embedding in SPARQL — strips wildcards/special chars
  // that the CONTAINS filter would treat as literal characters and miss
  // a match on. Also escape any double-quotes that survive.
  const cleaned = sanitizeForSearch(title);
  const lower = cleaned.toLowerCase().replace(/"/g, '\\"');
  // P31=Q571 (book), Q7725634 (literary work), Q47461344 (written work).
  // Filtering by any of those captures most book entities. The label
  // CONTAINS filter narrows to entries whose label includes our title;
  // we then verify the match in the response.
  //
  // Phase-2 enrichment: also pull genre (P136), main subject (P921),
  // number of pages (P1104), and series (P179) when present.
  return `SELECT ?item ?itemLabel ?isbn13 ?lcc ?ddc ?authorLabel ?publisherLabel ?pubdate ?genreLabel ?subjectLabel ?pages ?seriesLabel WHERE {
  VALUES ?type { wd:Q571 wd:Q7725634 wd:Q47461344 }
  ?item wdt:P31 ?type.
  ?item rdfs:label ?label. FILTER(LANG(?label) = "en"). FILTER(CONTAINS(LCASE(?label), "${lower}")).
  OPTIONAL { ?item wdt:P212 ?isbn13. }
  OPTIONAL { ?item wdt:P1036 ?lcc. }
  OPTIONAL { ?item wdt:P971 ?ddc. }
  OPTIONAL { ?item wdt:P50 ?author. ?author rdfs:label ?authorLabel. FILTER(LANG(?authorLabel) = "en"). }
  OPTIONAL { ?item wdt:P123 ?publisher. ?publisher rdfs:label ?publisherLabel. FILTER(LANG(?publisherLabel) = "en"). }
  OPTIONAL { ?item wdt:P577 ?pubdate. }
  OPTIONAL { ?item wdt:P136 ?genre. ?genre rdfs:label ?genreLabel. FILTER(LANG(?genreLabel) = "en"). }
  OPTIONAL { ?item wdt:P921 ?subject. ?subject rdfs:label ?subjectLabel. FILTER(LANG(?subjectLabel) = "en"). }
  OPTIONAL { ?item wdt:P1104 ?pages. }
  OPTIONAL { ?item wdt:P179 ?series. ?series rdfs:label ?seriesLabel. FILTER(LANG(?seriesLabel) = "en"). }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 5`;
}

interface WikidataBinding {
  itemLabel?: { value: string };
  isbn13?: { value: string };
  lcc?: { value: string };
  ddc?: { value: string };
  authorLabel?: { value: string };
  publisherLabel?: { value: string };
  pubdate?: { value: string };
  // Phase-2 enrichment additions.
  genreLabel?: { value: string };
  subjectLabel?: { value: string };
  pages?: { value: string };
  seriesLabel?: { value: string };
}

/**
 * Wikidata SPARQL lookup. Single HTTP call returns LCC, DDC, ISBN, author,
 * publisher, pubdate when Wikidata has them. Coverage is patchy — many
 * books have no Wikidata entry. That's expected; this tier exists to
 * occasionally save us from reaching the AI-inferred-LCC fallback.
 */
export async function lookupWikidata(
  title: string,
  author: string,
  logger?: LookupLogger
): Promise<WikidataHit | null> {
  if (!title || title.length < 3) {
    logger?.tier('wikidata', 'skipped — title too short for SPARQL CONTAINS filter');
    return null;
  }
  try {
    const sparql = buildWikidataSparql(title);
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
    });
    if (!res.ok) {
      logger?.tier('wikidata', `query.wikidata.org/sparql → ${res.status} (skip)`);
      return null;
    }
    const data = (await res.json()) as { results?: { bindings?: WikidataBinding[] } };
    const bindings = data.results?.bindings ?? [];
    if (bindings.length === 0) {
      logger?.tier('wikidata', 'query.wikidata.org/sparql → 200 → 0 bindings');
      return null;
    }

    // Pick the binding that best matches our title + author. Title match
    // is required; author match (when we have an author) is preferred.
    const wantAuthor = normalize(author);
    let best: WikidataBinding | undefined;
    let bestScore = -Infinity;
    for (const b of bindings) {
      if (!titleSubstringMatch(title, b.itemLabel?.value)) continue;
      let score = 0;
      if (b.lcc?.value) score += 5;
      if (b.ddc?.value) score += 1;
      if (wantAuthor && b.authorLabel?.value) {
        const candAuthor = normalize(b.authorLabel.value);
        if (candAuthor && (candAuthor.includes(wantAuthor) || wantAuthor.includes(candAuthor))) {
          score += 3;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (!best) {
      logger?.tier('wikidata', `query.wikidata.org/sparql → 200 → ${bindings.length} bindings, none with a plausible title match`);
      return null;
    }

    const pagesRaw = best.pages?.value;
    const pageCount = pagesRaw ? parseInt(pagesRaw, 10) : 0;
    const hit: WikidataHit = {
      lcc: (best.lcc?.value ?? '').trim(),
      ddc: (best.ddc?.value ?? '').trim(),
      isbn: (best.isbn13?.value ?? '').replace(/[^\dxX]/g, ''),
      publisher: (best.publisherLabel?.value ?? '').trim(),
      publicationYear: best.pubdate?.value
        ? parseInt(best.pubdate.value.slice(0, 4), 10) || 0
        : 0,
      genre: best.genreLabel?.value?.trim() || undefined,
      subject: best.subjectLabel?.value?.trim() || undefined,
      pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : undefined,
      series: best.seriesLabel?.value?.trim() || undefined,
    };
    logger?.tier(
      'wikidata',
      `query.wikidata.org/sparql → 200 → matched ${JSON.stringify(best.itemLabel?.value ?? '')}` +
        (hit.lcc ? ` lcc=${JSON.stringify(hit.lcc)}` : ' (no lcc)')
    );
    return hit;
  } catch (err) {
    logger?.tier('wikidata', `error ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function lookupBook(
  title: string,
  author: string
): Promise<BookLookupResult & { tier?: string }> {
  const log = createLookupLogger(title);
  log.start({ title, author });

  if (!title) {
    log.tier('input', 'no title — returning empty result');
    const empty = { isbn: '', publisher: '', publicationYear: 0, lcc: '', source: 'none' as const, tier: 'none' };
    log.finish(empty);
    return empty;
  }

  // Sanitized search-only copies. The original `title` and `author`
  // params still flow downstream unchanged — only the strings we
  // hand to external APIs get the special-character scrub. "Holy
  // Sh*t" → "Holy Sht" for the query; the BookRecord still shows
  // the spine read.
  const searchTitle = sanitizeForSearch(title);
  const searchAuthor = sanitizeForSearch(author);
  const cleanedAuthor = cleanAuthorForQuery(searchAuthor);
  const shortTitle = stripSubtitle(searchTitle);
  const hadSubtitle = shortTitle !== searchTitle.trim();

  let result: BookLookupResult = {
    isbn: '',
    publisher: '',
    publicationYear: 0,
    lcc: '',
    source: 'none',
  };
  let tier = '';
  // Cover-art fallbacks captured as we go. Primary path (Open Library by
  // ISBN) is computed at the bottom; these only kick in when no ISBN is
  // available to key the OL covers URL.
  let gbCoverUrl = '';
  let isbndbCoverUrl = '';

  // Tier 1: full title + cleaned author. Sanitized strings only —
  // `title` and `author` from the args still flow downstream for
  // display / grounding.
  {
    const p = new URLSearchParams();
    p.set('title', searchTitle);
    if (cleanedAuthor) p.set('author', cleanedAuthor);
    const r = await tryOpenLibrary(p, searchTitle, cleanedAuthor, log, 'ol-t1');
    if (r) {
      result = r;
      tier = 'ol-t1';
    }
  }
  // Tier 2: short title (subtitle stripped) + cleaned author. Catches
  // books whose subtitle drifted across editions.
  if (result.source === 'none' && hadSubtitle && cleanedAuthor) {
    const p = new URLSearchParams();
    p.set('title', shortTitle);
    p.set('author', cleanedAuthor);
    const r = await tryOpenLibrary(p, shortTitle, cleanedAuthor, log, 'ol-t2');
    if (r) {
      result = r;
      tier = 'ol-t2';
    }
  } else if (result.source !== 'none') {
    log.tier('ol-t2', 'skipped — ol-t1 already filled');
  } else if (!hadSubtitle) {
    log.tier('ol-t2', 'skipped — no subtitle to strip');
  } else {
    log.tier('ol-t2', 'skipped — no cleaned author');
  }
  // Tier 3: short title + author last-name only. The cleaned author
  // string can include initials, middle names, suffixes that don't
  // match OL's index — searching by last name alone is more permissive
  // and rescues a non-trivial fraction of partial spine reads.
  const authorLast = lastName(cleanedAuthor);
  if (result.source === 'none' && authorLast && authorLast !== cleanedAuthor) {
    const p = new URLSearchParams();
    p.set('title', shortTitle);
    p.set('author', authorLast);
    const r = await tryOpenLibrary(p, shortTitle, authorLast, log, 'ol-t3-last');
    if (r) {
      result = r;
      tier = 'ol-t3-last';
    }
  } else if (result.source !== 'none') {
    log.tier('ol-t3-last', 'skipped — earlier tier already filled');
  } else if (!authorLast) {
    log.tier('ol-t3-last', 'skipped — no author last name available');
  } else {
    log.tier('ol-t3-last', 'skipped — last name same as cleaned author (already tried)');
  }
  // Tier 4: short title only (no author — catches OL author-index quirks)
  if (result.source === 'none') {
    const p = new URLSearchParams();
    p.set('title', shortTitle);
    const r = await tryOpenLibrary(p, shortTitle, cleanedAuthor, log, 'ol-t4-titleonly');
    if (r) {
      result = r;
      tier = 'ol-t4-titleonly';
    }
  } else {
    log.tier('ol-t4-titleonly', 'skipped — earlier tier already filled');
  }
  // Tier 5: full-text q= (most lenient OL tier — last title-driven attempt)
  if (result.source === 'none') {
    const p = new URLSearchParams();
    p.set('q', `${shortTitle} ${cleanedAuthor}`.trim());
    const r = await tryOpenLibrary(p, shortTitle, cleanedAuthor, log, 'ol-t5-q');
    if (r) {
      result = r;
      tier = 'ol-t5-q';
    }
  } else {
    log.tier('ol-t5-q', 'skipped — earlier tier already filled');
  }

  // 5) Google Books fallback (only if Open Library didn't yield a usable result)
  if (result.source !== 'none') {
    log.tier('gb', 'skipped — earlier tier already filled');
  }
  if (result.source === 'none') try {
    const q = `intitle:${encodeURIComponent(shortTitle)}${
      cleanedAuthor ? `+inauthor:${encodeURIComponent(cleanedAuthor)}` : ''
    }`;
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
    const baseUrl = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3`;
    const keyedUrl = apiKey ? `${baseUrl}&key=${apiKey}` : baseUrl;
    let res = await fetch(keyedUrl, { signal: AbortSignal.timeout(10000), cache: 'no-store', headers: DEFAULT_HEADERS });
    // If the keyed call fails with 4xx/5xx, retry without the key — generous unauth'd quota.
    if (!res.ok && apiKey) {
      log.tier('gb', `keyed → ${res.status}, retrying unauth'd`);
      res = await fetch(baseUrl, { signal: AbortSignal.timeout(10000), cache: 'no-store', headers: DEFAULT_HEADERS });
    }
    if (!res.ok) {
      log.tier('gb', `GET ${baseUrl} → ${res.status} (skip)`);
    } else {
      const data = (await res.json()) as {
        items?: Array<{
          volumeInfo: {
            industryIdentifiers?: { type: string; identifier: string }[];
            publisher?: string;
            publishedDate?: string;
            categories?: string[];
            imageLinks?: { thumbnail?: string; smallThumbnail?: string };
          };
        }>;
      };
      const vi = data.items?.[0]?.volumeInfo;
      if (!vi) {
        log.tier('gb', `GET ${baseUrl} → ${res.status} → 0 items`);
      } else {
        // Capture the Google Books cover for the no-ISBN fallback path.
        // Prefer thumbnail over smallThumbnail; rewrite http→https because
        // the Books API still serves http URLs that mixed-content-block
        // on production.
        const gbRaw = vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail ?? '';
        if (gbRaw) gbCoverUrl = gbRaw.replace(/^http:\/\//i, 'https://');
        const ids = vi.industryIdentifiers ?? [];
        const isbn13 =
          ids.find((i) => i.type === 'ISBN_13' && !i.identifier.startsWith('9798'))?.identifier ??
          ids.find((i) => i.type === 'ISBN_13')?.identifier ??
          '';
        const isbn10 = ids.find((i) => i.type === 'ISBN_10')?.identifier ?? '';
        const isbn = isbn13 || isbn10;
        const publisher = vi.publisher ?? '';
        const editionYear = vi.publishedDate ? parseInt(vi.publishedDate.slice(0, 4), 10) : 0;

        // Enrich in parallel: Open Library /isbn for the work's
        // first_publish_year (e.g., 1942 for Camus' The Stranger), and
        // LoC SRU for the authoritative LCC. Two independent ISBN-keyed
        // calls — running them concurrently saves the slower one's wait.
        const [enriched, sruLcc] = await Promise.all([
          enrichFromIsbn(isbn),
          lookupLccByIsbn(isbn),
        ]);
        const publicationYear =
          enriched.firstPublishYear || (Number.isFinite(editionYear) ? editionYear : 0);

        result = {
          isbn,
          publisher,
          publicationYear,
          // LoC SRU is the most authoritative LCC source; fall back to the
          // OL work-level enrichment if SRU had nothing.
          lcc: sruLcc || enriched.lcc,
          subjects: vi.categories ?? [],
          source: 'googlebooks',
        };
        tier = 'gb';
        log.tier(
          'gb',
          `GET ${baseUrl} → ${res.status} → matched isbn=${isbn || '-'} pub=${JSON.stringify(publisher)} year=${publicationYear || '-'} lcc=${JSON.stringify(result.lcc || '')}`
        );
      }
    }
  } catch (err) {
    log.tier('gb', `error ${err instanceof Error ? err.message : String(err)}`);
  }

  // Final post-processing: canonicalize LCC + LoC SRU enrichment.
  // Track WHERE the LCC came from so the BookCard can show provenance.
  result.lcc = normalizeLcc(result.lcc);
  let lccSource: 'ol' | 'loc' | 'wikidata' | 'inferred' | 'none' = result.lcc ? 'ol' : 'none';

  // -------------------------------------------------------------------------
  // PHASE B: ISBN-driven cross-tier enrichment.
  //
  // The user's complaint: tiers used to run independently and the first
  // hit "won" — leaving books with partial data when one source had ISBN
  // but no year, another had publisher but no cover, etc. From here on,
  // tiers feed each other: any ISBN we have is used to fan out to every
  // source that supports ISBN-direct, with results merged into the
  // existing record (gap-fill — never overwrite a higher-priority field).
  // -------------------------------------------------------------------------
  if (result.isbn) {
    const wantOl = !result.publicationYear || !result.lcc;
    const wantGb = !result.publisher || !result.coverUrl || (result.subjects ?? []).length === 0;
    const wantSru = !result.lcc;
    const callCount = (wantOl ? 1 : 0) + (wantGb ? 1 : 0) + (wantSru ? 1 : 0);

    if (callCount === 0) {
      log.tier('phase-b', `skipped — isbn=${result.isbn} but every gap-filler already satisfied`);
    } else {
      log.tier('phase-b', `isbn=${result.isbn} → fanning out ${callCount} ISBN-direct call(s) in parallel`);
      const [olEnrich, gbEnrich, sruLcc] = await Promise.all([
        wantOl ? enrichFromIsbn(result.isbn) : Promise.resolve({ firstPublishYear: 0, lcc: '' }),
        wantGb ? gbEnrichByIsbn(result.isbn) : Promise.resolve(null as GbIsbnEnrichment | null),
        wantSru ? lookupLccByIsbn(result.isbn) : Promise.resolve(''),
      ]);

      if (wantOl) {
        if (!result.publicationYear && olEnrich.firstPublishYear) {
          result.publicationYear = olEnrich.firstPublishYear;
          log.tier('phase-b', `  ol-by-isbn filled year=${olEnrich.firstPublishYear}`);
        }
        if (!result.lcc && olEnrich.lcc) {
          result.lcc = normalizeLcc(olEnrich.lcc);
          lccSource = 'ol';
          log.tier('phase-b', `  ol-by-isbn filled lcc=${JSON.stringify(result.lcc)}`);
        }
      }
      if (gbEnrich) {
        if (!result.publisher && gbEnrich.publisher) {
          result.publisher = gbEnrich.publisher;
          log.tier('phase-b', `  gb-by-isbn filled publisher=${JSON.stringify(gbEnrich.publisher)}`);
        }
        if (!result.publicationYear && gbEnrich.publicationYear) {
          result.publicationYear = gbEnrich.publicationYear;
          log.tier('phase-b', `  gb-by-isbn filled year=${gbEnrich.publicationYear}`);
        }
        if (gbEnrich.coverUrl && !gbCoverUrl) gbCoverUrl = gbEnrich.coverUrl;
        if (gbEnrich.subjects.length > 0) {
          const existing = new Set((result.subjects ?? []).map((s) => s.toLowerCase()));
          const merged = [...(result.subjects ?? [])];
          for (const s of gbEnrich.subjects) {
            if (!existing.has(s.toLowerCase())) merged.push(s);
          }
          if (merged.length !== (result.subjects ?? []).length) {
            log.tier('phase-b', `  gb-by-isbn added ${merged.length - (result.subjects ?? []).length} subject(s)`);
          }
          result.subjects = merged.slice(0, 15);
        }
      }
      if (sruLcc && !result.lcc) {
        result.lcc = normalizeLcc(sruLcc);
        lccSource = 'loc';
        log.tier('phase-b', `  loc-sru filled lcc=${JSON.stringify(result.lcc)}`);
      }
    }
  } else {
    log.tier('phase-b', 'skipped — no ISBN to fan out from');
  }

  // LoC SRU by title + author. Catches books with no ISBN.
  if (!result.lcc && searchTitle && searchAuthor) {
    const sruLcc = await lookupLccByTitleAuthor(searchTitle, cleanedAuthor);
    if (sruLcc) {
      result.lcc = normalizeLcc(sruLcc);
      lccSource = 'loc';
      log.tier('loc-by-title', `lx2.loc.gov/sru by title+author → matched lcc=${JSON.stringify(result.lcc)}`);
    } else {
      log.tier('loc-by-title', 'lx2.loc.gov/sru by title+author → no LCC');
    }
  } else if (result.lcc) {
    log.tier('loc-by-title', `skipped — LCC already set (${lccSource})`);
  } else {
    log.tier('loc-by-title', 'skipped — no title or author');
  }

  // -------------------------------------------------------------------------
  // ISBNdb. ALWAYS queried when we have an ISBN (or as a title-search
  // fallback if we don't), regardless of what earlier tiers returned.
  // Even when OL or GB already filled isbn+publisher+year, ISBNdb adds
  // subjects, DDC, cover, synopsis that the others miss. Skip silently
  // when ISBNDB_API_KEY isn't configured.
  // -------------------------------------------------------------------------
  {
    const isbndbHit = await lookupIsbndb(searchTitle, searchAuthor, result.isbn || undefined, log);
    if (isbndbHit) {
      let usedIsbndb = false;
      if (!result.isbn && isbndbHit.isbn) {
        result.isbn = isbndbHit.isbn;
        usedIsbndb = true;
      }
      if (!result.publisher && isbndbHit.publisher) {
        result.publisher = isbndbHit.publisher;
        usedIsbndb = true;
      }
      if (!result.publicationYear && isbndbHit.publicationYear) {
        result.publicationYear = isbndbHit.publicationYear;
        usedIsbndb = true;
      }
      if (!result.ddc && isbndbHit.ddc) {
        result.ddc = isbndbHit.ddc;
        usedIsbndb = true;
      }
      if (isbndbHit.subjects.length > 0) {
        const existing = new Set((result.subjects ?? []).map((s) => s.toLowerCase()));
        const merged = [...(result.subjects ?? [])];
        for (const s of isbndbHit.subjects) {
          if (!existing.has(s.toLowerCase())) merged.push(s);
        }
        result.subjects = merged.slice(0, 15);
      }
      if (isbndbHit.coverUrl) isbndbCoverUrl = isbndbHit.coverUrl;

      // Phase-2 enrichment merges. Each field gap-fills only — a
      // higher-priority tier (OL) is never overwritten. The collected
      // ISBNdb cover URL is also added to the fallback chain so
      // commit-10 can swap to it when the OL covers URL 404s.
      if (!result.canonicalTitle) {
        result.canonicalTitle = isbndbHit.title || isbndbHit.titleLong || undefined;
      }
      if (!result.canonicalAuthor && isbndbHit.allAuthors?.[0]) {
        result.canonicalAuthor = isbndbHit.allAuthors[0];
      }
      if (!result.allAuthors && isbndbHit.allAuthors?.length) {
        result.allAuthors = [...isbndbHit.allAuthors];
      }
      if (!result.synopsis && isbndbHit.synopsis) result.synopsis = isbndbHit.synopsis;
      if (!result.pageCount && isbndbHit.pages) result.pageCount = isbndbHit.pages;
      if (!result.edition && isbndbHit.edition) result.edition = isbndbHit.edition;
      if (!result.binding && isbndbHit.binding) result.binding = isbndbHit.binding;
      if (!result.language && isbndbHit.language) result.language = isbndbHit.language;
      if (isbndbHit.coverUrl) {
        result.coverUrlFallbacks = result.coverUrlFallbacks ?? [];
        if (!result.coverUrlFallbacks.includes(isbndbHit.coverUrl)) {
          result.coverUrlFallbacks.push(isbndbHit.coverUrl);
        }
      }

      // Only flip the metadata source label when the prior chain truly
      // returned nothing (`source: 'none'`). When OL/Google already
      // matched, ISBNdb is a gap-filler — keep their flag for diagnostics.
      if (result.source === 'none' && usedIsbndb) {
        result.source = 'isbndb';
        if (!tier || tier === 'none') tier = 'isbndb';
      }
    }
  }

  // -------------------------------------------------------------------------
  // MARC enrichment via the same LoC SRU endpoint, parsed for fields
  // beyond LCC: LCSH subject headings (600/610/611/630/650/651), DDC
  // (082), main author (100), title (245), publisher (264/260), edition
  // (250), page count (300 a), and co-authors (700/710). Wrapped in
  // try/catch so a parse / network failure here can never break the
  // pipeline — the standard tiers above already produced a result.
  // -------------------------------------------------------------------------
  if (result.isbn && !(result.lcshSubjects && result.lcshSubjects.length > 0)) {
    let marc: MarcResult | null = null;
    try {
      marc = await lookupFullMarcByIsbn(result.isbn);
    } catch (err) {
      log.tier(
        'loc-marc',
        `error ${err instanceof Error ? err.message : String(err)} (skipping enrichment)`
      );
    }
    if (marc) {
      if (marc.lcshSubjects.length > 0 && !(result.lcshSubjects && result.lcshSubjects.length > 0)) {
        result.lcshSubjects = marc.lcshSubjects;
      }
      if (!result.ddc && marc.ddc) result.ddc = marc.ddc;
      if (!result.pageCount && marc.pageCount) result.pageCount = marc.pageCount;
      if (!result.edition && marc.edition) result.edition = marc.edition;
      if (!result.canonicalAuthor && marc.author) result.canonicalAuthor = marc.author;
      if (!result.canonicalTitle && marc.title) result.canonicalTitle = marc.title;
      if (marc.coAuthors.length > 0) {
        const merged = new Set<string>(result.allAuthors ?? []);
        if (marc.author) merged.add(marc.author);
        for (const a of marc.coAuthors) merged.add(a);
        if (merged.size > (result.allAuthors?.length ?? 0)) {
          result.allAuthors = Array.from(merged);
        }
      }
      log.tier(
        'loc-marc',
        `lcsh=${marc.lcshSubjects.length} co-authors=${marc.coAuthors.length} pages=${marc.pageCount ?? '-'} edition=${JSON.stringify(marc.edition ?? '')}`
      );
    } else {
      log.tier('loc-marc', 'no MARC record');
    }
  } else if (result.lcshSubjects && result.lcshSubjects.length > 0) {
    log.tier('loc-marc', `skipped — lcshSubjects already populated (${result.lcshSubjects.length})`);
  } else {
    log.tier('loc-marc', 'skipped — no ISBN');
  }

  // -------------------------------------------------------------------------
  // Tier 5: Wikidata. LCC gap-filler that aggregates classifications from
  // multiple national libraries — sometimes catches books LoC's own SRU
  // missed. Only fires when LCC is still empty.
  // -------------------------------------------------------------------------
  if (result.lcc) {
    log.tier('wikidata', `skipped — LCC already set (${lccSource})`);
  } else {
    const wd = await lookupWikidata(searchTitle, searchAuthor, log);
    if (wd) {
      if (wd.lcc) {
        result.lcc = normalizeLcc(wd.lcc);
        lccSource = 'wikidata';
      }
      if (!result.ddc && wd.ddc) result.ddc = wd.ddc;
      if (!result.isbn && wd.isbn) result.isbn = wd.isbn;
      if (!result.publisher && wd.publisher) result.publisher = wd.publisher;
      if (!result.pageCount && wd.pageCount) result.pageCount = wd.pageCount;
      if (!result.series && wd.series) result.series = wd.series;
      // Genre / main subject merge into the subjects array — same pool
      // tag inference reads. Treat them as additional signal alongside
      // OL `subject` and ISBNdb `subjects`.
      if (wd.genre || wd.subject) {
        const existing = new Set((result.subjects ?? []).map((s) => s.toLowerCase()));
        const merged = [...(result.subjects ?? [])];
        for (const v of [wd.genre, wd.subject]) {
          if (v && !existing.has(v.toLowerCase())) {
            merged.push(v);
            existing.add(v.toLowerCase());
          }
        }
        result.subjects = merged.slice(0, 15);
      }
      if (!result.publicationYear && wd.publicationYear) {
        result.publicationYear = wd.publicationYear;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cover art. Per spec: Open Library Covers API (keyed by ISBN) is primary;
  // Google Books and ISBNdb are fallbacks for when no ISBN is available.
  // The `default=false` query param tells OL to 404 instead of returning a
  // grey placeholder when the cover is missing, so the BookCard <img>
  // onError handler can fall through to the spine crop.
  // -------------------------------------------------------------------------
  if (result.isbn) {
    const cleaned = result.isbn.replace(/[^\dxX]/g, '');
    if (cleaned) {
      result.coverUrl = `https://covers.openlibrary.org/b/isbn/${cleaned}-M.jpg?default=false`;
    }
  } else if (gbCoverUrl) {
    result.coverUrl = gbCoverUrl;
  } else if (isbndbCoverUrl) {
    result.coverUrl = isbndbCoverUrl;
  }

  const final = Object.assign(result, { tier: tier || 'none', lccSource });
  log.finish(final);
  return final;
}
