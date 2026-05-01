export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface SpineBbox {
  x: number; // 0–100, percent of image width
  y: number;
  width: number;
  height: number;
}

export interface SpineRead {
  position: number;
  rawText: string;
  title?: string;
  author?: string;
  publisher?: string;
  /** LCC read directly from the physical spine (canonical format), if visible. */
  lcc?: string;
  confidence: Confidence;
  note?: string;
  bbox?: SpineBbox;
}

export interface BookLookupResult {
  isbn: string;
  publisher: string;
  publicationYear: number;
  lcc: string;
  subjects?: string[];
  /** Dewey Decimal Classification, when a tier surfaced one (ISBNdb, Wikidata). */
  ddc?: string;
  source: 'openlibrary' | 'googlebooks' | 'isbndb' | 'none';
  /** Where in the cascade the LCC came from. Set by lookupBook post-processing. */
  lccSource?: 'ol' | 'loc' | 'wikidata' | 'inferred' | 'none';
}

export interface BookRecord {
  id: string;
  spineRead: SpineRead;
  title: string;
  author: string;
  authorLF: string;
  isbn: string;
  publisher: string;
  publicationYear: number;
  lcc: string;
  genreTags: string[];
  formTags: string[];
  confidence: Confidence;
  reasoning: string;
  status: 'pending' | 'approved' | 'rejected';
  warnings: string[];
  sourcePhoto: string;
  /** Optional location label (e.g., "Shelf 3") inherited from the parent PhotoBatch. */
  batchLabel?: string;
  /** Free-form notes set at upload time and inherited by every book in the batch. */
  batchNotes?: string;
  /** Free-form per-book notes editable on the BookCard. Goes into LT's COMMENTS column. */
  notes?: string;
  /** True when the user added this book via "Add missing book" rather than auto-detection. */
  manuallyAdded?: boolean;
  lookupSource: 'openlibrary' | 'googlebooks' | 'isbndb' | 'none';
  /** Dewey Decimal Classification, when a tier surfaced one. */
  ddc?: string;
  /**
   * Where the LCC came from, in priority order:
   * - 'spine'    : read directly off the physical book (most authoritative)
   * - 'loc'      : Library of Congress SRU
   * - 'wikidata' : Wikidata SPARQL (free LCC gap-filler)
   * - 'ol'       : Open Library's per-edition LCC field (default; no badge)
   * - 'inferred' : Anthropic model best-guess (least authoritative)
   * - 'none'     : no LCC available
   */
  lccSource: 'spine' | 'loc' | 'wikidata' | 'ol' | 'inferred' | 'lookup' | 'none';
  /** Cropped image of just this spine, as a data URI. Lets the reviewer see what the model saw. */
  spineThumbnail?: string;
  /** Higher-resolution OCR-quality crop, used by "Reread spine". Not persisted to localStorage. */
  ocrImage?: string;
  /** Which model performed Pass B for this spine: 's' (Sonnet) or 'o' (Opus). */
  ocrModel?: 's' | 'o';
  /** True while a reread is in flight, so the BookCard can disable controls + show a spinner. */
  rereading?: boolean;
  /** True while a bulk re-tag is in flight, so the BookCard can flash on completion. */
  retagging?: boolean;
  /**
   * Set when this book matches an entry in the export ledger — meaning it was
   * shipped to LibraryThing in a prior session. Drives a warning banner on
   * the BookCard and auto-rejects the row by default. The user can still
   * approve to export a second copy.
   */
  previouslyExported?: { date: string; batchLabel?: string };
  /**
   * Stable id shared across books that look like duplicates of each other in
   * the same batch. Set by flagDuplicates during processing. While set and
   * `duplicateResolved` is undefined, the BookCard shows a banner with
   * Merge / Keep-both actions instead of silently merging.
   */
  duplicateGroup?: string;
  /** Spine positions of the OTHER books in the same duplicate group — for the banner copy. */
  duplicateOf?: number[];
  /**
   * What the user decided about this duplicate group:
   *   'merged'   — siblings were folded into this record; their snapshots live in `mergedFrom`.
   *   'kept-both'— user accepted both as legitimate separate copies.
   * Undefined while the group is still pending review.
   */
  duplicateResolved?: 'merged' | 'kept-both';
  /**
   * When the user merges duplicates, the losing entries are stashed here as
   * full snapshots so Unmerge can restore them. Undefined / empty for books
   * that have never been merged.
   */
  mergedFrom?: BookRecord[];
  /** Snapshot of metadata as it came from spine read + lookup, before any user edits. */
  original: {
    title: string;
    author: string;
    isbn: string;
    publisher: string;
    publicationYear: number;
    lcc: string;
    /** Tags as first inferred. Used by Bulk re-tag to detect manual edits. */
    genreTags?: string[];
    formTags?: string[];
  };
}

export interface PhotoBatch {
  id: string;
  filename: string;
  fileSize: number;
  thumbnail: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  error?: string;
  spinesDetected: number;
  booksIdentified: number;
  books: BookRecord[];
  /** Optional location label set at upload time (e.g., "Shelf 3"). */
  batchLabel?: string;
  /** Free-form notes set at upload time, inherited by every book in this batch. */
  batchNotes?: string;
}

export interface AppState {
  batches: PhotoBatch[];
  allBooks: BookRecord[];
}

export interface InferTagsResult {
  genreTags: string[];
  formTags: string[];
  confidence: Confidence;
  reasoning: string;
}
