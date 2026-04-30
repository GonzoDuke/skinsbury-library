import type { BookLookupResult } from './types';

const UA = 'Skinsbury-Library/1.0 (personal cataloging tool)';
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json',
};

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

function titleExactMatch(query: string, candidate?: string): boolean {
  if (!candidate) return false;
  return normalize(query) === normalize(candidate);
}

function titleSubstringMatch(query: string, candidate?: string): boolean {
  if (!candidate) return false;
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return false;
  return c === q || c.startsWith(q + ' ') || c.endsWith(' ' + q) || c.includes(' ' + q + ' ');
}

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

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
  if (authorLastNameMatch(author, d.author_name)) s += 2;
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

  // Restrict to docs whose title or author at least partially matches —
  // protects against off-target relevance hits.
  const relevant = candidates.filter(
    (d) =>
      titleSubstringMatch(title, d.title) ||
      (author && authorLastNameMatch(author, d.author_name))
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

export async function lookupBook(
  title: string,
  author: string
): Promise<BookLookupResult> {
  if (!title) {
    return { isbn: '', publisher: '', publicationYear: 0, lcc: '', source: 'none' };
  }

  // 1) Open Library
  try {
    const params = new URLSearchParams();
    params.set('title', title);
    if (author) params.set('author', author);
    params.set('limit', '10');
    // Ask for the fields we actually need; default search.json omits isbn/publisher/lcc.
    params.set(
      'fields',
      'key,title,author_name,isbn,publisher,first_publish_year,publish_year,publish_date,lcc,lc_classifications,subject'
    );
    const url = `https://openlibrary.org/search.json?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000), cache: 'no-store', headers: DEFAULT_HEADERS });
    if (res.ok) {
      const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
      const best = pickBestDoc(data.docs ?? [], title, author);
      if (best) {
        const isbn = pickIsbn(best.isbn);
        const publisher = best.publisher?.[0] ?? '';
        // Prefer first_publish_year (work-level original), fall back to publish_date earliest, then publish_year.
        const publicationYear =
          best.first_publish_year ||
          parsePublishDateYear(best.publish_date) ||
          (best.publish_year && best.publish_year[0]) ||
          0;
        let lcc =
          (best.lcc && best.lcc[0]) ??
          (best.lc_classifications && best.lc_classifications[0]) ??
          '';
        // 2d. If LCC missing, try the work-level endpoint.
        if (!lcc && best.key) {
          lcc = await fetchWorkLcc(best.key);
        }
        if (isbn || publisher || lcc || publicationYear) {
          return {
            isbn,
            publisher,
            publicationYear,
            lcc,
            subjects: best.subject?.slice(0, 10),
            source: 'openlibrary',
          };
        }
      }
    }
  } catch {
    // fall through to Google Books
  }

  // 2) Google Books fallback
  try {
    const q = `intitle:${encodeURIComponent(title)}${
      author ? `+inauthor:${encodeURIComponent(author)}` : ''
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

        // Enrich from Open Library work-level data via ISBN lookup —
        // gives us first_publish_year (e.g., 1942 for Camus' The Stranger)
        // and LCC code, both of which Google Books does not provide.
        const enriched = await enrichFromIsbn(isbn);
        const publicationYear =
          enriched.firstPublishYear || (Number.isFinite(editionYear) ? editionYear : 0);

        return {
          isbn,
          publisher,
          publicationYear,
          lcc: enriched.lcc,
          subjects: vi.categories ?? [],
          source: 'googlebooks',
        };
      }
    }
  } catch {
    // ignore
  }

  return { isbn: '', publisher: '', publicationYear: 0, lcc: '', source: 'none' };
}
