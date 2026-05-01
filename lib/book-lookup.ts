import type { BookLookupResult } from './types';

const UA = 'Carnegie/1.0 (personal cataloging tool)';
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json',
};

const LOC_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/xml',
};

/**
 * Open Library returns LCC in a padded internal form like
 *   "BL-0053.00000000.J36 2012"
 *   "Q--0335.00000000.M6 2024"
 *   "E--0169.12000000.K556 2022"
 * Convert to canonical Library of Congress format:
 *   "BL53 .J36 2012", "Q335 .M6 2024", "E169.12 .K556 2022".
 *
 * Inputs already in canonical or unparseable form pass through trimmed.
 */
export function normalizeLcc(s: string | undefined | null): string {
  if (!s) return '';
  const m = s.match(/^([A-Z]{1,3})[-\s]+(\d+)\.(\d+)\.(.+)$/);
  if (!m) return s.trim();
  const klass = m[1];
  const intPart = String(parseInt(m[2], 10));
  const decPart = m[3].replace(/0+$/, '');
  const num = decPart ? `${intPart}.${decPart}` : intPart;
  const cutter = m[4].trim();
  return `${klass}${num} .${cutter}`;
}

/**
 * Library of Congress SRU lookup by ISBN. Returns canonical-format LCC or
 * empty string. Free, no API key, ~0.5–2s typical.
 *
 * Example response (excerpted):
 *   <datafield tag="050" ind1="0" ind2="0">
 *     <subfield code="a">CT275.H62575</subfield>
 *     <subfield code="b">A3 2010</subfield>
 *   </datafield>
 */
async function loFetch050(url: string, timeoutMs: number): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      headers: LOC_HEADERS,
    });
    if (!res.ok) return '';
    const xml = await res.text();
    const fieldMatch = xml.match(
      /<datafield[^>]*tag="050"[^>]*>([\s\S]*?)<\/datafield>/
    );
    if (!fieldMatch) return '';
    const block = fieldMatch[1];
    const a = block.match(/<subfield[^>]*code="a"[^>]*>([^<]+)<\/subfield>/)?.[1]?.trim() ?? '';
    const b = block.match(/<subfield[^>]*code="b"[^>]*>([^<]+)<\/subfield>/)?.[1]?.trim() ?? '';
    return [a, b].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

export async function lookupLccByIsbn(isbn: string): Promise<string> {
  if (!isbn) return '';
  const cleaned = isbn.replace(/[^\dxX]/g, '');
  if (!cleaned) return '';
  const url =
    `https://lx2.loc.gov/sru/voyager?version=1.1&operation=searchRetrieve` +
    `&query=bath.isbn=${cleaned}&maximumRecords=1&recordSchema=marcxml`;
  return loFetch050(url, 8000);
}

/**
 * Tier 5: LoC SRU by title + author. Best-effort — the LoC endpoint is
 * occasionally slow/flaky on text queries; tight timeout, fall through
 * silently on miss or timeout.
 */
export async function lookupLccByTitleAuthor(title: string, author: string): Promise<string> {
  const t = (title ?? '').trim();
  const a = (author ?? '').trim();
  if (!t || !a) return '';
  const cql = `bath.title=${JSON.stringify(t)} AND bath.author=${JSON.stringify(a)}`;
  const url =
    `https://lx2.loc.gov/sru/voyager?version=1.1&operation=searchRetrieve` +
    `&query=${encodeURIComponent(cql)}&maximumRecords=1&recordSchema=marcxml`;
  return loFetch050(url, 7000);
}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  isbn?: string[];
  publisher?: string[];
  first_publish_year?: number;
  publish_year?: number[];
  publish_date?: string[];
  lcc?: string[];
  lc_classifications?: string[];
  subject?: string[];
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
        if (res.ok) {
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
            return {
              isbn: cleaned,
              publisher: doc.publisher?.[0] ?? hints.publisher ?? '',
              publicationYear,
              lcc: finalLcc,
              subjects: doc.subject?.slice(0, 10),
              source: 'openlibrary',
            };
          }
        }
      } catch {
        // fall through to year-scoped path
      }
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
          return {
            isbn,
            publisher: best.publisher?.[0] ?? hints.publisher ?? '',
            publicationYear,
            lcc,
            subjects: best.subject?.slice(0, 10),
            source: 'openlibrary',
          };
        }
      }
    } catch {
      // fall through
    }
  }

  // 3) Fall back to the unscoped chain.
  return lookupBook(title, author);
}

const OL_FIELDS =
  'key,title,author_name,isbn,publisher,first_publish_year,publish_year,publish_date,lcc,lc_classifications,subject';

/**
 * Run one Open Library search.json query, score & pick the best matching
 * doc against the (cleaned) title + author, and convert it to a
 * BookLookupResult. Returns null on no match / no usable identifiers /
 * network error — the caller falls through to the next tier.
 */
async function tryOpenLibrary(
  params: URLSearchParams,
  matchTitle: string,
  matchAuthor: string
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
    if (!res.ok) return null;
    const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
    const best = pickBestDoc(data.docs ?? [], matchTitle, matchAuthor);
    if (!best) return null;
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
    if (!lcc && best.key) lcc = await fetchWorkLcc(best.key);
    if (!isbn && !publisher && !lcc && !publicationYear) return null;
    return {
      isbn,
      publisher,
      publicationYear,
      lcc,
      subjects: best.subject?.slice(0, 10),
      source: 'openlibrary',
    };
  } catch {
    return null;
  }
}

export async function lookupBook(
  title: string,
  author: string
): Promise<BookLookupResult & { tier?: string }> {
  if (!title) {
    return { isbn: '', publisher: '', publicationYear: 0, lcc: '', source: 'none' };
  }

  const cleanedAuthor = cleanAuthorForQuery(author);
  const shortTitle = stripSubtitle(title);
  const hadSubtitle = shortTitle !== title.trim();

  let result: BookLookupResult = {
    isbn: '',
    publisher: '',
    publicationYear: 0,
    lcc: '',
    source: 'none',
  };
  let tier = '';

  // Tier 1: full title + cleaned author
  {
    const p = new URLSearchParams();
    p.set('title', title);
    if (cleanedAuthor) p.set('author', cleanedAuthor);
    const r = await tryOpenLibrary(p, title, cleanedAuthor);
    if (r) {
      result = r;
      tier = 'ol-t1';
    }
  }
  // Tier 2: short title (subtitle stripped) + cleaned author
  if (result.source === 'none' && hadSubtitle && cleanedAuthor) {
    const p = new URLSearchParams();
    p.set('title', shortTitle);
    p.set('author', cleanedAuthor);
    const r = await tryOpenLibrary(p, shortTitle, cleanedAuthor);
    if (r) {
      result = r;
      tier = 'ol-t2';
    }
  }
  // Tier 3: short title only (no author — catches OL author-index quirks)
  if (result.source === 'none') {
    const p = new URLSearchParams();
    p.set('title', shortTitle);
    const r = await tryOpenLibrary(p, shortTitle, cleanedAuthor);
    if (r) {
      result = r;
      tier = 'ol-t3';
    }
  }
  // Tier 4: full-text q= (most lenient OL tier)
  if (result.source === 'none') {
    const p = new URLSearchParams();
    p.set('q', `${shortTitle} ${cleanedAuthor}`.trim());
    const r = await tryOpenLibrary(p, shortTitle, cleanedAuthor);
    if (r) {
      result = r;
      tier = 'ol-t4';
    }
  }

  // 5) Google Books fallback (only if Open Library didn't yield a usable result)
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
      res = await fetch(baseUrl, { signal: AbortSignal.timeout(10000), cache: 'no-store', headers: DEFAULT_HEADERS });
    }
    if (res.ok) {
      const data = (await res.json()) as {
        items?: Array<{
          volumeInfo: {
            industryIdentifiers?: { type: string; identifier: string }[];
            publisher?: string;
            publishedDate?: string;
            categories?: string[];
          };
        }>;
      };
      const vi = data.items?.[0]?.volumeInfo;
      if (vi) {
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
      }
    }
  } catch {
    // ignore
  }

  // Final post-processing: canonicalize LCC + LoC SRU enrichment.
  // Track WHERE the LCC came from so the BookCard can show provenance.
  result.lcc = normalizeLcc(result.lcc);
  let lccSource: 'ol' | 'loc' | 'inferred' | 'none' = result.lcc ? 'ol' : 'none';

  // Tier 5a: LoC SRU by ISBN (existing behavior).
  if (result.isbn && !result.lcc) {
    const sruLcc = await lookupLccByIsbn(result.isbn);
    if (sruLcc) {
      result.lcc = normalizeLcc(sruLcc);
      lccSource = 'loc';
    }
  }

  // Tier 5b: LoC SRU by title + author. Catches books with no ISBN.
  if (!result.lcc && title && author) {
    const cleanedAuthor = cleanAuthorForQuery(author);
    const sruLcc = await lookupLccByTitleAuthor(title, cleanedAuthor);
    if (sruLcc) {
      result.lcc = normalizeLcc(sruLcc);
      lccSource = 'loc';
    }
  }

  return Object.assign(result, { tier: tier || 'none', lccSource });
}
