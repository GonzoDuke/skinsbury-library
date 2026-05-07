/**
 * Shared post-lookup BookRecord assembly used by every entry point.
 *
 * The four entry-point functions in lib/pipeline.ts (buildBookFromCrop,
 * rereadBook, addManualBook, retagBook) all do the same back-half of
 * the work: take a BookLookupResult + a SpineRead + a tag-inference
 * output, then run an identical sequence to produce a BookRecord —
 * LCC don't-downgrade decision, Sonnet inferLcc fallback, deterministic
 * Fiction tag derivation, Title Case + canonical-title shorter-of-two,
 * authorLF derivation, provenance map with spine-source overrides and
 * LCC alternate splicing, and (on Reread/retag paths) a user-edit
 * preserving merge against a prior record.
 *
 * This module is the single home for that shared logic. Entry-point
 * functions become thin wrappers that handle their own pre-work
 * (Pass A/B, lookup orchestration, grounding, author-pattern, tag
 * inference) and call into assembleBookRecord for the back half.
 *
 * Behavior contract: every fix that lands here applies uniformly to
 * all four entry points. The recurring "Reread-path blind spot" class
 * of bug — where a fix shipped on buildBookFromCrop but not on
 * rereadBook — is structurally impossible after this refactor lands.
 */

import type {
  BookRecord,
  BookLookupResult,
  Confidence,
  InferTagsResult,
  SourceTag,
  SpineRead,
  BookRecordProvenance,
  FieldProvenance,
} from './types';
import { toAuthorLastFirst, toTitleCase } from './csv-export';
import {
  inferFictionTag,
  isCompleteLcc,
  normalizeLcc,
  stringSimilarity,
} from './lookup-utils';
import { PROVENANCE_FIELDS } from './provenance';

/**
 * Inline copy of pipeline.ts's inferLccClient. Duplicated here to
 * avoid a circular import once pipeline.ts starts importing
 * assembleBookRecord. Same shape, same endpoint, same fall-through.
 */
async function inferLccClient(args: {
  title: string;
  author: string;
  publisher?: string;
  publicationYear?: number;
}): Promise<{ lcc: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW' }> {
  try {
    const res = await fetch('/api/infer-lcc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) return { lcc: '', confidence: 'LOW' };
    return (await res.json()) as { lcc: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW' };
  } catch {
    return { lcc: '', confidence: 'LOW' };
  }
}

/** Mirror of pipeline.ts's USE_CANONICAL_TITLES flag — kept in sync. */
const USE_CANONICAL_TITLES = true;

/**
 * Single-name flip: "Allen Ginsberg" → "Ginsberg, Allen". Single-token
 * names ("Madonna") and already-comma'd inputs pass through. Mirrors
 * the inline helper in pipeline.ts.
 */
function flipNameLastFirst(name: string): string {
  const trimmed = name.trim().replace(/,$/, '');
  if (!trimmed) return '';
  if (trimmed.includes(',')) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return trimmed;
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1).join(' ');
  return `${last}, ${rest}`;
}

/**
 * Apply Fiction form tag deterministically post-inference. Mirrors
 * pipeline.ts's applyFictionFormTag — the rule is owned by
 * inferFictionTag in lookup-utils.
 */
function applyFictionFormTag(
  formTags: string[],
  lcc: string,
  subjects: string[] | undefined
): string[] {
  const tag = inferFictionTag(lcc, subjects);
  if (!tag) {
    return formTags.filter((t) => t !== 'Fiction');
  }
  if (formTags.includes(tag)) return formTags;
  return [...formTags, tag];
}

/**
 * Decide which LCC value lands on the BookRecord when both the spine
 * and the lookup chain produced a value. The "more specific wins"
 * rule applies symmetrically — never downgrade complete to partial.
 */
export function decideLccFromSources(args: {
  spine: string;
  lookup: string;
  lookupSource: BookRecord['lccSource'];
}): {
  winner: string;
  lccSource: BookRecord['lccSource'];
  alternate?: { source: SourceTag; value: string };
} {
  const spine = (args.spine ?? '').trim();
  const lookup = (args.lookup ?? '').trim();
  if (!spine && !lookup) return { winner: '', lccSource: 'none' };
  if (spine && !lookup) return { winner: spine, lccSource: 'spine' };
  if (!spine && lookup) return { winner: lookup, lccSource: args.lookupSource };
  const spineComplete = isCompleteLcc(spine);
  const lookupComplete = isCompleteLcc(lookup);
  if (spineComplete && !lookupComplete) {
    return {
      winner: spine,
      lccSource: 'spine',
      alternate: {
        source:
          args.lookupSource === 'loc'
            ? 'loc-sru'
            : args.lookupSource === 'wikidata'
              ? 'wikidata'
              : args.lookupSource === 'inferred'
                ? 'sonnet-infer-lcc'
                : 'openlibrary',
        value: lookup,
      },
    };
  }
  const sameNormalized = normalizeLcc(spine) === normalizeLcc(lookup);
  if (sameNormalized) return { winner: lookup, lccSource: args.lookupSource };
  return {
    winner: lookup,
    lccSource: args.lookupSource,
    alternate: { source: 'spine-read', value: spine },
  };
}

/**
 * Read v1 provenance off a BookLookupResult. The data rides as a
 * non-typed `__provenance` runtime field set by book-lookup.ts.
 */
function readLookupProvenance(lookup: BookLookupResult): BookRecordProvenance {
  const tagged = lookup as unknown as {
    __provenance?: BookRecordProvenance;
  };
  return tagged.__provenance ? { ...tagged.__provenance } : {};
}

/**
 * Build the BookRecord-level provenance from a finished lookup result.
 * Layers title/author/authorLF/lcc-override on top of the lookup's
 * own provenance map.
 */
function buildBookProvenance(args: {
  lookup: BookLookupResult;
  displayTitle: string;
  displayAuthor: string;
  authorLF: string;
  useCanonical: boolean;
  finalLcc: string;
  lccSource: BookRecord['lccSource'];
}): BookRecordProvenance {
  const ts = new Date().toISOString();
  const prov = readLookupProvenance(args.lookup);

  const primary: SourceTag =
    args.lookup.source === 'openlibrary'
      ? 'openlibrary'
      : args.lookup.source === 'isbndb'
        ? 'isbndb'
        : args.lookup.source === 'googlebooks'
          ? 'googlebooks'
          : 'spine-read';

  if (args.displayTitle) {
    const titleSource: SourceTag =
      args.useCanonical && args.lookup.canonicalTitle ? primary : 'spine-read';
    prov.title = { source: titleSource, timestamp: ts };
  }
  if (args.displayAuthor) {
    const authorSource: SourceTag =
      args.useCanonical && args.lookup.canonicalAuthor ? primary : 'spine-read';
    prov.author = { source: authorSource, timestamp: ts };
  }
  if (args.authorLF) {
    prov.authorLF = { source: 'derived', timestamp: ts, derivedFrom: 'author' };
  }

  if (args.finalLcc && args.lccSource === 'spine') {
    prov.lcc = { source: 'spine-read', timestamp: ts };
  } else if (args.finalLcc && args.lccSource === 'inferred') {
    const prior: FieldProvenance | undefined = prov.lcc;
    const alternates = prior?.alternates ? [...prior.alternates] : undefined;
    prov.lcc = {
      source: 'sonnet-infer-lcc',
      timestamp: ts,
      ...(alternates && alternates.length > 0 ? { alternates } : {}),
    };
  }
  return prov;
}

/**
 * Combined LCC resolver: applies decideLccFromSources (don't-downgrade
 * spine vs lookup) and the Sonnet `/api/infer-lcc` fallback when the
 * resolved value is still partial/empty. Returns the final lcc value,
 * its provenance source tag, and any alternate captured during the
 * decision (for provenance.lcc.alternates).
 *
 * Caller invokes this BEFORE running tag inference, because tag
 * inference uses the resolved LCC as one of its inputs. assembleBook-
 * Record consumes the result — it does not re-run any LCC fallback.
 */
export async function resolveLcc(args: {
  spine: string;
  lookup: BookLookupResult;
  /** Title used for the Sonnet inferLcc fallback query. */
  title: string;
  /** Author used for the Sonnet inferLcc fallback query. */
  author: string;
  /** Set to false to skip the Sonnet model fallback (e.g. retag). */
  enableSonnetFallback?: boolean;
  /** Set to false to skip the entire resolution (caller has it already). */
  gateOnGroundedKeep?: boolean;
}): Promise<{
  finalLcc: string;
  lccSource: BookRecord['lccSource'];
  alternate?: { source: SourceTag; value: string };
}> {
  const decision = decideLccFromSources({
    spine: args.spine,
    lookup: args.lookup.lcc || '',
    lookupSource: args.lookup.lcc ? args.lookup.lccSource ?? 'ol' : 'none',
  });
  let finalLcc = decision.winner;
  let lccSource: BookRecord['lccSource'] = decision.lccSource;

  const enableFallback = args.enableSonnetFallback !== false;
  if (enableFallback && !isCompleteLcc(finalLcc) && args.title && args.author) {
    try {
      const inferred = await inferLccClient({
        title: args.title,
        author: args.author,
        publisher: args.lookup.publisher,
        publicationYear: args.lookup.publicationYear,
      });
      if (inferred.lcc && inferred.confidence !== 'LOW') {
        const normalized = normalizeLcc(inferred.lcc);
        if (isCompleteLcc(normalized) || !finalLcc) {
          finalLcc = normalized;
          lccSource = 'inferred';
        }
      }
    } catch {
      // ignore — leave LCC as-is
    }
  }
  return { finalLcc, lccSource, alternate: decision.alternate };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inputs to the shared assembler. The four entry points populate
 * different subsets — the optional fields capture the variation
 * (priorRecord for Reread/retag, manualOverrides for manual entry,
 * spineRead for capture / Reread paths).
 */
export interface AssembleInput {
  /**
   * The lookup result. Caller is responsible for any pre-assembly
   * mutations (author-pattern enrichment, etc.) before invoking.
   */
  lookup: BookLookupResult;

  /**
   * Pass-B OCR output. Absent for manual entry; absent for retag
   * (retag reuses priorRecord.spineRead).
   */
  spineRead?: SpineRead;

  /**
   * The OCR-side title/author/lcc/extracted-* fields. Caller may
   * pass `spineRead` here when those values mirror the spineRead
   * exactly, or a synthesized object for manual / retag paths.
   * When omitted, behavior assumes no spine-side data (manual entry).
   */
  spineFields?: {
    title?: string;
    author?: string;
    publisher?: string;
    lcc?: string;
    confidence?: Confidence;
    extractedCallNumber?: string;
    extractedCallNumberSystem?: 'lcc' | 'ddc' | 'unknown';
    extractedEdition?: string;
    extractedSeries?: string;
  };

  /**
   * Pre-resolved LCC. Caller runs `resolveLcc` (above) BEFORE invoking
   * tag inference (since tags depend on the resolved LCC), then passes
   * the result here. assemble does NOT re-run LCC resolution.
   */
  finalLcc: string;
  lccSource: BookRecord['lccSource'];
  /** Optional alternate captured during the LCC decision. */
  lccAlternate?: { source: SourceTag; value: string };

  /** Tag-inference output (caller runs inferTagsClient). */
  tags: InferTagsResult;

  /**
   * Grounding output: post-grounding confidence + warnings. Caller
   * runs groundSpineRead and folds in any identify-book / lookup-
   * specific warnings before invoking. The BookRecord's confidence
   * field is the WORST of grounded.confidence and tags.confidence.
   */
  groundedConfidence: Confidence;
  warnings: string[];

  /** sourcePhoto value for the assembled record. */
  sourcePhoto: string;

  /** Optional batch context. */
  batchLabel?: string;
  batchNotes?: string;

  /**
   * The existing record being updated. Set on Reread / retag paths
   * — assembler will preserve user-edited fields (provenance.X.source
   * === 'user-edit') against the fresh values, and reuse the existing
   * `id` and `spineRead` if not overridden.
   */
  priorRecord?: BookRecord;

  /**
   * For manual entry: explicit user-typed values for tracked fields.
   * Each entry forces the resulting BookRecord field to the supplied
   * value AND stamps its provenance entry as `'user-edit'`.
   */
  manualOverrides?: {
    title?: string;
    author?: string;
    isbn?: string;
    publisher?: string;
    publicationYear?: number;
  };

  /**
   * Flags + minor specifics that flow through to the BookRecord.
   * Caller assembles per entry-point semantics.
   */
  manuallyAdded?: boolean;
  scannedFromBarcode?: boolean;
  ocrImage?: string;
  ocrModel?: 's' | 'o';
  spineThumbnail?: string;

  /** Override the generated id (Reread / retag pass priorRecord.id). */
  id?: string;

  /** Initial status — usually 'pending'. retag preserves prior status. */
  status?: 'pending' | 'approved' | 'rejected';
}

/**
 * Build the final BookRecord from a finished lookup, finished tags,
 * and a SpineRead (or its absence). The single source of truth for
 * the back-half of every entry point — see this file's docstring.
 *
 * Returns the assembled BookRecord. Callers wrap it in their entry-
 * point-specific return shape (e.g. Reread converts to a patch).
 */
export async function assembleBookRecord(
  input: AssembleInput
): Promise<BookRecord> {
  const lookup = input.lookup;
  const spine = input.spineFields ?? {};
  const finalLcc = input.finalLcc;
  const lccSource = input.lccSource;
  const lccAlternateForProvenance = input.lccAlternate;

  // --- Spine DDC / edition / series gap-fills onto lookup ---
  // The LCC gap-fill happened in the caller via resolveLcc; only the
  // non-LCC sticker / printed-on-spine fields land here.
  if (
    spine.extractedCallNumber &&
    spine.extractedCallNumberSystem === 'ddc' &&
    !lookup.ddc
  ) {
    lookup.ddc = spine.extractedCallNumber;
  }
  if (spine.extractedEdition && !lookup.edition) {
    lookup.edition = spine.extractedEdition;
  }
  if (spine.extractedSeries && !lookup.series) {
    lookup.series = spine.extractedSeries;
  }

  // --- Apply Fiction form tag deterministically (post-inference) ---
  const tagsWithFiction: InferTagsResult = {
    ...input.tags,
    formTags: applyFictionFormTag(
      input.tags.formTags,
      finalLcc,
      lookup.lcshSubjects ?? lookup.subjects
    ),
  };

  // --- Combined confidence: worst of grounded vs tags ---
  const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  const combinedConfidence: Confidence =
    order[input.groundedConfidence] <= order[tagsWithFiction.confidence]
      ? input.groundedConfidence
      : tagsWithFiction.confidence;

  // --- Title Case + canonical-title shorter-of-two + authorLF ---
  const useCanonical = USE_CANONICAL_TITLES && lookup.source !== 'none';
  const titleCased = toTitleCase(spine.title ?? '');
  const canonicalTitleCased =
    useCanonical && lookup.canonicalTitle && lookup.canonicalTitle.trim()
      ? toTitleCase(lookup.canonicalTitle)
      : '';
  let displayTitle = canonicalTitleCased || titleCased;
  if (canonicalTitleCased && titleCased) {
    const sim = stringSimilarity(
      canonicalTitleCased.toLowerCase(),
      titleCased.toLowerCase()
    );
    if (sim >= 0.6) {
      displayTitle =
        titleCased.length < canonicalTitleCased.length
          ? titleCased
          : canonicalTitleCased;
    }
  }
  // Manual overrides force display values regardless of canonical rule.
  if (input.manualOverrides?.title) {
    displayTitle = input.manualOverrides.title;
  }

  let displayAuthor =
    useCanonical && lookup.canonicalAuthor && lookup.canonicalAuthor.trim()
      ? lookup.canonicalAuthor
      : spine.author ?? '';
  if (input.manualOverrides?.author) {
    displayAuthor = input.manualOverrides.author;
  }

  const authorLF =
    useCanonical && lookup.allAuthors && lookup.allAuthors.length > 1
      ? lookup.allAuthors.map(flipNameLastFirst).filter(Boolean).join('; ')
      : toAuthorLastFirst(displayAuthor);

  // --- Provenance ---
  const provenance = buildBookProvenance({
    lookup,
    displayTitle,
    displayAuthor,
    authorLF,
    useCanonical,
    finalLcc,
    lccSource,
  });
  const provTs = new Date().toISOString();
  if (
    spine.extractedCallNumber &&
    spine.extractedCallNumberSystem === 'ddc' &&
    lookup.ddc === spine.extractedCallNumber
  ) {
    provenance.ddc = {
      source: 'spine-read',
      timestamp: provTs,
      extractedFrom: 'extractedCallNumber',
    };
  }
  if (spine.extractedEdition && lookup.edition === spine.extractedEdition) {
    provenance.edition = {
      source: 'spine-read',
      timestamp: provTs,
      extractedFrom: 'extractedEdition',
    };
  }
  if (spine.extractedSeries && lookup.series === spine.extractedSeries) {
    provenance.series = {
      source: 'spine-read',
      timestamp: provTs,
      extractedFrom: 'extractedSeries',
    };
  }
  // When the resolved LCC came from the spine (and the spine read
  // attributes it specifically to extractedCallNumber with system='lcc'),
  // augment provenance.lcc with extractedFrom. Legacy spine-read.lcc
  // stamps remain without extractedFrom (we can't distinguish at this
  // call site).
  if (
    lccSource === 'spine' &&
    spine.extractedCallNumber &&
    spine.extractedCallNumberSystem === 'lcc' &&
    provenance.lcc?.source === 'spine-read'
  ) {
    provenance.lcc = {
      ...provenance.lcc,
      extractedFrom: 'extractedCallNumber',
    };
  }
  if (lccAlternateForProvenance && provenance.lcc) {
    const existing = provenance.lcc.alternates ?? [];
    provenance.lcc = {
      ...provenance.lcc,
      alternates: [...existing, lccAlternateForProvenance],
    };
  }

  // --- Reread / retag merge: preserve user-edit fields from prior ---
  let mergedProvenance = provenance;
  let mergedFields: Partial<BookRecord> = {};
  if (input.priorRecord) {
    const oldProv = input.priorRecord.provenance ?? {};
    mergedProvenance = { ...provenance };
    for (const field of PROVENANCE_FIELDS) {
      const priorEntry = oldProv[field];
      if (priorEntry?.source === 'user-edit') {
        mergedProvenance[field] = priorEntry;
        const oldValue = (input.priorRecord as unknown as Record<string, unknown>)[field];
        (mergedFields as Record<string, unknown>)[field] = oldValue;
      }
    }
  }

  // --- Manual override stamping ---
  if (input.manualOverrides) {
    const ts = new Date().toISOString();
    if (input.manualOverrides.title) {
      mergedProvenance.title = { source: 'user-edit', timestamp: ts };
    }
    if (input.manualOverrides.author) {
      mergedProvenance.author = { source: 'user-edit', timestamp: ts };
    }
    if (input.manualOverrides.isbn) {
      mergedProvenance.isbn = { source: 'user-edit', timestamp: ts };
    }
  }

  // --- Final field assembly ---
  // Ordering: lookup defaults → priorRecord (when present) → user-edit
  // overrides preserved by merge step → manualOverrides last (most
  // explicit). The mergedFields holds user-edited values from the
  // prior record so they take precedence over lookup-derived ones.
  const idResolved =
    input.id ?? input.priorRecord?.id ?? makeIdFallback();

  // Manual-entry final values when overrides are set.
  const finalTitle = (mergedFields.title as string | undefined) ?? displayTitle;
  const finalAuthor = (mergedFields.author as string | undefined) ?? displayAuthor;
  const finalAuthorLF = (mergedFields.authorLF as string | undefined) ?? authorLF;
  const finalIsbn =
    (mergedFields.isbn as string | undefined) ??
    input.manualOverrides?.isbn ??
    lookup.isbn ??
    '';
  const finalPublisher =
    (mergedFields.publisher as string | undefined) ??
    input.manualOverrides?.publisher ??
    lookup.publisher ??
    '';
  const finalPublicationYear =
    (mergedFields.publicationYear as number | undefined) ??
    input.manualOverrides?.publicationYear ??
    lookup.publicationYear ??
    0;

  const spineReadOut: SpineRead =
    input.spineRead ??
    input.priorRecord?.spineRead ??
    ({
      position: 0,
      rawText: '',
      title: spine.title ?? '',
      author: spine.author ?? '',
      confidence: input.groundedConfidence,
    } as SpineRead);

  const book: BookRecord = {
    id: idResolved,
    spineRead: spineReadOut,
    title: finalTitle,
    author: finalAuthor,
    authorLF: finalAuthorLF,
    isbn: finalIsbn,
    publisher: finalPublisher,
    publicationYear: finalPublicationYear,
    lcc: (mergedFields.lcc as string | undefined) ?? finalLcc,
    genreTags:
      (mergedFields.genreTags as string[] | undefined) ?? tagsWithFiction.genreTags,
    formTags:
      (mergedFields.formTags as string[] | undefined) ?? tagsWithFiction.formTags,
    confidence: combinedConfidence,
    reasoning: tagsWithFiction.reasoning,
    status:
      input.status ?? input.priorRecord?.status ?? 'pending',
    warnings: input.warnings,
    sourcePhoto: input.sourcePhoto,
    batchLabel: input.batchLabel ?? input.priorRecord?.batchLabel,
    batchNotes: input.batchNotes ?? input.priorRecord?.batchNotes,
    manuallyAdded: input.manuallyAdded ?? input.priorRecord?.manuallyAdded,
    scannedFromBarcode:
      input.scannedFromBarcode ?? input.priorRecord?.scannedFromBarcode,
    provenance: mergedProvenance,
    lookupSource: lookup.source,
    ddc: (mergedFields.ddc as string | undefined) ?? lookup.ddc,
    lccDerivedFromDdc: lookup.lccDerivedFromDdc,
    lccDerivedFromAuthorPattern: lookup.lccDerivedFromAuthorPattern,
    inferredDomains: tagsWithFiction.inferredDomains,
    domainConfidence: tagsWithFiction.domainConfidence,
    lccSource,
    spineThumbnail: input.spineThumbnail ?? input.priorRecord?.spineThumbnail,
    coverUrl:
      (mergedFields.coverUrl as string | undefined) ?? lookup.coverUrl,
    ocrImage: input.ocrImage ?? input.priorRecord?.ocrImage,
    ocrModel: input.ocrModel ?? input.priorRecord?.ocrModel,
    canonicalTitle:
      (mergedFields.canonicalTitle as string | undefined) ?? lookup.canonicalTitle,
    subtitle: lookup.subtitle,
    allAuthors:
      (mergedFields.allAuthors as string[] | undefined) ?? lookup.allAuthors,
    synopsis:
      (mergedFields.synopsis as string | undefined) ?? lookup.synopsis,
    pageCount:
      (mergedFields.pageCount as number | undefined) ?? lookup.pageCount,
    edition: (mergedFields.edition as string | undefined) ?? lookup.edition,
    binding: (mergedFields.binding as string | undefined) ?? lookup.binding,
    language: (mergedFields.language as string | undefined) ?? lookup.language,
    series: lookup.series,
    lcshSubjects:
      (mergedFields.lcshSubjects as string[] | undefined) ?? lookup.lcshSubjects,
    marcGenres: lookup.marcGenres,
    coverUrlFallbacks: lookup.coverUrlFallbacks,
    original: input.priorRecord?.original ?? {
      title: finalTitle,
      author: finalAuthor,
      isbn: finalIsbn,
      publisher: finalPublisher,
      publicationYear: finalPublicationYear,
      lcc: finalLcc,
      genreTags: [...tagsWithFiction.genreTags],
      formTags: [...tagsWithFiction.formTags],
    },
  };

  return book;
}

/** Local fallback for makeId — avoids circular import with pipeline.ts. */
function makeIdFallback(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
