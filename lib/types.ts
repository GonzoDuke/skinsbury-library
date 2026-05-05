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
  // ---------------------------------------------------------------------
  // Pass B sticker extractions. All optional — the read-spine prompt
  // returns each only when clearly visible. The pipeline plumbs these
  // forward as authoritative signals (extractedCallNumber overrides
  // network LCC/DDC; extractedSeries informs form-tag inference).
  // ---------------------------------------------------------------------
  /** Raw call-number sticker text. Empty when no sticker visible. */
  extractedCallNumber?: string;
  /** Classification system the sticker uses. */
  extractedCallNumberSystem?: 'lcc' | 'ddc' | 'unknown';
  /** Edition statement printed on the spine ("1st ed.", "Rev. ed."). */
  extractedEdition?: string;
  /** Publisher-series indicator ("Penguin Classics", "Library of America"). */
  extractedSeries?: string;
}

export interface BookLookupResult {
  isbn: string;
  publisher: string;
  publicationYear: number;
  lcc: string;
  subjects?: string[];
  /** Dewey Decimal Classification, when a tier surfaced one (ISBNdb, Wikidata). */
  ddc?: string;
  /**
   * LCC class letter derived from `ddc` via the static DDC→LCC
   * crosswalk in `lib/ddc-to-lcc.json`. Populated only when no network
   * tier produced an authoritative LCC. Class-letter only (e.g. "PR",
   * "QA", "BJ") — not a full call number. Tag inference uses it as a
   * domain anchor when `lcc` is empty; the Review surface flags it
   * distinctly from a sourced LCC so the reviewer knows which is which.
   */
  lccDerivedFromDdc?: string;
  /**
   * LCC class letter derived from the user's own export ledger — the
   * dominant class letter across other books by the same author the
   * user has previously approved + exported. Populated only when no
   * authoritative LCC and no DDC-derived class letter were found AND
   * the ledger contains ≥3 books by the same author. Class-letter only.
   * Distinctly personalized — equivalent confidence to `lccDerivedFromDdc`
   * but signal comes from the user's collection, not a static table.
   */
  lccDerivedFromAuthorPattern?: string;
  source: 'openlibrary' | 'googlebooks' | 'isbndb' | 'none';
  /** Where in the cascade the LCC came from. Set by lookupBook post-processing. */
  lccSource?: 'ol' | 'loc' | 'wikidata' | 'inferred' | 'none';
  /**
   * URL to the book's cover art when one was discovered. Primary source is
   * the Open Library Covers API keyed by ISBN; fallbacks are the Google
   * Books `imageLinks.thumbnail` and the ISBNdb `image` field. The cover
   * is best-effort — the BookCard falls back to the spine crop on
   * <img> error or when this field is empty.
   */
  coverUrl?: string;

  // -------------------------------------------------------------------------
  // Optional enrichment fields (Phase 1 of the enrichment plan). All
  // optional + default-undefined so old localStorage / GitHub records
  // without these keep deserializing without a hitch. Nothing reads any
  // of these yet — Phase 2 commits populate them; Phase 3 commits use
  // them downstream.
  // -------------------------------------------------------------------------
  canonicalTitle?: string;
  canonicalAuthor?: string;
  allAuthors?: string[];
  subtitle?: string;
  synopsis?: string;
  pageCount?: number;
  edition?: string;
  binding?: string;
  language?: string;
  series?: string;
  lcshSubjects?: string[];
  /**
   * MARC field 655 (Index Term — Genre/Form). Cataloger-applied
   * explicit genre/form vocabulary (e.g. "Detective and mystery
   * fiction", "Bildungsromans", "Festschriften", "Cookbooks"). Distinct
   * from LCSH (600/610/611/630/650/651): LCSH covers subject content,
   * 655 covers what KIND of work it is. Capped at 15.
   */
  marcGenres?: string[];
  coverUrlFallbacks?: string[];
}

/**
 * Origin tag for a field's provenance entry. Reuses the same vocabulary
 * the verbose-lookup trace already speaks ("openlibrary", "isbndb",
 * "marc", "wikidata", "googlebooks") so log lines and persisted
 * provenance match by value. The Sonnet origins are explicit ("sonnet-…")
 * so a glance at the stored data tells you whether a field was
 * AI-guessed vs. AI-vision-read off a spine.
 */
export type SourceTag =
  | 'openlibrary'
  | 'isbndb'
  | 'marc'
  | 'wikidata'
  | 'googlebooks'
  | 'loc-sru'
  | 'sonnet-infer-lcc'
  | 'sonnet-identify'
  | 'spine-read'
  | 'user-edit'
  | 'derived';

/**
 * Source attribution for a single field on a BookRecord. `alternates`
 * holds prior values from other sources when they disagreed with the
 * winner — prior winners get demoted here on overwrite so the audit
 * trail isn't lost.
 */
export interface FieldProvenance {
  source: SourceTag;
  /** ISO 8601 timestamp the value was assembled / stamped. */
  timestamp: string;
  /** Other sources' values for the same field, when they disagreed. */
  alternates?: Array<{ source: SourceTag; value: unknown }>;
}

/**
 * Per-field provenance map keyed by BookRecord field name. Optional —
 * absence on legacy records is fine; new lookups + Rereads populate it.
 * Field names tracked: title, canonicalTitle, author, authorLF,
 * allAuthors, isbn, publisher, publicationYear, lcc, ddc, pageCount,
 * edition, binding, language, synopsis, lcshSubjects, subjects,
 * coverUrl. (See PROVENANCE_FIELDS in lib/provenance.ts for the
 * canonical list used by the user-edit auto-stamper.)
 */
export type BookRecordProvenance = Partial<Record<string, FieldProvenance>>;

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
  /**
   * True when this record came from the barcode-scan flow (ISBN read
   * directly off an EAN-13 → ISBN-keyed lookup → tag inference). Used
   * to surface a "Scanned" badge on the Review surfaces in place of
   * the spine thumbnail. Cover URL serves as the visual either way.
   */
  scannedFromBarcode?: boolean;
  lookupSource: 'openlibrary' | 'googlebooks' | 'isbndb' | 'none';
  /** Dewey Decimal Classification, when a tier surfaced one. */
  ddc?: string;
  /**
   * LCC class letter derived from DDC when no network tier produced an
   * authoritative LCC. Class-letter only — used by tag inference as a
   * domain anchor and surfaced distinctly in Review.
   */
  lccDerivedFromDdc?: string;
  /**
   * LCC class letter derived from the user's own export ledger. See
   * BookLookupResult.lccDerivedFromAuthorPattern for full semantics.
   */
  lccDerivedFromAuthorPattern?: string;
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
  /**
   * URL to the book's cover art, sourced during the lookup step. Primary:
   * Open Library Covers API by ISBN. Fallbacks: Google Books and ISBNdb.
   * BookCard renders this in place of the spine crop and falls back to the
   * crop on <img> error or when the field is empty.
   */
  coverUrl?: string;
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
  // -------------------------------------------------------------------------
  // Optional enrichment fields (Phase 1). All optional + default-undefined
  // so older serialized records load fine. Phase 3 commits surface these
  // in the UI / tag inference.
  // -------------------------------------------------------------------------
  canonicalTitle?: string;
  subtitle?: string;
  allAuthors?: string[];
  synopsis?: string;
  pageCount?: number;
  edition?: string;
  binding?: string;
  language?: string;
  series?: string;
  lcshSubjects?: string[];
  /** MARC 655 genre/form terms — cataloger-applied explicit genre vocabulary. */
  marcGenres?: string[];
  coverUrlFallbacks?: string[];
  // -------------------------------------------------------------------------
  // Two-step inference outputs (Step 4 / final post-audit step).
  // -------------------------------------------------------------------------
  /** Domains call 1 (domain detection) identified for this book. Up to 3,
   *  primary domain first. Empty / undefined for legacy records. */
  inferredDomains?: string[];
  /** Confidence of the primary domain assignment from call 1. Drives a
   *  Review-row marker when 'low' so the user can intervene. */
  domainConfidence?: 'high' | 'medium' | 'low';

  /**
   * User-curated physical format for this copy. Distinct from `binding`
   * (which is auto-populated from lookup-tier metadata). Set via the
   * Add Copy modal; exported to LibraryThing's BINDING column. Common
   * canonical values: "Hardcover", "Paperback", "Trade Paperback",
   * "Mass Market Paperback", "Library Binding", "Spiral-bound". Free
   * strings allowed for the "Other" fallback.
   */
  format?: string;
  /**
   * Cross-reference id linking this record to other physical copies of
   * the same work. Same field name + shape as the LedgerEntry-level
   * work_group_id used by the duplicates tool — assigned by Add Copy
   * when a user clones a record into an independent second copy. Two
   * records sharing this value render adjacent on Review with a left-
   * edge connector, are treated as intentional multi-copy by
   * detectDuplicates, and export as separate CSV rows.
   */
  work_group_id?: string;

  /**
   * Per-field source attribution. Captured by the lookup pipeline and
   * extended on user edits. Optional — absence on legacy records is
   * valid. UI surfacing is intentionally separate (a follow-up commit).
   */
  provenance?: BookRecordProvenance;

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
  /**
   * Set when the user cropped the photo before it entered the queue. The
   * value is the ORIGINAL filename so the queue UI can show "Cropped from
   * <name>" and a future debug session can confirm at a glance which
   * batches are running on cropped vs full source. The actual cropped
   * pixels are what live in `pendingFiles[id]` and are what the pipeline
   * (Pass A, Pass B crops, Reread) reads — the original is discarded.
   */
  croppedFrom?: string;
  /**
   * Image dimensions of whatever is in `pendingFiles[id]` — i.e. the
   * cropped image when the user cropped, otherwise the original. Recorded
   * once at queue time so the pipeline never has to re-decode just to
   * know the source size, and so a stale view never shows pre-crop dims.
   */
  sourceDimensions?: { width: number; height: number };
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
  /** Domains the two-step inference's call 1 identified. Up to 3,
   *  primary first. Empty array when the route runs in legacy mode or
   *  the model failed to produce domains. */
  inferredDomains?: string[];
  /** Confidence of the primary domain assignment ('high'/'medium'/'low'). */
  domainConfidence?: 'high' | 'medium' | 'low';
}
