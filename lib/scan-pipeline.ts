/**
 * Barcode-scan pipeline. The user reads an ISBN-13 off a back-cover
 * EAN barcode → we run an ISBN-keyed metadata lookup against Open
 * Library → fall back to Google Books on miss → infer tags → produce
 * a `BookRecord` ready to drop into the live batch.
 *
 * No spine detection, no Pass-B Opus call. The lookup chain reuses
 * the same sources as the photo pipeline (Open Library, Library of
 * Congress SRU for LCC) but keyed on ISBN instead of title/author.
 *
 * Empty-result case: a successfully-read ISBN with no metadata
 * anywhere still produces a BookRecord with the ISBN pre-filled and
 * `confidence: 'LOW'`, plus a warning instructing the user to fill
 * in the rest by hand. Matches the "manually added" path on Review.
 */

import type { BookRecord, Confidence, InferTagsResult } from './types';
import { lookupLccByIsbn, normalizeLcc } from './lookup-utils';
import { inferTagsClient, makeId } from './pipeline';
import { toAuthorLastFirst, toTitleCase } from './csv-export';

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Carnegie/3.0 (https://carnegielib.vercel.app)',
};

interface IsbnLookupResult {
  /** Empty when no source returned a title. The caller treats that
   *  as the no-match path. */
  title: string;
  author: string;
  publisher: string;
  publicationYear: number;
  lcc: string;
  subjects: string[];
  /** Cover URL discovered during lookup (Open Library covers API
   *  preferred; Google Books thumbnail as a fallback). */
  coverUrl: string;
  /** Which source filled in the title — used for the BookRecord's
   *  lookupSource field and for telemetry. */
  source: 'openlibrary' | 'googlebooks' | 'none';
}

interface OpenLibraryDoc {
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

function parsePublishYear(d?: string[]): number {
  if (!d || d.length === 0) return 0;
  for (const s of d) {
    const m = s.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

/**
 * Open Library — primary source. The /search.json?isbn=… endpoint
 * returns the work plus the matching edition's metadata. Cover URL
 * is the deterministic /b/isbn/{isbn}-L.jpg form (no separate
 * roundtrip needed; the Cover component handles 404 fallback).
 */
async function lookupOpenLibrary(isbn: string): Promise<IsbnLookupResult | null> {
  try {
    const url =
      `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}` +
      '&fields=key,title,author_name,isbn,publisher,first_publish_year,publish_year,publish_date,lcc,lc_classifications,subject';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
    const doc = data.docs?.[0];
    if (!doc || !doc.title) return null;

    const lccRaw =
      (doc.lcc && doc.lcc[0]) ||
      (doc.lc_classifications && doc.lc_classifications[0]) ||
      '';
    const lcc = normalizeLcc(lccRaw);
    return {
      title: doc.title,
      author: doc.author_name?.[0] ?? '',
      publisher: doc.publisher?.[0] ?? '',
      publicationYear:
        doc.first_publish_year ||
        (doc.publish_year && doc.publish_year[0]) ||
        parsePublishYear(doc.publish_date) ||
        0,
      lcc,
      subjects: doc.subject?.slice(0, 10) ?? [],
      coverUrl: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
      source: 'openlibrary',
    };
  } catch {
    return null;
  }
}

/**
 * Google Books — fallback. Used when OL has nothing for the ISBN.
 * Cover URL is rewritten to https because GB still serves http for
 * thumbnails which mixed-content-blocks on production.
 */
async function lookupGoogleBooks(isbn: string): Promise<IsbnLookupResult | null> {
  try {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_BOOKS_API_KEY;
    const base = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`;
    const url = apiKey ? `${base}&key=${apiKey}` : base;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{
        volumeInfo: {
          title?: string;
          authors?: string[];
          publisher?: string;
          publishedDate?: string;
          categories?: string[];
          imageLinks?: { thumbnail?: string; smallThumbnail?: string };
        };
      }>;
    };
    const vi = data.items?.[0]?.volumeInfo;
    if (!vi || !vi.title) return null;
    const cover = (vi.imageLinks?.thumbnail || vi.imageLinks?.smallThumbnail || '').replace(
      /^http:\/\//i,
      'https://'
    );
    return {
      title: vi.title,
      author: vi.authors?.[0] ?? '',
      publisher: vi.publisher ?? '',
      publicationYear: vi.publishedDate ? parseInt(vi.publishedDate.slice(0, 4), 10) || 0 : 0,
      lcc: '',
      subjects: vi.categories ?? [],
      coverUrl: cover,
      source: 'googlebooks',
    };
  } catch {
    return null;
  }
}

/**
 * Per-ISBN diagnostic logger for the browser console. Mirrors the
 * server-side lookup logger in book-lookup.ts so a barcode scan emits
 * a grep-able tier trace in the user's devtools. Default on; set
 * NEXT_PUBLIC_VERBOSE_LOOKUP=0 to silence.
 */
function dlog(isbn: string, stage: string, msg: string): void {
  if (typeof window === 'undefined') return;
  if (process.env.NEXT_PUBLIC_VERBOSE_LOOKUP === '0') return;
  // eslint-disable-next-line no-console
  console.log(`[lookup-isbn ${isbn}]   ${stage.padEnd(16)} ${msg}`);
}

/**
 * Final-tier fallback for ISBN scans: hit /api/lookup-book with
 * matchEdition:true so the request runs through lookupSpecificEdition
 * server-side, which falls through to ISBNdb-direct (/book/{isbn})
 * when OL misses. Without this tier the barcode pipeline silently
 * skipped ISBNdb — the very source most likely to have edition-level
 * data for a recent printing — leaving the user with a half-empty
 * record despite a perfectly valid ISBN.
 */
async function lookupViaServer(isbn: string): Promise<IsbnLookupResult | null> {
  try {
    const res = await fetch('/api/lookup-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '',
        author: '',
        matchEdition: true,
        hints: { isbn },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      isbn?: string;
      publisher?: string;
      publicationYear?: number;
      lcc?: string;
      subjects?: string[];
      coverUrl?: string;
      source?: 'openlibrary' | 'googlebooks' | 'isbndb' | 'none';
    };
    if (!data || data.source === 'none' || !(data.isbn || data.publisher || data.publicationYear)) {
      return null;
    }
    // The IsbnLookupResult union doesn't include 'isbndb' — collapse it
    // to 'openlibrary' as the closest representative of "the server
    // lookup chain found something" so existing UI labeling still works.
    const narrowedSource: 'openlibrary' | 'googlebooks' | 'none' =
      data.source === 'isbndb' || data.source === 'openlibrary'
        ? 'openlibrary'
        : data.source === 'googlebooks'
          ? 'googlebooks'
          : 'none';
    return {
      // /api/lookup-book doesn't return a title field today; the ISBNdb
      // direct path on the server has it but the BookLookupResult type
      // omits it. Pre-fill empty for now — the caller fills the title
      // from a separate ISBNdb call when needed, or the user types it.
      title: '',
      author: '',
      publisher: data.publisher ?? '',
      publicationYear: data.publicationYear ?? 0,
      lcc: data.lcc ?? '',
      subjects: data.subjects ?? [],
      coverUrl:
        data.coverUrl ?? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
      source: narrowedSource,
    };
  } catch {
    return null;
  }
}

/**
 * Public entry point: ISBN → metadata. Tries Open Library first,
 * falls back to Google Books, then to the server-side lookup chain
 * (which adds ISBNdb-direct via lookupSpecificEdition). LoC SRU then
 * fills in LCC if no tier produced one. Returns `source: 'none'` when
 * nothing matched at all — the caller still builds a BookRecord (with
 * the ISBN pre-filled) so the user can complete it on Review.
 */
export async function lookupBookByIsbn(isbn: string): Promise<IsbnLookupResult> {
  const cleaned = isbn.replace(/[^\dxX]/g, '').toUpperCase();
  if (cleaned.length !== 10 && cleaned.length !== 13) {
    dlog(isbn, 'input', `invalid length ${cleaned.length} — skipping`);
    return {
      title: '',
      author: '',
      publisher: '',
      publicationYear: 0,
      lcc: '',
      subjects: [],
      coverUrl: '',
      source: 'none',
    };
  }
  dlog(cleaned, 'start', `lookupBookByIsbn`);
  let hit = await lookupOpenLibrary(cleaned);
  if (hit) {
    dlog(cleaned, 'ol-by-isbn', `matched title=${JSON.stringify(hit.title)} author=${JSON.stringify(hit.author)} pub=${JSON.stringify(hit.publisher)} year=${hit.publicationYear || '-'}`);
  } else {
    dlog(cleaned, 'ol-by-isbn', 'miss — trying Google Books');
    hit = await lookupGoogleBooks(cleaned);
    if (hit) {
      dlog(cleaned, 'gb-by-isbn', `matched title=${JSON.stringify(hit.title)} author=${JSON.stringify(hit.author)}`);
    } else {
      dlog(cleaned, 'gb-by-isbn', 'miss — trying server lookup chain (ISBNdb-direct)');
      // Server-side fallback unlocks ISBNdb-direct, which is the gap
      // the previous client-only flow left wide open.
      const server = await lookupViaServer(cleaned);
      if (server) {
        dlog(cleaned, 'server', `matched (source=${server.source}) pub=${JSON.stringify(server.publisher)} year=${server.publicationYear || '-'}`);
        hit = server;
      } else {
        dlog(cleaned, 'server', 'miss — all tiers exhausted');
      }
    }
  }
  if (!hit) {
    dlog(cleaned, 'result', 'source=none (no metadata anywhere)');
    return {
      title: '',
      author: '',
      publisher: '',
      publicationYear: 0,
      lcc: '',
      subjects: [],
      coverUrl: '',
      source: 'none',
    };
  }
  if (!hit.lcc) {
    try {
      const lcc = normalizeLcc(await lookupLccByIsbn(cleaned)) || '';
      hit.lcc = lcc;
      if (lcc) dlog(cleaned, 'loc-sru', `lcc=${JSON.stringify(lcc)}`);
      else dlog(cleaned, 'loc-sru', 'no LCC');
    } catch {
      // ignore — LCC stays empty
    }
  }
  dlog(
    cleaned,
    'result',
    `source=${hit.source} title=${JSON.stringify(hit.title)} pub=${JSON.stringify(hit.publisher)} year=${hit.publicationYear || '-'} lcc=${JSON.stringify(hit.lcc || '')}`
  );
  return hit;
}

/**
 * Optional snapshot of the preview-card hit the scanner already
 * resolved against /api/preview-isbn while the user was deciding. The
 * preview's coverUrl was already rendered (and confirmed by the user's
 * eyes), so it's the most reliable cover candidate we have. The
 * rebuild path's own lookup may pick a different URL or come up empty.
 */
export interface IsbnScanPreviewSeed {
  title: string;
  author: string;
  coverUrl: string;
  source: 'isbndb' | 'openlibrary';
}

interface ProcessIsbnArgs {
  isbn: string;
  /** Position number assigned to the synthetic spine read. The Review
   *  table sorts by this so multiple scanned books appear in scan order. */
  position: number;
  /** Inherited from the active batch (set on the page-level inputs). */
  batchLabel?: string;
  batchNotes?: string;
  sourcePhoto?: string;
  /** Preview-card hit captured at the moment the user tapped "Use this
   *  ISBN." Used as a cover seed: takes the primary slot when the
   *  rebuild path produces no cover, or falls into the fallback chain
   *  when the rebuild path picked a different URL. */
  previewResult?: IsbnScanPreviewSeed | null;
}

/**
 * Run the ISBN lookup + tag inference and return a BookRecord ready
 * for `addBook(batchId, book)`. Empty-result case still returns a
 * record with the ISBN pre-filled, `confidence: 'LOW'`, and a
 * warning so the user knows to complete it manually.
 */
export async function processIsbnScan(args: ProcessIsbnArgs): Promise<BookRecord> {
  const cleanedIsbn = args.isbn.replace(/[^\dxX]/g, '').toUpperCase();
  const lookup = await lookupBookByIsbn(cleanedIsbn);

  let tags: InferTagsResult = {
    genreTags: [],
    formTags: [],
    confidence: 'LOW',
    reasoning: '',
  };
  if (lookup.title) {
    tags = await inferTagsClient({
      title: lookup.title,
      author: lookup.author,
      isbn: cleanedIsbn,
      publisher: lookup.publisher,
      publicationYear: lookup.publicationYear,
      lcc: lookup.lcc,
      subjectHeadings: lookup.subjects,
    });
  }

  const noMatch = lookup.source === 'none' || !lookup.title;
  const confidence: Confidence = noMatch
    ? 'LOW'
    : lookup.lcc
      ? tags.confidence
      : 'MEDIUM'; // looked up cleanly but no LCC — slight downgrade

  const warnings: string[] = [];
  if (noMatch) {
    warnings.push(
      `Barcode ${cleanedIsbn} read but no metadata match in any source — fill in title/author manually.`
    );
  } else if (!lookup.lcc) {
    warnings.push('No LCC found for this edition — tag inference fell back to subject headings only.');
  }

  const titleClean = lookup.title ? toTitleCase(lookup.title.trim()) : '';
  const authorClean = lookup.author?.trim() ?? '';

  // Cover-resolution policy:
  //   1. If the lookup produced a coverUrl, that wins the primary slot
  //      and the preview's URL (when present + different) goes into
  //      coverUrlFallbacks so <Cover>'s onError chain can fall through.
  //   2. If the lookup didn't, the preview's URL (when present) takes
  //      the primary slot. The user already saw it load on the confirm
  //      card, so it's the most reliable bet.
  const previewCover = args.previewResult?.coverUrl?.trim() || '';
  const lookupCover = lookup.coverUrl?.trim() || '';
  let coverUrl: string | undefined;
  let coverUrlFallbacks: string[] | undefined;
  if (lookupCover) {
    coverUrl = lookupCover;
    if (previewCover && previewCover !== lookupCover) {
      coverUrlFallbacks = [previewCover];
    }
  } else if (previewCover) {
    coverUrl = previewCover;
  }

  return {
    id: makeId(),
    spineRead: {
      position: args.position,
      rawText: `[scanned ISBN ${cleanedIsbn}]`,
      title: titleClean,
      author: authorClean,
      publisher: lookup.publisher,
      confidence: noMatch ? 'LOW' : 'HIGH',
    },
    title: titleClean,
    author: authorClean,
    authorLF: authorClean ? toAuthorLastFirst(authorClean) : '',
    isbn: cleanedIsbn,
    publisher: lookup.publisher,
    publicationYear: lookup.publicationYear,
    lcc: lookup.lcc,
    genreTags: tags.genreTags,
    formTags: tags.formTags,
    confidence,
    reasoning: tags.reasoning,
    status: 'pending',
    warnings,
    sourcePhoto: args.sourcePhoto ?? `barcode-scan-${cleanedIsbn}`,
    batchLabel: args.batchLabel,
    batchNotes: args.batchNotes,
    lookupSource: lookup.source,
    lccSource: lookup.lcc ? 'ol' : 'none',
    coverUrl,
    coverUrlFallbacks,
    scannedFromBarcode: true,
    original: {
      title: titleClean,
      author: authorClean,
      isbn: cleanedIsbn,
      publisher: lookup.publisher,
      publicationYear: lookup.publicationYear,
      lcc: lookup.lcc,
      genreTags: tags.genreTags,
      formTags: tags.formTags,
    },
  };
}
