/**
 * Smoke tests for assembleBookRecord (lib/assemble.ts).
 *
 * Coverage in v1:
 *   1. Fresh assembly from spine + lookup produces a complete BookRecord
 *      with provenance.
 *   2. Reread merge preserves user-edit provenance — fields the user
 *      previously edited keep their value AND their 'user-edit' source
 *      against fresh-lookup data.
 *   3. Manual entry stamps user-edit provenance on typed fields.
 *   4. Retag preserves all non-tag fields when called with the prior
 *      record's data.
 *
 * fetch is stubbed to return an empty 200 for /api/infer-lcc — the LCC
 * fallback fires only when LCC is empty/partial AND title+author are
 * set; tests choose lookup data with complete LCC so the fallback is
 * a no-op in practice. The stub is defensive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookLookupResult, BookRecord, InferTagsResult, SpineRead } from '@/lib/types';
import { assembleBookRecord } from '@/lib/assemble';

beforeEach(() => {
  // Stub fetch — assembleBookRecord only ever calls /api/infer-lcc
  // internally; tests don't need the model actually firing, so an
  // empty 200 makes the fallback a no-op when it does run.
  vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ lcc: '', confidence: 'LOW' }), { status: 200 })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseLookup: BookLookupResult = {
  isbn: '9780141398990',
  publisher: 'Penguin Classics',
  publicationYear: 2015,
  lcc: 'PS3513.I74 A6 2015',
  source: 'openlibrary',
  canonicalTitle: 'The Essential Ginsberg',
  canonicalAuthor: 'Allen Ginsberg',
  allAuthors: ['Allen Ginsberg'],
  lccSource: 'ol',
};
// In production, book-lookup.ts attaches a `__provenance` map onto
// the result via Object.assign before returning. Mirror that here so
// assembleBookRecord sees what it expects to see.
(baseLookup as unknown as { __provenance: Record<string, unknown> }).__provenance = {
  isbn: { source: 'openlibrary', timestamp: '2026-05-06T00:00:00Z' },
  publisher: { source: 'openlibrary', timestamp: '2026-05-06T00:00:00Z' },
  publicationYear: { source: 'openlibrary', timestamp: '2026-05-06T00:00:00Z' },
  lcc: { source: 'openlibrary', timestamp: '2026-05-06T00:00:00Z' },
  canonicalTitle: { source: 'openlibrary', timestamp: '2026-05-06T00:00:00Z' },
  allAuthors: { source: 'openlibrary', timestamp: '2026-05-06T00:00:00Z' },
};

const baseSpineRead: SpineRead = {
  position: 1,
  rawText: 'The Essential Ginsberg — Allen Ginsberg',
  title: 'The Essential Ginsberg',
  author: 'Allen Ginsberg',
  publisher: 'Penguin Classics',
  lcc: '',
  confidence: 'HIGH',
};

const baseTags: InferTagsResult = {
  genreTags: ['Beat poetry'],
  formTags: ['Anthology'],
  confidence: 'HIGH',
  reasoning: 'LCC PS3513 places this in American literature; Beat-era anthology.',
};

describe('assembleBookRecord — fresh capture', () => {
  it('produces a complete BookRecord from spine + lookup', async () => {
    const book = await assembleBookRecord({
      lookup: { ...baseLookup },
      spineRead: baseSpineRead,
      spineFields: {
        title: baseSpineRead.title,
        author: baseSpineRead.author,
        publisher: baseSpineRead.publisher,
        lcc: baseSpineRead.lcc,
        confidence: baseSpineRead.confidence,
      },
      tags: baseTags,
      finalLcc: 'PS3513.I74 A6 2015',
      lccSource: 'ol',
      groundedConfidence: 'HIGH',
      warnings: [],
      sourcePhoto: 'shelf-1.jpg',
      batchLabel: 'Living room shelf',
    });

    expect(book.title).toBe('The Essential Ginsberg');
    expect(book.author).toBe('Allen Ginsberg');
    expect(book.authorLF).toBe('Ginsberg, Allen');
    expect(book.isbn).toBe('9780141398990');
    expect(book.publisher).toBe('Penguin Classics');
    expect(book.publicationYear).toBe(2015);
    expect(book.lcc).toBe('PS3513.I74 A6 2015');
    expect(book.lccSource).toBe('ol');
    expect(book.confidence).toBe('HIGH');
    expect(book.status).toBe('pending');
    expect(book.batchLabel).toBe('Living room shelf');
    expect(book.provenance?.title?.source).toBeTruthy();
    expect(book.provenance?.lcc?.source).toBe('openlibrary');
    expect(book.provenance?.authorLF?.source).toBe('derived');
    // Original snapshot present.
    expect(book.original.title).toBe(book.title);
    expect(book.original.lcc).toBe(book.lcc);
  });
});

describe('assembleBookRecord — Reread merge', () => {
  it('preserves user-edited title against a fresh lookup', async () => {
    const priorRecord: BookRecord = {
      id: 'prior-id',
      spineRead: baseSpineRead,
      title: 'My Custom Title',
      author: 'Allen Ginsberg',
      authorLF: 'Ginsberg, Allen',
      isbn: '9780141398990',
      publisher: 'Penguin Classics',
      publicationYear: 2015,
      lcc: 'PS3513.I74 A6 2015',
      genreTags: ['Beat poetry'],
      formTags: ['Anthology'],
      confidence: 'HIGH',
      reasoning: '',
      status: 'pending',
      warnings: [],
      sourcePhoto: 'shelf-1.jpg',
      lookupSource: 'openlibrary',
      lccSource: 'ol',
      provenance: {
        title: { source: 'user-edit', timestamp: '2026-04-01T00:00:00Z' },
        author: { source: 'openlibrary', timestamp: '2026-04-01T00:00:00Z' },
        lcc: { source: 'openlibrary', timestamp: '2026-04-01T00:00:00Z' },
      },
      original: {
        title: 'The Essential Ginsberg',
        author: 'Allen Ginsberg',
        isbn: '9780141398990',
        publisher: 'Penguin Classics',
        publicationYear: 2015,
        lcc: 'PS3513.I74 A6 2015',
      },
    };

    const book = await assembleBookRecord({
      lookup: { ...baseLookup, canonicalTitle: 'The Essential Ginsberg' },
      spineRead: baseSpineRead,
      spineFields: {
        title: baseSpineRead.title,
        author: baseSpineRead.author,
        publisher: baseSpineRead.publisher,
        lcc: baseSpineRead.lcc,
        confidence: baseSpineRead.confidence,
      },
      tags: baseTags,
      finalLcc: 'PS3513.I74 A6 2015',
      lccSource: 'ol',
      groundedConfidence: 'HIGH',
      warnings: [],
      sourcePhoto: 'shelf-1.jpg',
      priorRecord,
    });

    // User-edited title preserved.
    expect(book.title).toBe('My Custom Title');
    expect(book.provenance?.title?.source).toBe('user-edit');
    // Non-edited fields refreshed.
    expect(book.author).toBe('Allen Ginsberg');
    expect(book.lcc).toBe('PS3513.I74 A6 2015');
    // ID and original snapshot inherit from priorRecord.
    expect(book.id).toBe('prior-id');
    expect(book.original.title).toBe('The Essential Ginsberg');
  });
});

describe('assembleBookRecord — manual entry', () => {
  it('stamps user-edit provenance on typed title/author/isbn', async () => {
    const book = await assembleBookRecord({
      // Manual entries land with a "found nothing" lookup. The
      // overrides are what populate the record.
      lookup: {
        isbn: '',
        publisher: '',
        publicationYear: 0,
        lcc: '',
        source: 'none',
      },
      spineFields: {},
      tags: {
        genreTags: [],
        formTags: [],
        confidence: 'LOW',
        reasoning: '',
      },
      groundedConfidence: 'LOW',
      warnings: ['Manual entry — no metadata match.'],
      sourcePhoto: 'manual',
      manualOverrides: {
        title: 'Hand-Typed Title',
        author: 'Some Author',
        isbn: '9999999999999',
      },
      finalLcc: '',
      lccSource: 'none',
      manuallyAdded: true,
    });

    expect(book.title).toBe('Hand-Typed Title');
    expect(book.author).toBe('Some Author');
    expect(book.isbn).toBe('9999999999999');
    expect(book.manuallyAdded).toBe(true);
    expect(book.provenance?.title?.source).toBe('user-edit');
    expect(book.provenance?.author?.source).toBe('user-edit');
    expect(book.provenance?.isbn?.source).toBe('user-edit');
  });
});

describe('assembleBookRecord — retag path', () => {
  it('preserves all non-tag fields when lookup mirrors prior record', async () => {
    const priorRecord: BookRecord = {
      id: 'prior-id',
      spineRead: baseSpineRead,
      title: 'The Essential Ginsberg',
      author: 'Allen Ginsberg',
      authorLF: 'Ginsberg, Allen',
      isbn: '9780141398990',
      publisher: 'Penguin Classics',
      publicationYear: 2015,
      lcc: 'PS3513.I74 A6 2015',
      genreTags: ['OldTag'],
      formTags: ['OldForm'],
      confidence: 'HIGH',
      reasoning: 'old reasoning',
      status: 'pending',
      warnings: [],
      sourcePhoto: 'shelf-1.jpg',
      lookupSource: 'openlibrary',
      lccSource: 'ol',
      provenance: {
        title: { source: 'openlibrary', timestamp: '2026-04-01T00:00:00Z' },
      },
      original: {
        title: 'The Essential Ginsberg',
        author: 'Allen Ginsberg',
        isbn: '9780141398990',
        publisher: 'Penguin Classics',
        publicationYear: 2015,
        lcc: 'PS3513.I74 A6 2015',
        genreTags: ['OldTag'],
        formTags: ['OldForm'],
      },
    };

    // Retag: reuse priorRecord's lookup-shaped data, supply NEW tags.
    const lookupFromPrior: BookLookupResult = {
      isbn: priorRecord.isbn,
      publisher: priorRecord.publisher,
      publicationYear: priorRecord.publicationYear,
      lcc: priorRecord.lcc,
      source: priorRecord.lookupSource as 'openlibrary',
      canonicalTitle: priorRecord.title,
      canonicalAuthor: priorRecord.author,
      lccSource: 'ol',
    };
    const newTags: InferTagsResult = {
      genreTags: ['NewTag'],
      formTags: ['NewForm'],
      confidence: 'HIGH',
      reasoning: 'fresh inference',
    };

    const book = await assembleBookRecord({
      lookup: lookupFromPrior,
      spineRead: priorRecord.spineRead,
      spineFields: {
        title: priorRecord.spineRead.title,
        author: priorRecord.spineRead.author,
      },
      tags: newTags,
      finalLcc: 'PS3513.I74 A6 2015',
      lccSource: 'ol',
      groundedConfidence: 'HIGH',
      warnings: [],
      sourcePhoto: priorRecord.sourcePhoto,
      priorRecord,
    });

    // Non-tag fields unchanged.
    expect(book.id).toBe('prior-id');
    expect(book.title).toBe('The Essential Ginsberg');
    expect(book.author).toBe('Allen Ginsberg');
    expect(book.lcc).toBe('PS3513.I74 A6 2015');
    expect(book.isbn).toBe('9780141398990');
    expect(book.publisher).toBe('Penguin Classics');
    // Tags updated.
    expect(book.genreTags).toContain('NewTag');
    expect(book.formTags).toContain('NewForm');
    expect(book.genreTags).not.toContain('OldTag');
    // Original snapshot inherited (NOT regenerated from new tags).
    expect(book.original.genreTags).toEqual(['OldTag']);
  });
});
