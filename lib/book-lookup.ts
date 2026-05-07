import type {
  BookLookupResult,
  BookRecordProvenance,
  FieldProvenance,
  SourceTag,
} from './types';
import {
  normalizeLcc,
  isCompleteLcc,
  lookupLccByIsbn,
  lookupLccByTitleAuthor,
  lookupFullMarcByIsbn,
  sanitizeForSearch,
  stripEditorPrefix,
  deriveLccFromDdc,
  type MarcResult,
} from './lookup-utils';

/**
 * Build a BookRecord provenance map from a finished BookLookupResult.
 * v1: heuristic end-of-pipeline inference based on `result.source`,
 * `lccSource`, and which optional fields are populated. Captures the
 * winning source per field. Alternates are populated only for cases
 * tracked explicitly during the chain (the LCC partial→complete
 * upgrade is the headline case; passed via `lccAlternates`).
 *
 * Per-tier alternates capture for non-LCC fields is a follow-up — the
 * data structure supports it, but threading per-tier prov through every
 * internal mutation site is more invasive than the v1 spec budget.
 */
function inferProvenanceFromResult(
  result: BookLookupResult,
  lccSource: 'ol' | 'loc' | 'wikidata' | 'inferred' | 'none',
  lccAlternates: Array<{ source: SourceTag; value: unknown }> = []
): BookRecordProvenance {
  const ts = new Date().toISOString();
  const prov: BookRecordProvenance = {};

  // Phase-1 winner determines the primary source for the basic-metadata
  // fields. When source === 'none' the values that survived came off
  // the spine read directly (Phase B OCR), so tag them 'spine-read'.
  const primary: SourceTag =
    result.source === 'openlibrary'
      ? 'openlibrary'
      : result.source === 'isbndb'
        ? 'isbndb'
        : result.source === 'googlebooks'
          ? 'googlebooks'
          : 'spine-read';

  if (result.isbn) prov.isbn = { source: primary, timestamp: ts };
  if (result.publisher) prov.publisher = { source: primary, timestamp: ts };
  if (result.publicationYear) {
    prov.publicationYear = { source: primary, timestamp: ts };
  }
  if (result.canonicalTitle) {
    prov.canonicalTitle = { source: primary, timestamp: ts };
  }
  if (result.allAuthors && result.allAuthors.length > 0) {
    prov.allAuthors = { source: primary, timestamp: ts };
  }

  // LCC source tag — derive from the explicit lccSource lifecycle.
  if (result.lcc) {
    let lccTag: SourceTag = 'openlibrary';
    if (lccSource === 'loc') {
      // 'loc' covers both MARC (Phase 2) and loc-sru (title+author
      // fallback). MARC fires only with a present LCSH array, so its
      // presence is the cleanest disambiguator.
      lccTag = result.lcshSubjects && result.lcshSubjects.length > 0
        ? 'marc'
        : 'loc-sru';
    } else if (lccSource === 'wikidata') {
      lccTag = 'wikidata';
    } else if (lccSource === 'inferred') {
      lccTag = 'sonnet-infer-lcc';
    } else if (lccSource === 'ol') {
      lccTag = 'openlibrary';
    } else {
      // 'none' — should be unreachable when result.lcc is set; fall
      // through to primary as a safe default.
      lccTag = primary;
    }
    const entry: FieldProvenance = { source: lccTag, timestamp: ts };
    if (lccAlternates.length > 0) entry.alternates = [...lccAlternates];
    prov.lcc = entry;
  }

  // DDC: MARC supplies it via Phase 2 when MARC fires; ISBNdb otherwise
  // (it's the only Phase-1 candidate that exposes Dewey directly).
  if (result.ddc) {
    const ddcSrc: SourceTag =
      result.lcshSubjects && result.lcshSubjects.length > 0
        ? 'marc'
        : primary === 'isbndb'
          ? 'isbndb'
          : 'marc';
    prov.ddc = { source: ddcSrc, timestamp: ts };
  }

  // Phase-2 enrichment fields — best-guess attribution by typical source.
  if (result.lcshSubjects && result.lcshSubjects.length > 0) {
    prov.lcshSubjects = { source: 'marc', timestamp: ts };
  }
  if (result.subjects && result.subjects.length > 0) {
    prov.subjects = { source: primary, timestamp: ts };
  }
  if (result.synopsis) {
    prov.synopsis = {
      source: primary === 'isbndb' ? 'isbndb' : 'googlebooks',
      timestamp: ts,
    };
  }
  if (result.pageCount) {
    prov.pageCount = {
      source: primary === 'isbndb' ? 'isbndb' : 'marc',
      timestamp: ts,
    };
  }
  if (result.edition) {
    prov.edition = {
      source: primary === 'isbndb' ? 'isbndb' : 'marc',
      timestamp: ts,
    };
  }
  if (result.binding) {
    // binding is ISBNdb-only in practice; MARC and OL don't surface it.
    prov.binding = { source: 'isbndb', timestamp: ts };
  }
  if (result.language) {
    prov.language = {
      source: primary === 'isbndb' ? 'isbndb' : 'googlebooks',
      timestamp: ts,
    };
  }
  if (result.coverUrl) {
    // The cover-chain primary is always the OL Covers API by ISBN.
    prov.coverUrl = { source: 'openlibrary', timestamp: ts };
  }

  return prov;
}

/**
 * Attach provenance to the runtime BookLookupResult object as the
 * non-typed `__provenance` field. Since the type definition stays
 * unchanged, callers that don't care about provenance ignore it; the
 * pipeline + API route read it explicitly. The JSON serializer
 * propagates it automatically through /api/lookup-book.
 */
function attachProvenance<T extends BookLookupResult>(
  result: T,
  prov: BookRecordProvenance
): T {
  (result as unknown as { __provenance: BookRecordProvenance }).__provenance = prov;
  return result;
}

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

/**
 * Optional spine-extracted hints that influence Phase 1 candidate
 * scoring. All fields come from Pass-B OCR. When set, candidates
 * whose metadata matches the spine value get an additive bonus —
 * tie-breakers (extractedEdition/Series) or stronger differentiators
 * (extractedLccClass, which can be decisive enough to overcome a
 * stronger title/author match because a physical sticker is the
 * single most reliable signal we have about which book this is).
 */
interface ScoreHints {
  extractedEdition?: string;
  extractedSeries?: string;
  /** LCC class portion (letters + class digits before the cutter)
   *  derived from a spine sticker, e.g. "PS3521" from "PS3521.E735".
   *  See lccClass() for the parser. Only set when the spine read
   *  attributed the call number to LCC (system === 'lcc'). */
  extractedLccClass?: string;
}

/**
 * Extract the LCC class portion (letters + class digits before the
 * cutter or year) from a raw call number. Returns "" when the input
 * doesn't match an LCC pattern (e.g., DDC numbers like "973.7" have
 * no leading letters and produce empty).
 *
 * Three normalizations make values from different sources compare
 * equal:
 *   1. Whitespace stripped, letters uppercased.
 *   2. An optional hyphen between letters and digits is consumed —
 *      Open Library stores LCCs in normalized sortable form
 *      ("HM-0721.00000000") with that hyphen present. Without this,
 *      OL candidates wouldn't match the typical spine-sticker form.
 *   3. Leading zeros on the class digits are stripped so OL records
 *      with zero-padded digits ("HM0721") compare equal to stickers
 *      without the padding ("HM721").
 *
 * Examples:
 *   "PS3521.E735 A6 1995"          → "PS3521"
 *   "PS 3521 .E735 A6 1995"        → "PS3521"
 *   "HV5825 .T67 2005"             → "HV5825"
 *   "PS3521.5.E735"                → "PS3521"  (decimal class → integer)
 *   "HM0721"                       → "HM721"   (leading zero stripped)
 *   "PS00001"                      → "PS1"     (multiple leading zeros)
 *   "HM-0721.00000000"             → "HM721"   (OL sortable form)
 *   "HQ-0799.70000000.T94 2006"    → "HQ799"   (OL sortable + cutter)
 *   "973.7"                        → ""        (no leading letters)
 *   ""                             → ""
 *
 * Reused by both the scorer (to compare candidate LCC against the
 * spine's class) and the hint-construction sites (to derive the
 * extractedLccClass that's stuffed into ScoreHints). Single source
 * of truth — exported so tests can assert directly against it.
 */
export function lccClass(raw: string): string {
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, '').toUpperCase();
  // Leading letters (1–3), an optional hyphen separator (OL sortable
  // form), then class digits with optional decimal sub-class.
  // Anchored at start. The cutter (.X<digits>) and year don't match
  // because the regex only consumes letters and digits before them.
  const m = cleaned.match(/^([A-Z]{1,3})-?(\d+(\.\d+)?)/);
  if (!m) return '';
  const letters = m[1];
  // Take the integer portion of the class digits (drop any decimal
  // sub-class). Strip leading zeros so zero-padded variants normalize
  // to the same string. `|| '0'` preserves a single zero when the
  // input was all zeros (defensive — real LCC class digits never are,
  // but the normalization shouldn't produce an empty string).
  const digits = m[2].split('.')[0].replace(/^0+/, '') || '0';
  return letters + digits;
}

/**
 * Minimum total score a Phase 1 winner must reach to be returned as
 * a confident match. Below this, the title-search candidate pool is
 * weak enough that any "best" pick is more likely than not to be the
 * wrong book — we'd rather bail out and let the no-Phase-1-winner
 * fallbacks (or an explicit no-match return) take over.
 *
 * Calibration: the typical right answer scores 6+ (author full match
 * = 3, exact title = 2, plus at least one of isbn/lcc/publisher).
 * Wrong-edition picks for under-described books (no LCC, no ISBN,
 * partial author match) tend to land in the 3–5 range. 6 catches
 * the pathological cases without rejecting genuinely-good matches.
 */
const MIN_PHASE1_SCORE = 6;

interface ScoreBreakdown {
  total: number;
  /** Per-rule contributions. Field names are short on purpose so the
   *  trace line stays compact: e.g., "author:3 title:2 isbn:0 ...". */
  rules: {
    isbn: number;
    lcc: number;
    /** +4 when the candidate's LCC class matches the spine sticker's
     *  LCC class (PS3521 vs PS3521). -4 on disagreement (PS3521 vs
     *  PS3568 = different author surname range). 0 when either side
     *  is missing OR when no spine LCC hint was provided. Stronger
     *  than the lcc-presence rule because a physical sticker is the
     *  most reliable single signal we have about which book this is. */
    lccClass: number;
    publisher: number;
    year: number;
    title: number;
    author: number;
    /** -3 when an ISBN starts with 9798 (KDP / self-published). */
    kdp: number;
    /** Combined spine-extracted edition (+1) and series (+2) bonuses. */
    spine: number;
    /** Tier-2 only: +4 when the user-provided publisher hint matches
     *  the candidate's publisher list. Optional in the breakdown so
     *  Phase 1 (which doesn't apply this rule) doesn't surface it. */
    publisherHint?: number;
  };
}

/** Format a ScoreBreakdown's rules into a trace-line-friendly string,
 *  e.g., "author:3 title:2 isbn:1 publisher:1 year:1 lcc:0 kdp:0 spine:0". */
function formatBreakdown(b: ScoreBreakdown): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(b.rules)) {
    if (typeof v === 'number') parts.push(`${k}:${v}`);
  }
  return parts.join(' ');
}

export function scoreDocBreakdown(
  d: OpenLibraryDoc,
  title: string,
  author: string,
  hints?: ScoreHints
): ScoreBreakdown {
  const rules: ScoreBreakdown['rules'] = {
    isbn: 0,
    lcc: 0,
    lccClass: 0,
    publisher: 0,
    year: 0,
    title: 0,
    author: 0,
    kdp: 0,
    spine: 0,
  };
  if (d.isbn && d.isbn.length > 0) rules.isbn = 2;
  if (
    (d.lcc && d.lcc.length > 0) ||
    (d.lc_classifications && d.lc_classifications.length > 0)
  ) {
    rules.lcc = 3;
  }
  // Spine LCC class match — when the spine sticker carries an LCC and
  // the candidate has an LCC, compare class portions (letters + class
  // digits before the cutter). Match: +4. Disagreement: -4. Either
  // side empty OR malformed: 0. Stronger than the lcc-presence rule
  // because a physical sticker is the single most reliable signal we
  // have about which book this actually is.
  if (hints?.extractedLccClass) {
    const candidateRawLcc =
      (d.lcc && d.lcc.length > 0 ? d.lcc[0] : '') ||
      (d.lc_classifications && d.lc_classifications.length > 0
        ? d.lc_classifications[0]
        : '');
    if (candidateRawLcc) {
      const candidateClass = lccClass(candidateRawLcc);
      if (candidateClass) {
        rules.lccClass = candidateClass === hints.extractedLccClass ? 4 : -4;
      }
      // Candidate has lcc but it didn't parse to a class (rare,
      // malformed data) — leave rules.lccClass at 0.
    }
    // Candidate has no lcc at all — leave rules.lccClass at 0 (no
    // penalty for missing data).
  }
  if (d.publisher && d.publisher.length > 0) rules.publisher = 1;
  if (d.first_publish_year) rules.year = 1;
  if (titleExactMatch(title, d.title)) rules.title = 2;
  // Full-token author match is the strong signal; last-name match is a
  // coarser fallback worth a smaller bump.
  if (authorMatches(author, d.author_name)) rules.author = 3;
  else if (authorLastNameMatch(author, d.author_name)) rules.author = 1;
  // KDP/self-published penalty
  if (d.isbn && d.isbn.some((i) => i.replace(/[^\d]/g, '').startsWith('9798'))) {
    rules.kdp = -3;
  }
  // Spine-extracted edition: +1 when the spine's edition string appears
  // in the candidate's title (OL doesn't expose a top-level edition
  // field for search.json results, so the title is where edition
  // markers like "First Edition" / "Annotated" / "Rev. ed." most often
  // surface). Substring match, case-insensitive. Additive — never
  // penalizes a candidate that lacks the field.
  let spineScore = 0;
  if (hints?.extractedEdition && d.title) {
    const ed = hints.extractedEdition.toLowerCase();
    if (ed.length >= 3 && d.title.toLowerCase().includes(ed)) spineScore += 1;
  }
  // Spine-extracted series: +2 when the spine's series imprint appears
  // in the candidate's publisher list. The Penguin-Classics-says-Penguin-
  // Classics disambiguator. Bigger than the edition bonus because series
  // imprints are stronger publisher-disambiguating signals — when a spine
  // says "Library of America" and one candidate is from LoA while another
  // is from Vintage, the spine evidence should tip the scale.
  if (hints?.extractedSeries && d.publisher && d.publisher.length > 0) {
    const series = hints.extractedSeries.toLowerCase();
    if (
      series.length >= 3 &&
      d.publisher.some((p) => p.toLowerCase().includes(series))
    ) {
      spineScore += 2;
    }
  }
  rules.spine = spineScore;

  const total =
    rules.isbn +
    rules.lcc +
    rules.lccClass +
    rules.publisher +
    rules.year +
    rules.title +
    rules.author +
    rules.kdp +
    rules.spine;
  return { total, rules };
}

/** Thin wrapper preserved for legacy callers (pickBestDoc, the one
 *  redundant winner-line log call). New code should prefer
 *  scoreDocBreakdown for the per-rule trace. */
function scoreDoc(
  d: OpenLibraryDoc,
  title: string,
  author: string,
  hints?: ScoreHints
): number {
  return scoreDocBreakdown(d, title, author, hints).total;
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
  // Widened in the data-leak audit fix: these were already in the GB
  // response but the inline interface below didn't declare them, so the
  // values vanished. All optional — gap-fill only at the merge site.
  description?: string;
  pageCount?: number;
  subtitle?: string;
  language?: string;
  mainCategory?: string;
  authors?: string[];
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
          description?: string;
          pageCount?: number;
          subtitle?: string;
          language?: string;
          mainCategory?: string;
          authors?: string[];
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
      description: vi.description?.trim() || undefined,
      pageCount: typeof vi.pageCount === 'number' && vi.pageCount > 0 ? vi.pageCount : undefined,
      subtitle: vi.subtitle?.trim() || undefined,
      language: vi.language?.trim() || undefined,
      mainCategory: vi.mainCategory?.trim() || undefined,
      authors: Array.isArray(vi.authors) && vi.authors.length > 0 ? vi.authors : undefined,
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

/**
 * Gap-fill OL helper. One ISBN-keyed search + optional work-record
 * fetch returns every field gap-fill might need from Open Library:
 * publisher (edition), pageCount (number_of_pages_median), publicationYear
 * (first_publish_year), and via the work record, synopsis (description)
 * and subjects. Cheap — single search request, plus one work fetch
 * only when synopsis or subjects are needed.
 */
async function gapFillFromOpenLibrary(
  isbn: string,
  needsWorkRecord: boolean
): Promise<{
  publisher?: string;
  pageCount?: number;
  publicationYear?: number;
  synopsis?: string;
  subjects?: string[];
}> {
  if (!isbn) return {};
  try {
    const url =
      `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}` +
      `&fields=key,publisher,first_publish_year,number_of_pages_median`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      docs?: Array<{
        key?: string;
        publisher?: string[];
        first_publish_year?: number;
        number_of_pages_median?: number;
      }>;
    };
    const doc = data.docs?.[0];
    if (!doc) return {};
    const out: {
      publisher?: string;
      pageCount?: number;
      publicationYear?: number;
      synopsis?: string;
      subjects?: string[];
    } = {};
    if (doc.publisher && doc.publisher[0]) out.publisher = doc.publisher[0];
    if (typeof doc.number_of_pages_median === 'number' && doc.number_of_pages_median > 0) {
      out.pageCount = doc.number_of_pages_median;
    }
    if (doc.first_publish_year && doc.first_publish_year > 0) {
      out.publicationYear = doc.first_publish_year;
    }
    if (needsWorkRecord && doc.key) {
      const work = await fetchWork(doc.key);
      if (work) {
        const desc =
          typeof work.description === 'string'
            ? work.description
            : work.description?.value;
        if (desc && desc.trim()) out.synopsis = desc.trim();
        if (work.subjects && work.subjects.length > 0) {
          out.subjects = work.subjects.slice(0, 10);
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Post-Phase-2 gap-fill pass. Runs after every existing tier (Phase 1,
 * Phase 2 fan-out, GB fallback, LoC SRU title+author, Wikidata title-
 * search, DDC→LCC) has had its turn. Picks up high-value fields that
 * are STILL empty and runs a single targeted free-source query per
 * field. v1 covers: lcshSubjects, pageCount, ddc, synopsis,
 * publicationYear, publisher, isbn. lcc is intentionally excluded —
 * already handled by the existing fallback chain.
 *
 * Sources: MARC by ISBN, Open Library Works/search by ISBN, Wikidata
 * by ISBN. No paid APIs, no model calls.
 *
 * Mutates `result` in place. Records per-field source attribution into
 * `gapFillProv` so the final provenance map reflects the actual tier
 * that filled each value (the heuristic end-of-pipeline inference
 * can't tell gap-fill MARC vs. Phase-2 MARC, etc.).
 *
 * Bail-out: when result.source === 'none' (Phase 1 found nothing),
 * gap-fill is a no-op — there's no book to fill data for.
 */
async function runGapFill(
  result: BookLookupResult,
  log: LookupLogger,
  gapFillProv: BookRecordProvenance
): Promise<void> {
  if (result.source === 'none') {
    log.tier('gap-fill', 'skipped — no Phase-1 winner');
    return;
  }

  const empties: string[] = [];
  if (!result.lcshSubjects || result.lcshSubjects.length === 0) empties.push('lcshSubjects');
  if (!result.pageCount) empties.push('pageCount');
  if (!result.ddc) empties.push('ddc');
  if (!result.synopsis) empties.push('synopsis');
  if (!result.publicationYear) empties.push('publicationYear');
  if (!result.publisher) empties.push('publisher');
  if (!result.isbn) empties.push('isbn');
  // lcc intentionally excluded — handled by post-Phase-2 fallback chain.

  if (empties.length === 0) {
    log.tier('gap-fill', 'nothing-to-fill');
    return;
  }

  log.tier('gap-fill', `empty fields: [${empties.join(',')}]`);
  const filled: string[] = [];
  const ts = new Date().toISOString();
  const stamp = (field: string, source: SourceTag) => {
    gapFillProv[field] = { source, timestamp: ts };
    filled.push(field);
  };

  // ---- MARC (by ISBN) — covers lcshSubjects, pageCount, ddc, publisher.
  const marcFields = ['lcshSubjects', 'pageCount', 'ddc', 'publisher'];
  const needsMarc =
    !!result.isbn && marcFields.some((f) => empties.includes(f));
  if (needsMarc) {
    const marc = await lookupFullMarcByIsbn(result.isbn).catch(() => null);
    if (!marc) {
      log.tier('gap-fill', '  marc → no record');
    } else {
      if (
        empties.includes('lcshSubjects') &&
        marc.lcshSubjects.length > 0 &&
        (!result.lcshSubjects || result.lcshSubjects.length === 0)
      ) {
        result.lcshSubjects = marc.lcshSubjects;
        log.tier('gap-fill', `  lcshSubjects ← marc (${marc.lcshSubjects.length} headings)`);
        stamp('lcshSubjects', 'marc');
      }
      if (empties.includes('pageCount') && marc.pageCount && !result.pageCount) {
        result.pageCount = marc.pageCount;
        log.tier('gap-fill', `  pageCount ← marc (${marc.pageCount})`);
        stamp('pageCount', 'marc');
      }
      if (empties.includes('ddc') && marc.ddc && !result.ddc) {
        result.ddc = marc.ddc;
        log.tier('gap-fill', `  ddc ← marc (${JSON.stringify(marc.ddc)})`);
        stamp('ddc', 'marc');
      }
      if (empties.includes('publisher') && marc.publisher && !result.publisher) {
        result.publisher = marc.publisher;
        log.tier('gap-fill', `  publisher ← marc (${JSON.stringify(marc.publisher)})`);
        stamp('publisher', 'marc');
      }
    }
  }

  // ---- Open Library (by ISBN) — covers synopsis, pageCount, publicationYear,
  //      publisher (when MARC missed). Synopsis triggers a work-record fetch.
  const stillEmpty = (f: string) => empties.includes(f) && !filled.includes(f);
  const olFields = ['synopsis', 'pageCount', 'publicationYear', 'publisher'];
  const needsOl = !!result.isbn && olFields.some(stillEmpty);
  if (needsOl) {
    const wantsWork = stillEmpty('synopsis');
    const ol = await gapFillFromOpenLibrary(result.isbn, wantsWork);
    if (Object.keys(ol).length === 0) {
      log.tier('gap-fill', '  openlibrary → no record');
    } else {
      if (stillEmpty('synopsis') && ol.synopsis) {
        result.synopsis = ol.synopsis;
        log.tier('gap-fill', `  synopsis ← openlibrary (${ol.synopsis.length} chars)`);
        stamp('synopsis', 'openlibrary');
      }
      if (stillEmpty('pageCount') && ol.pageCount) {
        result.pageCount = ol.pageCount;
        log.tier('gap-fill', `  pageCount ← openlibrary (${ol.pageCount})`);
        stamp('pageCount', 'openlibrary');
      }
      if (stillEmpty('publicationYear') && ol.publicationYear) {
        result.publicationYear = ol.publicationYear;
        log.tier('gap-fill', `  publicationYear ← openlibrary (${ol.publicationYear})`);
        stamp('publicationYear', 'openlibrary');
      }
      if (stillEmpty('publisher') && ol.publisher) {
        result.publisher = ol.publisher;
        log.tier('gap-fill', `  publisher ← openlibrary (${JSON.stringify(ol.publisher)})`);
        stamp('publisher', 'openlibrary');
      }
    }
  }

  // ---- Wikidata (by ISBN) — DDC fallback when MARC missed.
  if (stillEmpty('ddc') && result.isbn) {
    const wd = await lookupWikidataByIsbn(result.isbn, log).catch(() => null);
    if (wd?.ddc && !result.ddc) {
      result.ddc = wd.ddc;
      log.tier('gap-fill', `  ddc ← wikidata (${JSON.stringify(wd.ddc)})`);
      stamp('ddc', 'wikidata');
    }
  }

  // ISBN gap-fill via Wikidata title-search is cheap-but-noisy; the
  // existing Wikidata title-search fallback already runs upstream when
  // result.isbn is empty AND result.lcc is empty (or partial). Adding a
  // second pass just for ISBN-only would duplicate that. Skip in v1.

  const stillEmptyFinal = empties.filter((f) => !filled.includes(f));
  log.tier(
    'gap-fill',
    `filled=[${filled.join(',') || '∅'}] still-empty=[${stillEmptyFinal.join(',') || '∅'}]`
  );
}

/**
 * Phase 2 ISBN-direct fan-out + gap-fill merge.
 *
 * Given a partially-populated `BookLookupResult` that already carries an
 * ISBN, run four exact-by-ISBN lookups in parallel — LoC MARC, Google
 * Books, Wikidata, Open Library — then strict gap-fill onto `result`
 * (only fields that are empty/undefined; never overwrite). Mutates
 * `result` in place.
 *
 * Extracted from the inline Phase-2 block in lookupBook so the
 * Reread / matchEdition path (lookupSpecificEdition) can call it too.
 * Without this, that path returns immediately after its OL-by-ISBN /
 * year-scoped / ISBNdb-direct hit and `lcshSubjects` (sourced only
 * from MARC) never populates.
 *
 * Returns the updated `lccSource` provenance tag and the GB-by-ISBN
 * cover URL (caller folds it into `buildCoverChain` so the cover-art
 * fallback chain reflects the GB thumbnail in the correct position).
 *
 * No-op when result.isbn is empty.
 */
async function enrichWithIsbnFanout(
  result: BookLookupResult,
  log: LookupLogger,
  prevLccSource: 'ol' | 'loc' | 'wikidata' | 'inferred' | 'none'
): Promise<{
  lccSource: 'ol' | 'loc' | 'wikidata' | 'inferred' | 'none';
  gbCoverUrl: string;
}> {
  let lccSource = prevLccSource;
  let gbCoverUrl = '';
  if (!result.isbn) {
    return { lccSource, gbCoverUrl };
  }

  log.tier(
    'phase-2',
    `isbn=${result.isbn} → exact lookups: MARC + GB + Wikidata + OL-by-isbn`
  );
  const [marc, gbEnrich, wdHit, olEnrich] = await Promise.all([
    lookupFullMarcByIsbn(result.isbn).catch((err) => {
      log.tier(
        'phase-2',
        `  marc error ${err instanceof Error ? err.message : String(err)}`
      );
      return null as MarcResult | null;
    }),
    gbEnrichByIsbn(result.isbn).catch(() => null as GbIsbnEnrichment | null),
    lookupWikidataByIsbn(result.isbn, log).catch(() => null),
    enrichFromIsbn(result.isbn).catch(() => ({ firstPublishYear: 0, lcc: '' })),
  ]);

  // MARC merge — the richest LoC payload (LCSH headings + 655 genre
  // forms + DDC + page count + edition + co-authors + canonical
  // title/author).
  if (marc) {
    if (marc.lcc && !result.lcc) {
      result.lcc = normalizeLcc(marc.lcc);
      lccSource = 'loc';
      log.tier('phase-2', `  marc filled lcc=${JSON.stringify(result.lcc)}`);
    }
    if (
      marc.lcshSubjects.length > 0 &&
      !(result.lcshSubjects && result.lcshSubjects.length > 0)
    ) {
      result.lcshSubjects = marc.lcshSubjects;
      log.tier('phase-2', `  marc filled lcsh=${marc.lcshSubjects.length}`);
    }
    if (
      marc.marcGenres.length > 0 &&
      !(result.marcGenres && result.marcGenres.length > 0)
    ) {
      result.marcGenres = marc.marcGenres;
      log.tier(
        'phase-2',
        `  marc filled 655 genre/form=${marc.marcGenres.length}`
      );
    }
    if (!result.ddc && marc.ddc) result.ddc = marc.ddc;
    if (!result.pageCount && marc.pageCount) result.pageCount = marc.pageCount;
    if (!result.edition && marc.edition) result.edition = marc.edition;
    if (!result.publisher && marc.publisher) result.publisher = marc.publisher;
    if (!result.canonicalAuthor && marc.author) {
      result.canonicalAuthor = marc.author;
    }
    if (!result.canonicalTitle && marc.title) {
      result.canonicalTitle = marc.title;
    }
    if (marc.coAuthors.length > 0) {
      const merged = new Set<string>(result.allAuthors ?? []);
      if (marc.author) merged.add(marc.author);
      for (const a of marc.coAuthors) merged.add(a);
      if (merged.size > (result.allAuthors?.length ?? 0)) {
        result.allAuthors = Array.from(merged);
      }
    }
  } else {
    log.tier('phase-2', '  marc no record');
  }

  // GB-by-ISBN merge — picks up cover, categories, sometimes a year.
  if (gbEnrich) {
    if (!result.publisher && gbEnrich.publisher) {
      result.publisher = gbEnrich.publisher;
      log.tier(
        'phase-2',
        `  gb-by-isbn filled publisher=${JSON.stringify(gbEnrich.publisher)}`
      );
    }
    if (!result.publicationYear && gbEnrich.publicationYear) {
      result.publicationYear = gbEnrich.publicationYear;
    }
    if (gbEnrich.coverUrl && !gbCoverUrl) gbCoverUrl = gbEnrich.coverUrl;
    // mainCategory is GB's top-level category (BISAC-ish); when it
    // exists, prepend it ahead of the ranked categories so it has the
    // most weight in subject prompting.
    const gbSubjects = [
      ...(gbEnrich.mainCategory ? [gbEnrich.mainCategory] : []),
      ...gbEnrich.subjects,
    ];
    if (gbSubjects.length > 0) {
      const existing = new Set(
        (result.subjects ?? []).map((s) => s.toLowerCase())
      );
      const merged = [...(result.subjects ?? [])];
      for (const s of gbSubjects) {
        if (!existing.has(s.toLowerCase())) merged.push(s);
      }
      result.subjects = merged.slice(0, 15);
    }
    if (!result.synopsis && gbEnrich.description) {
      result.synopsis = gbEnrich.description;
    }
    if (!result.pageCount && gbEnrich.pageCount) {
      result.pageCount = gbEnrich.pageCount;
    }
    if (!result.subtitle && gbEnrich.subtitle) {
      result.subtitle = gbEnrich.subtitle;
    }
    if (!result.language && gbEnrich.language) {
      result.language = gbEnrich.language;
    }
    if (gbEnrich.authors && gbEnrich.authors.length > 0) {
      const existing = new Set(
        (result.allAuthors ?? []).map((a) => a.toLowerCase())
      );
      const merged = [...(result.allAuthors ?? [])];
      for (const a of gbEnrich.authors) {
        if (a && !existing.has(a.toLowerCase())) {
          merged.push(a);
          existing.add(a.toLowerCase());
        }
      }
      if (merged.length > (result.allAuthors?.length ?? 0)) {
        result.allAuthors = merged;
      }
    }
  }

  // Wikidata-by-ISBN merge — exact match via P212. LCC gap-fill +
  // genre/subject signal for tag inference.
  if (wdHit) {
    if (wdHit.lcc && !result.lcc) {
      result.lcc = normalizeLcc(wdHit.lcc);
      lccSource = 'wikidata';
      log.tier(
        'phase-2',
        `  wikidata filled lcc=${JSON.stringify(result.lcc)}`
      );
    }
    if (!result.ddc && wdHit.ddc) result.ddc = wdHit.ddc;
    if (!result.publisher && wdHit.publisher) result.publisher = wdHit.publisher;
    if (!result.publicationYear && wdHit.publicationYear) {
      result.publicationYear = wdHit.publicationYear;
    }
    if (!result.pageCount && wdHit.pageCount) {
      result.pageCount = wdHit.pageCount;
    }
    if (!result.series && wdHit.series) result.series = wdHit.series;
    if (wdHit.genre || wdHit.subject) {
      const existing = new Set(
        (result.subjects ?? []).map((s) => s.toLowerCase())
      );
      const merged = [...(result.subjects ?? [])];
      for (const v of [wdHit.genre, wdHit.subject]) {
        if (v && !existing.has(v.toLowerCase())) {
          merged.push(v);
          existing.add(v.toLowerCase());
        }
      }
      result.subjects = merged.slice(0, 15);
    }
  }

  // OL-by-ISBN merge — last gap-filler for year/LCC.
  if (olEnrich) {
    if (!result.publicationYear && olEnrich.firstPublishYear) {
      result.publicationYear = olEnrich.firstPublishYear;
    }
    if (!result.lcc && olEnrich.lcc) {
      result.lcc = normalizeLcc(olEnrich.lcc);
      lccSource = 'ol';
    }
  }

  return { lccSource, gbCoverUrl };
}

/**
 * Build the deduped cover-URL chain for a book.
 *
 * Order (highest priority first, all optional):
 *   1. Open Library Covers API by ISBN (when ISBN is present) — uses
 *      `?default=false` so missing covers 404 instead of returning a
 *      grey placeholder, which lets `<Cover>`'s onError chain advance
 *      cleanly to the next URL.
 *   2. Google Books `imageLinks.thumbnail` (when supplied).
 *   3. ISBNdb `image` field (when supplied).
 *   4. Any pre-existing fallbacks already on the result.
 *
 * Returns `{ primary, fallbacks }`. `primary` is the first non-empty URL;
 * `fallbacks` is the full deduped chain (including primary as element 0).
 * Both are empty when no source produced a URL.
 *
 * Extracted from lookupBook's terminal cover-art block so every code
 * path that constructs a BookLookupResult — lookupBook itself, all
 * three lookupSpecificEdition branches — uses identical chain logic
 * instead of each one open-coding a different subset.
 */
function buildCoverChain(
  isbn: string | undefined,
  gbThumbnail?: string,
  isbndbImage?: string,
  existingFallbacks?: string[]
): { primary: string; fallbacks: string[] } {
  const chain: string[] = [];
  if (isbn) {
    const cleaned = isbn.replace(/[^\dxX]/g, '');
    if (cleaned) {
      chain.push(`https://covers.openlibrary.org/b/isbn/${cleaned}-M.jpg?default=false`);
    }
  }
  if (gbThumbnail) chain.push(gbThumbnail);
  if (isbndbImage) chain.push(isbndbImage);
  if (Array.isArray(existingFallbacks)) {
    for (const u of existingFallbacks) chain.push(u);
  }
  const deduped = Array.from(new Set(chain.filter(Boolean)));
  return { primary: deduped[0] ?? '', fallbacks: deduped };
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

// ---------------------------------------------------------------------------
// OL ISBN-direct helpers — used by lookupSpecificEdition tier 1.
//
// search.json?isbn= returns the WORK-level document, which means
// `publisher` is a union array across every edition of the work.
// `doc.publisher[0]` therefore reflects whichever edition happens to be
// first in OL's internal order — frequently a different edition than
// the one the user actually owns.
//
// /api/books?bibkeys=ISBN: returns the EDITION-level document for the
// exact ISBN. `publishers[0].name` is the publisher of THAT edition.
//
// Empirically verified on ISBN 9781982156916 (Folger Shakespeare's
// Cymbeline):
//   - search.json?isbn=...        → publisher=["Signet Classics"]   (wrong)
//   - api/books?bibkeys=ISBN:...  → publishers=[{name:"Simon & Schuster"}]  (correct)
//
// Both helpers normalize their respective response shapes into a
// single OlIsbnResult so the caller doesn't care which endpoint won.
// ---------------------------------------------------------------------------

interface OlEditionDoc {
  title?: string;
  publishers?: { name?: string }[];
  publish_date?: string;
  number_of_pages?: number;
  classifications?: { lc_classifications?: string[]; dewey_decimal_class?: string[] };
  authors?: { name?: string }[];
  subjects?: ({ name?: string } | string)[];
}

interface OlIsbnResult {
  publisher: string;
  publicationYear: number;
  pageCount: number;
  lcc: string;
  title: string;
  author: string;
  allAuthors: string[];
  subjects: string[];
  /** True if lcc came directly from the OL response (vs empty). Drives
   *  initialLccSource so the fan-out can record the right provenance. */
  hadLcc: boolean;
}

async function fetchOlByIsbnEdition(
  isbn: string,
  log: LookupLogger
): Promise<OlIsbnResult | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=data&format=json`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
  } catch (err) {
    log.tier(
      'ol-by-isbn (edition)',
      `error ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!res.ok) {
    log.tier('ol-by-isbn (edition)', `GET ${url} → ${res.status} (skip)`);
    return null;
  }
  let data: Record<string, OlEditionDoc>;
  try {
    data = (await res.json()) as Record<string, OlEditionDoc>;
  } catch {
    log.tier('ol-by-isbn (edition)', `GET ${url} → 200 → parse error`);
    return null;
  }
  const doc = data[`ISBN:${isbn}`];
  if (!doc) {
    log.tier(
      'ol-by-isbn (edition)',
      `GET ${url} → 200 → 0 docs (falling back to search.json)`
    );
    return null;
  }
  const lcc =
    (doc.classifications?.lc_classifications ?? []).find(
      (s) => typeof s === 'string' && s.length > 0
    ) ?? '';
  const allAuthors = (doc.authors ?? [])
    .map((a) => (typeof a?.name === 'string' ? a.name.trim() : ''))
    .filter(Boolean);
  const subjects = (doc.subjects ?? [])
    .map((s) => {
      if (typeof s === 'string') return s.trim();
      return typeof s?.name === 'string' ? s.name.trim() : '';
    })
    .filter(Boolean)
    .slice(0, 10);
  const result: OlIsbnResult = {
    publisher:
      typeof doc.publishers?.[0]?.name === 'string'
        ? doc.publishers[0].name.trim()
        : '',
    publicationYear: doc.publish_date ? parsePublishDateYear([doc.publish_date]) : 0,
    pageCount:
      typeof doc.number_of_pages === 'number' && doc.number_of_pages > 0
        ? doc.number_of_pages
        : 0,
    lcc,
    title: typeof doc.title === 'string' ? doc.title.trim() : '',
    author: allAuthors[0] ?? '',
    allAuthors,
    subjects,
    hadLcc: lcc.length > 0,
  };
  log.tier('ol-by-isbn (edition)', `GET ${url} → 200 → matched`);
  log.tier(
    'ol-by-isbn (edition)',
    `publisher=${JSON.stringify(result.publisher)} pages=${result.pageCount || '-'} year=${result.publicationYear || '-'}`
  );
  return result;
}

async function fetchOlByIsbnSearch(
  isbn: string,
  log: LookupLogger
): Promise<OlIsbnResult | null> {
  const url =
    `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}` +
    `&fields=key,title,author_name,isbn,publisher,first_publish_year,publish_year,publish_date,lcc,lc_classifications,subject,number_of_pages_median`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
  } catch (err) {
    log.tier(
      'ol-by-isbn (work-level fallback)',
      `error ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!res.ok) {
    log.tier(
      'ol-by-isbn (work-level fallback)',
      `GET ${url} → ${res.status} (skip)`
    );
    return null;
  }
  let data: { docs?: OpenLibraryDoc[] };
  try {
    data = (await res.json()) as { docs?: OpenLibraryDoc[] };
  } catch {
    log.tier(
      'ol-by-isbn (work-level fallback)',
      `GET ${url} → 200 → parse error`
    );
    return null;
  }
  const doc = data.docs?.[0];
  if (!doc) {
    log.tier(
      'ol-by-isbn (work-level fallback)',
      `GET ${url} → 200 → 0 docs (fall through to year-scoped)`
    );
    return null;
  }
  const lcc =
    (doc.lcc && doc.lcc[0]) ||
    (doc.lc_classifications && doc.lc_classifications[0]) ||
    '';
  const result: OlIsbnResult = {
    publisher: typeof doc.publisher?.[0] === 'string' ? doc.publisher[0].trim() : '',
    publicationYear:
      doc.first_publish_year ||
      parsePublishDateYear(doc.publish_date) ||
      (doc.publish_year && doc.publish_year[0]) ||
      0,
    pageCount:
      typeof doc.number_of_pages_median === 'number' && doc.number_of_pages_median > 0
        ? doc.number_of_pages_median
        : 0,
    lcc,
    title: doc.title?.trim() ?? '',
    author: doc.author_name?.[0]?.trim() ?? '',
    allAuthors:
      doc.author_name && doc.author_name.length > 0 ? [...doc.author_name] : [],
    subjects: doc.subject?.slice(0, 10) ?? [],
    hadLcc: !!(doc.lcc?.[0] || doc.lc_classifications?.[0]),
  };
  log.tier('ol-by-isbn (work-level fallback)', `GET ${url} → 200 → matched`);
  return result;
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
  hints: { year?: number; publisher?: string; isbn?: string },
  options?: {
    extractedEdition?: string;
    extractedSeries?: string;
    extractedCallNumber?: string;
    extractedCallNumberSystem?: string;
  }
): Promise<BookLookupResult> {
  const log = createLookupLogger(`edition:${title}`);
  log.start({ title, author, isbn: hints.isbn });
  // Strip a leading "ed. " / "eds. " editor-marker prefix before any
  // downstream API query. None of OL / ISBNdb / GB / Wikidata index
  // editors with that prefix, so anthology lookups silently failed
  // when "ed. Michael Schumacher" reached them as the author. The
  // displayed BookRecord author still keeps the prefix — this is a
  // query-time strip only.
  const { author: queryAuthor, isEditor } = stripEditorPrefix(author);
  if (isEditor) {
    log.tier(
      'edit-prefix',
      `editor-attributed: dropping author from query params (was ${JSON.stringify(author)})`
    );
  }
  // The author value sent to lookup APIs. For editor-attributed books
  // the right thing is to query by title alone — anthologies aren't
  // cataloged under the editor in OL/ISBNdb/MARC/Wikidata. The cleaned
  // queryAuthor stays available for trace readability and provenance.
  const effectiveAuthor = isEditor ? '' : queryAuthor;
  // 1) ISBN path — by far the most specific signal. Edition-level OL
  //    endpoint first (publisher per ISBN), with the work-level
  //    search.json as a fallback when the edition endpoint has no doc.
  if (hints.isbn) {
    const cleaned = hints.isbn.replace(/[^\dxX]/g, '');
    if (cleaned.length === 10 || cleaned.length === 13) {
      let olResult = await fetchOlByIsbnEdition(cleaned, log);
      if (!olResult) {
        olResult = await fetchOlByIsbnSearch(cleaned, log);
      }
      if (olResult) {
        const finalLcc =
          normalizeLcc(olResult.lcc) || normalizeLcc(await lookupLccByIsbn(cleaned));
        // Initial provenance for LCC: OL doc was the primary source,
        // SRU was the fallback. enrichWithIsbnFanout may upgrade to
        // 'loc' or 'wikidata' if a stronger source fills an empty LCC.
        const initialLccSource: 'ol' | 'loc' | 'wikidata' | 'none' = olResult.hadLcc
          ? 'ol'
          : finalLcc
            ? 'loc'
            : 'none';
        const out: BookLookupResult = {
          isbn: cleaned,
          publisher: olResult.publisher || hints.publisher || '',
          publicationYear: olResult.publicationYear || hints.year || 0,
          lcc: finalLcc,
          subjects: olResult.subjects.length > 0 ? olResult.subjects : undefined,
          source: 'openlibrary',
          // Title/author from the OL response — previously dropped
          // (BookLookupResult has no `title`/`author`, only the
          // canonical-* twins). Consumers (addManualBook,
          // scan-pipeline's lookupViaServer) read these directly.
          canonicalTitle: olResult.title || undefined,
          canonicalAuthor: olResult.author || undefined,
          allAuthors:
            olResult.allAuthors.length > 0 ? olResult.allAuthors : undefined,
          // pageCount from edition endpoint when present; the work-level
          // fallback can also surface number_of_pages_median. Either
          // way, populating here saves the gap-fill pass a fetch.
          pageCount: olResult.pageCount > 0 ? olResult.pageCount : undefined,
        };
        log.tier('ol-by-isbn', `matched ${describeFilled(out)}`);
        // Phase-2 fan-out so MARC populates lcshSubjects, etc. The
        // OL-by-ISBN tier alone never had this enrichment, which is
        // why every Reread'd record was missing lcshSubjects.
        const fanout = await enrichWithIsbnFanout(out, log, initialLccSource);
        out.lccSource = fanout.lccSource;
        const cover = buildCoverChain(
          cleaned,
          fanout.gbCoverUrl || undefined,
          undefined,
          out.coverUrlFallbacks
        );
        out.coverUrl = cover.primary || undefined;
        out.coverUrlFallbacks =
          cover.fallbacks.length > 0 ? cover.fallbacks : undefined;
        // Gap-fill on the Reread / matchEdition path. Without this,
        // every Reread bypassed the post-Phase-2 gap-fill pass and
        // landed records with empty lcshSubjects / pageCount / ddc /
        // synopsis even when MARC and OL would have filled them.
        const gapFillProv: BookRecordProvenance = {};
        await runGapFill(out, log, gapFillProv);
        const baseProv = inferProvenanceFromResult(out, out.lccSource ?? 'none');
        attachProvenance(out, { ...baseProv, ...gapFillProv });
        log.finish({ ...out, tier: 'ol-by-isbn' });
        return out;
      }
    } else {
      log.tier('ol-by-isbn', `skipped — hint ISBN length ${cleaned.length} not 10 or 13`);
    }
  }

  // 2) Year-scoped search (with publisher tie-breaker).
  if (title && hints.year) {
    try {
      const cleanedAuthor = cleanAuthorForQuery(effectiveAuthor);
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
        const cleanedAuthorForScore = cleanAuthorForQuery(effectiveAuthor);
        const spineLccClass =
          options?.extractedCallNumberSystem === 'lcc' && options.extractedCallNumber
            ? lccClass(options.extractedCallNumber) || undefined
            : undefined;
        const scoreHints: ScoreHints | undefined =
          options?.extractedEdition || options?.extractedSeries || spineLccClass
            ? {
                extractedEdition: options?.extractedEdition || undefined,
                extractedSeries: options?.extractedSeries || undefined,
                extractedLccClass: spineLccClass,
              }
            : undefined;
        // Score each non-study-guide doc with full breakdown so the
        // top-3 trace and threshold check work the same as Phase 1.
        // Tier 2 adds a +4 publisherHint rule on top of the standard
        // scoreDoc rules — that contribution is folded into the
        // breakdown so it shows up in the trace line.
        const ranked = docs
          .filter((d) => !isStudyGuide(d))
          .map((d) => {
            const breakdown = scoreDocBreakdown(d, title, cleanedAuthorForScore, scoreHints);
            if (publisherHint && d.publisher) {
              const pubMatch = d.publisher.some((p) =>
                p.toLowerCase().includes(publisherHint) ||
                publisherHint.includes(p.toLowerCase())
              );
              if (pubMatch) {
                breakdown.rules.publisherHint = 4;
                breakdown.total += 4;
              }
            }
            return { d, breakdown };
          })
          .sort((a, b) => b.breakdown.total - a.breakdown.total);

        // Top-3 trace block — same format as Phase 1.
        if (ranked.length > 0) {
          log.tier('ol-year-scoped', 'top candidates considered:');
          for (let i = 0; i < Math.min(3, ranked.length); i++) {
            const { d, breakdown } = ranked[i];
            log.tier(
              'ol-year-scoped',
              `  [${i + 1}] score=${breakdown.total} title=${JSON.stringify(d.title ?? '')} — ${formatBreakdown(breakdown)}`
            );
          }
        }

        const top = ranked[0];
        // Below-threshold bail-out — fall through to tier 3 (unscoped
        // lookupBook) rather than save a low-scoring wrong-edition
        // year-scoped pick.
        const belowThreshold = !!top && top.breakdown.total < MIN_PHASE1_SCORE;
        // Relevance bail-out — see the matching block in
        // pickBestCandidate. Same rule: a score that clears the floor
        // entirely from metadata-presence rules with no title/author
        // signal isn't a real match.
        const noRelevance =
          !!top &&
          !belowThreshold &&
          top.breakdown.rules.title === 0 &&
          top.breakdown.rules.author === 0;
        if (belowThreshold) {
          log.tier(
            'ol-year-scoped',
            `highest score=${top.breakdown.total} below threshold=${MIN_PHASE1_SCORE} — returning no-match (fallbacks will run)`
          );
        } else if (noRelevance) {
          log.tier(
            'ol-year-scoped',
            `winner score=${top.breakdown.total} title:0 author:0 — no relevance signal, returning no-match`
          );
        }
        const best = top && !belowThreshold && !noRelevance ? top.d : undefined;
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
          const docHadLcc =
            !!(best.lcc && best.lcc[0]) ||
            !!(best.lc_classifications && best.lc_classifications[0]);
          if (!lcc && isbn) lcc = normalizeLcc(await lookupLccByIsbn(isbn));
          const initialLccSource: 'ol' | 'loc' | 'wikidata' | 'none' = docHadLcc
            ? 'ol'
            : lcc
              ? 'loc'
              : 'none';
          const out: BookLookupResult = {
            isbn,
            publisher: best.publisher?.[0] ?? hints.publisher ?? '',
            publicationYear,
            lcc,
            subjects: best.subject?.slice(0, 10),
            source: 'openlibrary',
            // Same canonical-title/author/cover plumbing as the ISBN
            // branch above — previously dropped.
            canonicalTitle: best.title || undefined,
            canonicalAuthor: best.author_name?.[0] || undefined,
            allAuthors:
              best.author_name && best.author_name.length > 0
                ? [...best.author_name]
                : undefined,
          };
          log.tier('ol-year-scoped', `matched ${describeFilled(out)}`);
          // Phase-2 fan-out — see tier 1 above for the same fix rationale.
          const fanout = await enrichWithIsbnFanout(out, log, initialLccSource);
          out.lccSource = fanout.lccSource;
          const cover = buildCoverChain(
            isbn,
            fanout.gbCoverUrl || undefined,
            undefined,
            out.coverUrlFallbacks
          );
          out.coverUrl = cover.primary || undefined;
          out.coverUrlFallbacks =
            cover.fallbacks.length > 0 ? cover.fallbacks : undefined;
          // Gap-fill on the Reread / matchEdition path — see tier 1.
          const gapFillProv: BookRecordProvenance = {};
          await runGapFill(out, log, gapFillProv);
          const baseProv = inferProvenanceFromResult(out, out.lccSource ?? 'none');
          attachProvenance(out, { ...baseProv, ...gapFillProv });
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
      const hit = await lookupIsbndb(title, effectiveAuthor, cleaned, log);
      if (hit && (hit.isbn || hit.publisher || hit.publicationYear)) {
        const sruLcc = await lookupLccByIsbn(cleaned);
        const isbndbTitle = hit.titleLong || hit.title || undefined;
        const initialLccSource: 'ol' | 'loc' | 'wikidata' | 'none' = sruLcc
          ? 'loc'
          : 'none';
        const out: BookLookupResult = {
          isbn: hit.isbn || cleaned,
          publisher: hit.publisher || hints.publisher || '',
          publicationYear: hit.publicationYear || hints.year || 0,
          lcc: normalizeLcc(sruLcc) || '',
          subjects: hit.subjects.length > 0 ? hit.subjects.slice(0, 10) : undefined,
          source: 'isbndb',
          ddc: hit.ddc || undefined,
          // Canonical title/author/all-authors from the ISBNdb hit —
          // previously dropped. ISBNdb's title_long is preferred when
          // present (it includes subtitles); falls back to title.
          canonicalTitle: isbndbTitle,
          canonicalAuthor: hit.author || undefined,
          allAuthors:
            hit.allAuthors && hit.allAuthors.length > 0 ? hit.allAuthors : undefined,
          // ISBNdb's per-book enrichment fields, when supplied.
          pageCount: hit.pages,
          binding: hit.binding,
          language: hit.language,
          edition: hit.edition,
          synopsis: hit.synopsis,
        };
        log.tier('isbndb-fallback', `matched ${describeFilled(out)}`);
        // Phase-2 fan-out — see tier 1 above for the same fix rationale.
        const fanout = await enrichWithIsbnFanout(out, log, initialLccSource);
        out.lccSource = fanout.lccSource;
        // ISBNdb cover comes directly off the hit; the chain prepends
        // the OL Covers API URL (higher avg quality), folds in any GB
        // cover the fan-out surfaced, then ISBNdb image as a fallback.
        const cover = buildCoverChain(
          out.isbn || cleaned,
          fanout.gbCoverUrl || undefined,
          hit.coverUrl || undefined,
          out.coverUrlFallbacks
        );
        out.coverUrl = cover.primary || hit.coverUrl || undefined;
        out.coverUrlFallbacks =
          cover.fallbacks.length > 0 ? cover.fallbacks : undefined;
        // Gap-fill on the Reread / matchEdition path — see tier 1.
        const gapFillProv: BookRecordProvenance = {};
        await runGapFill(out, log, gapFillProv);
        const baseProv = inferProvenanceFromResult(out, out.lccSource ?? 'none');
        attachProvenance(out, { ...baseProv, ...gapFillProv });
        log.finish({ ...out, tier: 'isbndb-direct' });
        return out;
      }
    }
  }

  // 4) Fall back to the unscoped chain. Pass effectiveAuthor — for
  // editor-attributed books that's empty (drops author from queries
  // entirely); for normal books it's the cleaned queryAuthor. Forward
  // the spine-extracted hints so lookupBook's Phase-1 scorer applies
  // the same series/edition tie-breakers.
  log.tier('fallback', 'invoking unscoped lookupBook');
  return lookupBook(title, effectiveAuthor, options);
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
    // OL work-record `subjects` — silently dropped before the audit.
    // The search-level `subject` already populated `out.subjects`; merge
    // the work-level entries deduped on top, then re-cap at 10 to keep
    // the same prompt budget the search-level alone respected.
    if (workRecord?.subjects && workRecord.subjects.length > 0) {
      const existing = new Set((out.subjects ?? []).map((s) => s.toLowerCase()));
      const merged = [...(out.subjects ?? [])];
      for (const s of workRecord.subjects) {
        if (s && !existing.has(s.toLowerCase())) {
          merged.push(s);
          existing.add(s.toLowerCase());
        }
      }
      out.subjects = merged.slice(0, 10);
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

/**
 * Wikidata-by-ISBN. Exact lookup via P212 — no fuzzy CONTAINS filter,
 * no title-match guesswork. When we already have an ISBN (winning
 * Phase-1 candidate), this is the precise way to ask Wikidata for
 * its LCC / DDC / genre / subject / series. Used by the Phase-2
 * targeted-enrichment fan-out.
 */
export async function lookupWikidataByIsbn(
  isbn: string,
  logger?: LookupLogger
): Promise<WikidataHit | null> {
  if (!isbn) return null;
  const cleaned = isbn.replace(/[^\dxX]/g, '');
  if (cleaned.length !== 10 && cleaned.length !== 13) {
    logger?.tier('wikidata-isbn', `skipped — invalid ISBN length ${cleaned.length}`);
    return null;
  }
  const sparql = `SELECT ?item ?itemLabel ?isbn13 ?lcc ?ddc ?authorLabel ?publisherLabel ?pubdate ?genreLabel ?subjectLabel ?pages ?seriesLabel WHERE {
  ?item wdt:P212 "${cleaned}".
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
  try {
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
    });
    if (!res.ok) {
      logger?.tier('wikidata-isbn', `query.wikidata.org/sparql by isbn → ${res.status} (skip)`);
      return null;
    }
    const data = (await res.json()) as { results?: { bindings?: WikidataBinding[] } };
    const bindings = data.results?.bindings ?? [];
    if (bindings.length === 0) {
      logger?.tier('wikidata-isbn', `query.wikidata.org/sparql by isbn=${cleaned} → 200 → 0 bindings`);
      return null;
    }
    // Direct ISBN match — first binding is by definition the right book.
    const best = bindings[0];
    const pagesRaw = best.pages?.value;
    const pageCount = pagesRaw ? parseInt(pagesRaw, 10) : 0;
    const hit: WikidataHit = {
      lcc: (best.lcc?.value ?? '').trim(),
      ddc: (best.ddc?.value ?? '').trim(),
      isbn: cleaned,
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
      'wikidata-isbn',
      `query.wikidata.org/sparql by isbn=${cleaned} → 200 → matched ${JSON.stringify(
        best.itemLabel?.value ?? ''
      )}${hit.lcc ? ` lcc=${JSON.stringify(hit.lcc)}` : ''}`
    );
    return hit;
  } catch (err) {
    logger?.tier('wikidata-isbn', `error ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase-1 candidate discovery — unified shape so OL and ISBNdb hits can be
// scored against each other by the same pickBestDoc function. ISBNdb's raw
// IsbndbBook is mapped into the OL doc shape so existing scoring keeps
// working without a rewrite. The `source` discriminator + `isbndbRaw` keep
// ISBNdb-specific data accessible after the winner is picked.
// ---------------------------------------------------------------------------
type Candidate = OpenLibraryDoc & {
  source: 'openlibrary' | 'isbndb';
  isbndbRaw?: IsbndbBook;
};

function isbndbToCandidate(b: IsbndbBook): Candidate {
  const isbns = [b.isbn13, b.isbn].filter((x): x is string => !!x).map((s) => s.trim());
  // Parse year out of date_published; ISBNdb often returns "2012-09-18"
  // or "2012". Reuse parseIsbndbYear for consistency with the existing
  // mapper.
  const year = parseIsbndbYear(b.date_published);
  return {
    source: 'isbndb',
    title: b.title_long || b.title || '',
    author_name: Array.isArray(b.authors) ? b.authors.map(String) : undefined,
    isbn: isbns.length > 0 ? isbns : undefined,
    publisher: b.publisher ? [b.publisher] : undefined,
    first_publish_year: year || undefined,
    publish_date: b.date_published ? [b.date_published] : undefined,
    subject: Array.isArray(b.subjects) ? b.subjects.map(String) : undefined,
    number_of_pages_median: typeof b.pages === 'number' && b.pages > 0 ? b.pages : undefined,
    isbndbRaw: b,
  };
}

/**
 * Single-call OL candidates — full title + cleaned author. Returns up
 * to 10 docs for the unified scorer. This replaces the prior
 * five-rung OL ladder; the ladder's permissive variants are no longer
 * needed because (a) ISBNdb's title-search runs in parallel and
 * supplies its own candidates and (b) the unified scorer's filter
 * already accepts close-but-not-exact title matches via
 * titleSubstringMatch.
 */
async function fetchOpenLibraryCandidates(
  searchTitle: string,
  cleanedAuthor: string,
  log: LookupLogger
): Promise<Candidate[]> {
  const p = new URLSearchParams();
  p.set('title', searchTitle);
  if (cleanedAuthor) p.set('author', cleanedAuthor);
  p.set('limit', '10');
  p.set('fields', OL_FIELDS);
  const url = `https://openlibrary.org/search.json?${p.toString()}`;
  // Marker for trace readers: when the author is deliberately omitted
  // (editor-attributed lookup, or no spine author), the URL won't carry
  // an &author= clause. Surfacing it here makes that intentional in the
  // trace rather than ambiguous.
  const noAuthorMarker = cleanedAuthor ? '' : ' (no author)';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      cache: 'no-store',
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) {
      log.tier('discover-ol', `GET ${url} → ${res.status} (skip)${noAuthorMarker}`);
      return [];
    }
    const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
    const docs = data.docs ?? [];
    log.tier('discover-ol', `GET ${url} → ${res.status} → ${docs.length} doc(s)${noAuthorMarker}`);
    return docs.map<Candidate>((d) => ({ ...d, source: 'openlibrary' }));
  } catch (err) {
    log.tier('discover-ol', `error ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function fetchIsbndbCandidates(
  searchTitle: string,
  cleanedAuthor: string,
  log: LookupLogger
): Promise<Candidate[]> {
  const apiKey = process.env.ISBNDB_API_KEY;
  if (!apiKey) {
    if (!isbndbKeyMissingWarned) {
      console.warn('[isbndb] ISBNDB_API_KEY not set — tier disabled.');
      isbndbKeyMissingWarned = true;
    }
    log.tier('discover-isbndb', 'skipped — ISBNDB_API_KEY not set');
    return [];
  }
  const queryTokens = [searchTitle.trim(), lastName(cleanedAuthor).trim()].filter(Boolean).join(' ');
  if (!queryTokens) {
    log.tier('discover-isbndb', 'skipped — empty title and author');
    return [];
  }
  const url = `https://api2.isbndb.com/books/${encodeURIComponent(queryTokens)}`;
  // See discover-ol for the noAuthor-marker rationale.
  const noAuthorMarker = cleanedAuthor ? '' : ' (no author)';
  try {
    const res = await isbndbFetch(url, apiKey);
    if (!res) {
      log.tier('discover-isbndb', `${url} → no response (auth or rate-limit)`);
      return [];
    }
    if (!res.ok) {
      log.tier('discover-isbndb', `GET ${url} → ${res.status} (skip)${noAuthorMarker}`);
      return [];
    }
    const data = (await res.json()) as { books?: IsbndbBook[] };
    const books = data.books ?? [];
    log.tier('discover-isbndb', `GET ${url} → ${res.status} → ${books.length} book(s)${noAuthorMarker}`);
    return books.map(isbndbToCandidate);
  } catch (err) {
    log.tier('discover-isbndb', `error ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Unified scorer/picker over a Candidate[] from any source. Same
 * scoring rules as pickBestDoc but operates on the discriminated
 * shape so the winner's `source` + `isbndbRaw` stay accessible to
 * the caller for Phase-2 enrichment.
 */
function pickBestCandidate(
  candidates: Candidate[],
  title: string,
  author: string,
  hints?: ScoreHints,
  log?: LookupLogger
): { winner: Candidate; score: number; breakdown: ScoreBreakdown } | undefined {
  if (candidates.length === 0) return undefined;
  // Filter out study guides + companion texts BEFORE ranking.
  const filtered = candidates.filter((d) => !isStudyGuide(d));
  if (filtered.length === 0) return undefined;
  // Restrict to docs whose title or author plausibly matches.
  const relevant = filtered.filter(
    (d) =>
      titleSubstringMatch(title, d.title) ||
      (author && authorMatches(author, d.author_name))
  );
  const pool = relevant.length > 0 ? relevant : filtered;

  // Score every candidate with breakdown so the top-3 trace can show
  // each rule's actual contribution.
  const scored = pool
    .map((d) => ({ d, breakdown: scoreDocBreakdown(d, title, author, hints) }))
    .sort((a, b) => b.breakdown.total - a.breakdown.total);

  // Top-3 trace block — primary observability for "why did this win?"
  // and "what did it beat?" diagnoses.
  if (log) {
    log.tier('phase-1', 'top candidates considered:');
    for (let i = 0; i < Math.min(3, scored.length); i++) {
      const { d, breakdown } = scored[i];
      log.tier(
        'phase-1',
        `  [${i + 1}] score=${breakdown.total} source=${d.source} title=${JSON.stringify(d.title ?? '')} — ${formatBreakdown(breakdown)}`
      );
    }
  }

  const top = scored[0];
  if (!top) return undefined;

  // Below-threshold bail-out — return undefined so the caller treats
  // this as "no Phase 1 winner" and the no-Phase-1-winner fallbacks
  // (or the caller's own no-match path) take over rather than us
  // confidently saving a low-scoring wrong-edition pick.
  if (top.breakdown.total < MIN_PHASE1_SCORE) {
    log?.tier(
      'phase-1',
      `highest score=${top.breakdown.total} below threshold=${MIN_PHASE1_SCORE} — returning no-match (fallbacks will run)`
    );
    return undefined;
  }

  // Relevance bail-out — even when total >= MIN_PHASE1_SCORE, the
  // winner must show at least one relevance signal (title-token or
  // author-token). A score of 7 entirely from metadata-presence rules
  // (isbn:2 lcc:3 publisher:1 year:1) with title:0 author:0 is a
  // no-match in disguise — produced by under-described queries like
  // "The Portable" with empty author, where any well-cataloged book
  // with an isbn+lcc+publisher trips the threshold without actually
  // matching what was searched.
  if (top.breakdown.rules.title === 0 && top.breakdown.rules.author === 0) {
    log?.tier(
      'phase-1',
      `winner score=${top.breakdown.total} title:0 author:0 — no relevance signal, returning no-match`
    );
    return undefined;
  }

  log?.tier(
    'phase-1',
    `winner [1] source=${top.d.source} score=${top.breakdown.total}`
  );
  return { winner: top.d, score: top.breakdown.total, breakdown: top.breakdown };
}

// ---------------------------------------------------------------------------
// In-memory lookup cache. ISBN-keyed when an ISBN is available (most
// reliable), title|author-keyed otherwise. Survives across requests
// within the same Vercel function instance — duplicate lookups inside
// a batch (or repeated rereads of the same book) skip the network and
// every paid ISBNdb call.
// ---------------------------------------------------------------------------
const lookupCache = new Map<string, BookLookupResult & { tier?: string }>();

function cacheKeyForInput(title: string, author: string): string {
  const t = normalize(title);
  const a = normalize(author);
  return `ta:${t}|${a}`;
}

/**
 * Cache key for editor-attributed lookups — title only, no author
 * component. Editor-attributed books are queried by title alone (the
 * editor's name is not in any of the source databases as the work's
 * author), so they share a single cache row with future title-only
 * lookups of the same anthology rather than fragmenting per-editor.
 */
function cacheKeyForTitleOnly(title: string): string {
  return `t:${normalize(title)}`;
}
function cacheKeyForIsbn(isbn: string): string {
  return `isbn:${isbn.replace(/[^\dxX]/g, '').toUpperCase()}`;
}

export async function lookupBook(
  title: string,
  author: string,
  options?: {
    extractedEdition?: string;
    extractedSeries?: string;
    extractedCallNumber?: string;
    extractedCallNumberSystem?: string;
  }
): Promise<BookLookupResult & { tier?: string }> {
  const log = createLookupLogger(title);
  log.start({ title, author });

  if (!title) {
    log.tier('input', 'no title — returning empty result');
    const empty = { isbn: '', publisher: '', publicationYear: 0, lcc: '', source: 'none' as const, tier: 'none' };
    log.finish(empty);
    return empty;
  }

  // Strip a leading "ed. " / "eds. " editor-marker prefix BEFORE any
  // cache lookup or downstream API query. Anthology editors get
  // tagged "ed. Name" by the Pass-B prompt; that prefix has to come
  // off (and for editor-attributed books, the author has to be
  // dropped from queries entirely) before queries hit OL / ISBNdb /
  // GB / Wikidata. The original `author` value still flows to the
  // BookRecord display.
  const { author: queryAuthor, isEditor } = stripEditorPrefix(author);
  if (isEditor) {
    log.tier(
      'edit-prefix',
      `editor-attributed: dropping author from query params (was ${JSON.stringify(author)})`
    );
    // Defensive: invalidate poisoned cache entries from prior runs
    // under either the raw "ed. Name" key or the cleaned-name `ta:`
    // key. The new shape is `t:title` for editor-attributed lookups;
    // any old entry would shadow a fresh attempt otherwise.
    for (const candidate of [
      cacheKeyForInput(title, author),
      cacheKeyForInput(title, queryAuthor),
    ]) {
      if (lookupCache.has(candidate)) {
        lookupCache.delete(candidate);
        log.tier('cache', `invalidated poisoned entry under ${JSON.stringify(candidate)} (editor-attributed: keying as t:)`);
      }
    }
  }

  // The author value sent to lookup APIs and used in the cache key.
  // Empty for editor-attributed books so anthologies are queried by
  // title alone; the cleaned name otherwise.
  const effectiveAuthor = isEditor ? '' : queryAuthor;

  // Cache lookup. Editor-attributed → title-only key; otherwise
  // title|author. ISBN-keyed cache writes happen separately when a
  // result lands (ISBN keys aren't author-dependent at all).
  const taKey = isEditor ? cacheKeyForTitleOnly(title) : cacheKeyForInput(title, effectiveAuthor);
  const cached = lookupCache.get(taKey);
  if (cached) {
    log.tier('cache', `hit ${taKey} — returning cached result`);
    log.finish(cached);
    return cached;
  }

  // Sanitized search-only copies. Originals still flow downstream for
  // display / grounding.
  const searchTitle = sanitizeForSearch(title);
  const searchAuthor = sanitizeForSearch(effectiveAuthor);
  const cleanedAuthor = cleanAuthorForQuery(searchAuthor);

  let result: BookLookupResult = {
    isbn: '',
    publisher: '',
    publicationYear: 0,
    lcc: '',
    source: 'none',
  };
  let tier = '';
  let gbCoverUrl = '';
  let isbndbCoverUrl = '';
  let lccSource: 'ol' | 'loc' | 'wikidata' | 'inferred' | 'none' = 'none';
  // Provenance v1 — captures any LCC value that lost the partial→complete
  // upgrade so the audit trail keeps the prior source. Other fields rely
  // on inferProvenanceFromResult's heuristic end-of-function attribution.
  const lccAlternates: Array<{ source: SourceTag; value: unknown }> = [];

  // -------------------------------------------------------------------------
  // PHASE 1 — candidate discovery.
  //
  // Query ISBNdb and Open Library IN PARALLEL with the same spine-read
  // title + cleaned author. Collect all hits from both sources into a
  // unified Candidate array, then run the existing pickBestDoc scoring
  // (author-token match, LCC presence, ISBN confidence, study-guide
  // filter, KDP penalty) across the combined pool. The single best
  // candidate wins regardless of source.
  // -------------------------------------------------------------------------
  log.tier('phase-1', 'parallel discovery: ISBNdb + Open Library');
  const [olCandidates, isbndbCandidates] = await Promise.all([
    fetchOpenLibraryCandidates(searchTitle, cleanedAuthor, log),
    fetchIsbndbCandidates(searchTitle, cleanedAuthor, log),
  ]);
  const candidates: Candidate[] = [...olCandidates, ...isbndbCandidates];
  log.tier(
    'phase-1',
    `combined ${olCandidates.length} OL + ${isbndbCandidates.length} ISBNdb = ${candidates.length} candidate(s)`
  );

  // Spine-extracted hints from Pass-B OCR. Pass to the scorer so
  // spine evidence (series imprint, edition statement, sticker LCC
  // class) tips selection toward the candidate that matches the
  // physical book. extractedCallNumber only contributes when the
  // spine read attributed it to LCC (system === 'lcc'); DDC stickers
  // don't go through this rule.
  const spineLccClass =
    options?.extractedCallNumberSystem === 'lcc' && options.extractedCallNumber
      ? lccClass(options.extractedCallNumber) || undefined
      : undefined;
  const scoreHints: ScoreHints | undefined =
    options?.extractedEdition || options?.extractedSeries || spineLccClass
      ? {
          extractedEdition: options?.extractedEdition || undefined,
          extractedSeries: options?.extractedSeries || undefined,
          extractedLccClass: spineLccClass,
        }
      : undefined;
  const pickResult = pickBestCandidate(
    candidates,
    searchTitle,
    cleanedAuthor,
    scoreHints,
    log
  );
  if (pickResult) {
    const winner = pickResult.winner;

    // Materialize the winner into the shared BookLookupResult shape.
    const isbn = pickIsbn(winner.isbn);
    const publisher = winner.publisher?.[0] ?? '';
    const publicationYear =
      winner.first_publish_year ||
      parsePublishDateYear(winner.publish_date) ||
      (winner.publish_year && winner.publish_year[0]) ||
      0;
    let lcc =
      (winner.lcc && winner.lcc[0]) ??
      (winner.lc_classifications && winner.lc_classifications[0]) ??
      '';
    // OL winners may need a work-level fallback for LCC; ISBNdb winners
    // never carry LCC and skip this step.
    if (winner.source === 'openlibrary' && !lcc && winner.key) {
      lcc = await fetchWorkLcc(winner.key);
    }
    result = {
      isbn,
      publisher,
      publicationYear,
      lcc: normalizeLcc(lcc),
      subjects: winner.subject?.slice(0, 10),
      source: winner.source,
    };
    tier = `phase1-${winner.source}`;
    if (result.lcc) lccSource = 'ol';

    // Phase-1 enrichment fields. ISBNdb winners carry richer metadata
    // (synopsis, page count, edition, binding, language, full author
    // list, cover URL); OL winners carry canonical title/author and
    // optionally a number_of_pages_median.
    if (winner.title) result.canonicalTitle = winner.title;
    if (winner.subtitle) result.subtitle = winner.subtitle;
    if (winner.author_name?.[0]) result.canonicalAuthor = winner.author_name[0];
    if (winner.author_name && winner.author_name.length > 0) {
      result.allAuthors = [...winner.author_name];
    }
    if (winner.number_of_pages_median) result.pageCount = winner.number_of_pages_median;
    if (winner.source === 'isbndb' && winner.isbndbRaw) {
      const ib = winner.isbndbRaw;
      if (!result.canonicalTitle) result.canonicalTitle = ib.title_long || ib.title || undefined;
      if (typeof ib.pages === 'number' && ib.pages > 0) result.pageCount = result.pageCount ?? ib.pages;
      if (ib.binding) result.binding = ib.binding;
      if (ib.language) result.language = ib.language;
      if (ib.edition) result.edition = ib.edition;
      if (ib.synopsis) result.synopsis = ib.synopsis;
      if (ib.dewey_decimal) {
        const ddcRaw = Array.isArray(ib.dewey_decimal) ? ib.dewey_decimal[0] : ib.dewey_decimal;
        result.ddc = String(ddcRaw).trim() || undefined;
      }
      if (ib.image) {
        isbndbCoverUrl = ib.image;
        result.coverUrlFallbacks = result.coverUrlFallbacks ?? [];
        if (!result.coverUrlFallbacks.includes(ib.image)) {
          result.coverUrlFallbacks.push(ib.image);
        }
      }
    }
  } else {
    // pickBestCandidate returns undefined for two cases — empty pool
    // (no candidates at all) or all-below-threshold. In both cases
    // we treat it as "no Phase 1 winner" and let the title-only
    // fallbacks downstream attempt to recover.
    log.tier('phase-1', `no Phase-1 winner across ${candidates.length} candidate(s)`);
  }

  // -------------------------------------------------------------------------
  // PHASE 2 — targeted enrichment by ISBN. Delegates to the shared
  // enrichWithIsbnFanout helper so the Reread / matchEdition path picks
  // up the same fan-out (MARC LCSH/genre, GB cover/synopsis, Wikidata
  // LCC, OL year/LCC) instead of returning early after Phase 1.
  // -------------------------------------------------------------------------
  if (result.isbn) {
    const fanout = await enrichWithIsbnFanout(result, log, lccSource);
    lccSource = fanout.lccSource;
    if (fanout.gbCoverUrl && !gbCoverUrl) gbCoverUrl = fanout.gbCoverUrl;
  } else if (result.source !== 'none') {
    log.tier('phase-2', 'skipped — Phase 1 winner had no ISBN');
  }

  // -------------------------------------------------------------------------
  // No-Phase-1-winner fallbacks. Title-based last-ditch attempts so a
  // book with an unusual spine read still has a chance to resolve.
  // -------------------------------------------------------------------------
  if (result.source === 'none') {
    // GB title-search — sometimes catches what neither OL nor ISBNdb
    // had. When it hits, pulls year/LCC via its own internal ISBN
    // enrichment.
    try {
      const q = `intitle:${encodeURIComponent(searchTitle)}${
        cleanedAuthor ? `+inauthor:${encodeURIComponent(cleanedAuthor)}` : ''
      }`;
      const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
      const baseUrl = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3`;
      const keyedUrl = apiKey ? `${baseUrl}&key=${apiKey}` : baseUrl;
      let res = await fetch(keyedUrl, {
        signal: AbortSignal.timeout(10000),
        cache: 'no-store',
        headers: DEFAULT_HEADERS,
      });
      if (!res.ok && apiKey) {
        log.tier('gb-fallback', `keyed → ${res.status}, retrying unauth'd`);
        res = await fetch(baseUrl, {
          signal: AbortSignal.timeout(10000),
          cache: 'no-store',
          headers: DEFAULT_HEADERS,
        });
      }
      if (!res.ok) {
        log.tier('gb-fallback', `GET ${baseUrl} → ${res.status} (skip)`);
      } else {
        const data = (await res.json()) as {
          items?: Array<{
            volumeInfo: {
              industryIdentifiers?: { type: string; identifier: string }[];
              publisher?: string;
              publishedDate?: string;
              categories?: string[];
              imageLinks?: { thumbnail?: string; smallThumbnail?: string };
              title?: string;
              subtitle?: string;
              authors?: string[];
              description?: string;
              pageCount?: number;
              language?: string;
              mainCategory?: string;
            };
          }>;
        };
        const vi = data.items?.[0]?.volumeInfo;
        if (!vi) {
          log.tier('gb-fallback', `GET ${baseUrl} → ${res.status} → 0 items`);
        } else {
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
          const [enriched, sruLcc] = await Promise.all([
            enrichFromIsbn(isbn),
            lookupLccByIsbn(isbn),
          ]);
          const publicationYear =
            enriched.firstPublishYear || (Number.isFinite(editionYear) ? editionYear : 0);
          // mainCategory carries GB's top-level BISAC-ish classification;
          // when present, prepend so it weights above the ranked categories.
          const baseSubjects = [
            ...(vi.mainCategory ? [vi.mainCategory] : []),
            ...(vi.categories ?? []),
          ];
          result = {
            isbn,
            publisher,
            publicationYear,
            lcc: normalizeLcc(sruLcc || enriched.lcc),
            subjects: baseSubjects.length > 0 ? baseSubjects : undefined,
            source: 'googlebooks',
          };
          if (vi.title) result.canonicalTitle = vi.title;
          if (vi.subtitle) result.subtitle = vi.subtitle;
          if (vi.authors?.[0]) result.canonicalAuthor = vi.authors[0];
          if (vi.authors && vi.authors.length > 0) result.allAuthors = [...vi.authors];
          // Widened-interface gap-fills (audit fix).
          if (vi.description) result.synopsis = vi.description;
          if (typeof vi.pageCount === 'number' && vi.pageCount > 0) result.pageCount = vi.pageCount;
          if (vi.language) result.language = vi.language;
          if (result.lcc) lccSource = sruLcc ? 'loc' : 'ol';
          tier = 'gb-fallback';
          log.tier(
            'gb-fallback',
            `matched isbn=${isbn || '-'} pub=${JSON.stringify(publisher)} year=${publicationYear || '-'} lcc=${JSON.stringify(result.lcc || '')}`
          );
          // GB-fallback hit: re-run Phase 2 with its ISBN.
          if (isbn) {
            const [marc2, wd2] = await Promise.all([
              lookupFullMarcByIsbn(isbn).catch(() => null),
              lookupWikidataByIsbn(isbn, log).catch(() => null),
            ]);
            if (marc2) {
              if (!result.lcc && marc2.lcc) {
                result.lcc = normalizeLcc(marc2.lcc);
                lccSource = 'loc';
              }
              if (marc2.lcshSubjects.length > 0) result.lcshSubjects = marc2.lcshSubjects;
              if (marc2.marcGenres.length > 0) result.marcGenres = marc2.marcGenres;
              if (!result.ddc && marc2.ddc) result.ddc = marc2.ddc;
              if (!result.pageCount && marc2.pageCount) result.pageCount = marc2.pageCount;
              if (!result.edition && marc2.edition) result.edition = marc2.edition;
              if (!result.canonicalAuthor && marc2.author) result.canonicalAuthor = marc2.author;
            }
            if (wd2 && !result.lcc && wd2.lcc) {
              result.lcc = normalizeLcc(wd2.lcc);
              lccSource = 'wikidata';
            }
          }
        }
      }
    } catch (err) {
      log.tier('gb-fallback', `error ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // LoC SRU by title + author — gap-fill when no LCC was set OR when the
  // existing LCC is partial (class-number only, no cutter). Open Library
  // frequently returns class-number-only stubs ("HV5825", "BD221"); LoC's
  // title+author SRU often has the canonical "HV5825 .T67 2005" form.
  // Don't downgrade: only overwrite when the new LCC is itself complete
  // OR the existing one was empty.
  if (!isCompleteLcc(result.lcc) && searchTitle && searchAuthor) {
    const sruLcc = await lookupLccByTitleAuthor(searchTitle, cleanedAuthor);
    if (sruLcc) {
      const normalized = normalizeLcc(sruLcc);
      if (isCompleteLcc(normalized) || !result.lcc) {
        // Demote the prior partial LCC into the alternates list so the
        // provenance audit trail captures the losing source's value.
        if (result.lcc) {
          const priorSource: SourceTag =
            lccSource === 'ol'
              ? 'openlibrary'
              : lccSource === 'wikidata'
                ? 'wikidata'
                : lccSource === 'inferred'
                  ? 'sonnet-infer-lcc'
                  : 'openlibrary';
          lccAlternates.push({ source: priorSource, value: result.lcc });
        }
        result.lcc = normalized;
        lccSource = 'loc';
        log.tier(
          'loc-by-title',
          `lx2.loc.gov/sru by title+author → matched lcc=${JSON.stringify(result.lcc)}`
        );
      } else {
        log.tier(
          'loc-by-title',
          `lx2.loc.gov/sru by title+author → returned partial lcc=${JSON.stringify(normalized)}, keeping existing partial (${lccSource})`
        );
      }
    } else {
      log.tier('loc-by-title', 'lx2.loc.gov/sru by title+author → no LCC');
    }
  } else if (result.lcc) {
    log.tier('loc-by-title', `skipped — LCC already complete (${lccSource})`);
  }

  // Wikidata title-search — gap-fill when LCC is empty/partial AND no ISBN
  // (when an ISBN exists, Phase 2's exact P212 lookup already ran). Same
  // don't-downgrade rule as the LoC fallback above.
  if (!isCompleteLcc(result.lcc) && !result.isbn) {
    const wd = await lookupWikidata(searchTitle, searchAuthor, log);
    if (wd) {
      if (wd.lcc) {
        const normalized = normalizeLcc(wd.lcc);
        if (isCompleteLcc(normalized) || !result.lcc) {
          if (result.lcc) {
            const priorSource: SourceTag =
              lccSource === 'ol'
                ? 'openlibrary'
                : lccSource === 'loc'
                  ? 'loc-sru'
                  : lccSource === 'inferred'
                    ? 'sonnet-infer-lcc'
                    : 'openlibrary';
            lccAlternates.push({ source: priorSource, value: result.lcc });
          }
          result.lcc = normalized;
          lccSource = 'wikidata';
        }
      }
      if (!result.ddc && wd.ddc) result.ddc = wd.ddc;
      if (!result.isbn && wd.isbn) result.isbn = wd.isbn;
      if (!result.publisher && wd.publisher) result.publisher = wd.publisher;
      if (!result.pageCount && wd.pageCount) result.pageCount = wd.pageCount;
      if (!result.series && wd.series) result.series = wd.series;
      if (!result.publicationYear && wd.publicationYear) {
        result.publicationYear = wd.publicationYear;
      }
      // Wikidata genre (P136) and main subject (P921) — silently dropped
      // before the audit. The by-ISBN path merges these into
      // result.subjects; mirror that here so the title-search path
      // doesn't lose the only crowd-tagged signal Wikidata exposes
      // exactly when we need it most (no ISBN, no LCC).
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
    }
  } else if (result.lcc && !result.isbn) {
    log.tier('wikidata-title', `skipped — LCC already complete (${lccSource})`);
  } else {
    log.tier('wikidata-title', 'skipped — already have ISBN, exact P212 ran in Phase 2');
  }

  // -------------------------------------------------------------------------
  // DDC → LCC class-letter fallback. When no network tier produced an
  // LCC but at least one tier surfaced a DDC, derive the LCC class
  // letter from a static crosswalk and write it to a SEPARATE field
  // (lccDerivedFromDdc) so the Review surface can distinguish a
  // sourced LCC from a derived one. The tag-inference prompt accepts
  // it as a domain anchor when `lcc` itself is empty.
  // -------------------------------------------------------------------------
  if (!result.lcc && result.ddc) {
    const derived = deriveLccFromDdc(result.ddc);
    if (derived) {
      result.lccDerivedFromDdc = derived.lccLetter;
      log.tier(
        'ddc-fallback',
        `derived lcc class letter ${JSON.stringify(derived.lccLetter)} from ddc=${JSON.stringify(result.ddc)} (${derived.confidence})`
      );
    } else {
      log.tier('ddc-fallback', `no mapping for ddc=${JSON.stringify(result.ddc)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Gap-fill pass — runs AFTER every other tier so it picks up only what
  // genuinely remained empty. Targeted single-source-per-field queries,
  // free APIs only (MARC, OL, Wikidata). Sequential per-field so the
  // typical case (most books need 0–2 fills) stays cheap. Bails out
  // entirely when Phase 1 found no winner. Tracks per-field source
  // attribution in `gapFillProv` so the final provenance map reflects
  // which tier actually filled each value.
  // -------------------------------------------------------------------------
  const gapFillProv: BookRecordProvenance = {};
  await runGapFill(result, log, gapFillProv);

  // -------------------------------------------------------------------------
  // Cover art chain.
  // -------------------------------------------------------------------------
  const cover = buildCoverChain(
    result.isbn,
    gbCoverUrl || undefined,
    isbndbCoverUrl || undefined,
    result.coverUrlFallbacks
  );
  if (cover.fallbacks.length > 0) {
    result.coverUrlFallbacks = cover.fallbacks;
    result.coverUrl = cover.primary;
  }

  const final = Object.assign(result, { tier: tier || 'none', lccSource });
  // Attach v1 provenance — heuristic per-field source attribution +
  // any LCC alternates captured during the partial→complete fallback.
  // Gap-fill overrides the heuristic for fields it actually filled,
  // since it knows the precise source per field.
  const baseProv = inferProvenanceFromResult(final, lccSource, lccAlternates);
  attachProvenance(final, { ...baseProv, ...gapFillProv });
  log.finish(final);

  // Cache populate. Both keys point at the same record so the next
  // call (whether keyed by title/author or by ISBN) hits.
  lookupCache.set(taKey, final);
  if (result.isbn) lookupCache.set(cacheKeyForIsbn(result.isbn), final);

  return final;
}
