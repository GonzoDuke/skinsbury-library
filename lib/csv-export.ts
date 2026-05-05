import type { BookRecord } from './types';

function escape(field: string): string {
  const needsQuoting = /[",\n\r]/.test(field);
  const escaped = field.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : `"${escaped}"`;
}

/**
 * Multi-author separators we recognize from spine reads + lookup APIs.
 * Splits on ampersand, the word "and" (word-bounded so "Anand" doesn't
 * match), and semicolon. We deliberately don't split on bare commas —
 * those are already used to mean "Last, First" form, and splitting them
 * would mangle every single-author entry that's already correct.
 */
const MULTI_AUTHOR_SPLIT_RE = /\s*(?:&|;|\band\b)\s*/i;

function flipSingleAuthor(author: string): string {
  const trimmed = author.trim().replace(/,$/, '');
  if (!trimmed) return '';
  // Already in "Last, First" form — leave it alone.
  if (trimmed.includes(',')) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${last}, ${first}`;
}

/**
 * Format an author string for the LibraryThing CSV `AUTHOR (last, first)`
 * column. Single authors come back as "Last, First". Multi-author inputs
 * — "Mike Caulfield & Sam Wineburg", "A and B", "A; B" — are split on
 * recognized separators, each side flipped, and rejoined with `"; "`,
 * which is LibraryThing's canonical multi-author delimiter.
 *
 * Examples:
 *   "Mike Caulfield & Sam Wineburg" → "Caulfield, Mike; Wineburg, Sam"
 *   "Mike Caulfield and Sam Wineburg" → "Caulfield, Mike; Wineburg, Sam"
 *   "Caulfield, Mike; Wineburg, Sam" → unchanged
 *   "Mike Caulfield" → "Caulfield, Mike"
 *   "Caulfield, Mike" → unchanged
 *   "Madonna" → "Madonna"
 */
export function toAuthorLastFirst(author: string): string {
  if (!author) return '';
  const pieces = author.split(MULTI_AUTHOR_SPLIT_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pieces.length === 0) return '';
  if (pieces.length === 1) return flipSingleAuthor(pieces[0]);
  return pieces.map(flipSingleAuthor).filter(Boolean).join('; ');
}

const TITLE_CASE_STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from',
  'in', 'into', 'nor', 'of', 'on', 'or', 'so', 'the', 'to',
  'up', 'vs', 'with', 'yet',
]);

// Strict Roman numeral pattern — matches valid LCM-decomposable strings
// like IV, VII, XL, MCM. Crucially does NOT match "civic", "did", "mid",
// or other ordinary words whose letters happen to all be drawn from
// [IVXLCDM]. The previous loose check was producing CIVIC / DID / MID
// in titles, which is exactly the bug we're fixing.
const STRICT_ROMAN_RE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

// Dotted initialisms: U.S.A., F.B.I., T.S., B.C., U.S., etc.
const DOTTED_INITIALISM_RE = /^([A-Za-z]\.){2,}[A-Za-z]?\.?$/;

// Tight allow-list of well-known acronyms. Anything not in here gets
// title-cased even if the input was ALL CAPS — most short uppercase
// words on book covers are stylized typography ("PINK", "JOY", "WAR"),
// not real acronyms.
const ACRONYM_WHITELIST = new Set([
  'USA', 'US', 'UK', 'EU', 'UN', 'NYC', 'LA', 'DC', 'NY',
  'AI', 'IT', 'OS', 'PC', 'TV', 'FM', 'AM', 'PM', 'IQ', 'EQ', 'GPS',
  'NBC', 'ABC', 'CBS', 'PBS', 'NPR', 'BBC', 'CNN', 'HBO', 'MTV', 'ESPN',
  'FBI', 'CIA', 'NSA', 'KGB', 'NASA', 'NATO', 'UNESCO', 'OECD',
  'DNA', 'RNA', 'AIDS', 'HIV', 'COVID', 'PTSD',
  'JFK', 'FDR', 'MLK', 'LBJ', 'FDR',
  'IBM', 'GM', 'BMW', 'NFL', 'NBA', 'MLB', 'NHL', 'FIFA',
  'WWI', 'WWII', 'NYT', 'WSJ',
]);

function capitalizeWord(word: string): string {
  if (!word) return word;
  // Dotted initialism — preserve uppercase regardless of input casing.
  if (DOTTED_INITIALISM_RE.test(word)) return word.toUpperCase();
  // Whitelisted acronym — case-insensitive lookup, emit uppercase.
  if (ACRONYM_WHITELIST.has(word.toUpperCase())) return word.toUpperCase();
  // Roman numeral — only if the input was already uppercase AND matches
  // the strict valid-Roman pattern, AND length ≥ 2 (single letters fall
  // through to default capitalization to preserve e.g. "I am Legend").
  if (
    word === word.toUpperCase() &&
    word.length >= 2 &&
    word.length <= 5 &&
    STRICT_ROMAN_RE.test(word)
  ) {
    return word;
  }
  // Hyphenated word: capitalize each segment ("Twenty-Twenty", "Self-Made").
  if (word.includes('-')) {
    return word.split('-').map(capitalizeWord).join('-');
  }
  // Apostrophes: distinguish Irish/Scottish/French name prefixes
  // ("O'Brien", "D'Angelo" — single-letter prefix, next letter is the
  // start of the proper-noun stem, so capitalize it) from contractions
  // and possessives ("Can't", "won't", "Alice's" — multi-letter prefix,
  // next letter is a particle and stays lowercase). The single- vs.
  // multi-letter heuristic captures real-world usage cleanly:
  //   "o'brien"   → 1 char before "'" → "O'Brien"
  //   "d'angelo"  → 1 char before "'" → "D'Angelo"
  //   "can't"     → 3 chars before "'" → "Can't"
  //   "won't"     → 3 chars before "'" → "Won't"
  //   "alice's"   → 5 chars before "'" → "Alice's"
  if (word.includes("'")) {
    const segs = word.split("'");
    return segs
      .map((seg, i) => {
        if (i === 0) return capitalizeWord(seg);
        const prev = segs[i - 1];
        if (prev.length === 1) {
          // Name-prefix convention: capitalize first letter of this seg.
          return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
        }
        // Contraction / possessive: keep this seg lowercase.
        return seg.toLowerCase();
      })
      .join("'");
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Title-case a string per Chicago-ish rules: capitalize first/last word
 * and every major word; lowercase short conjunctions/prepositions/articles
 * unless they sit at a sentence boundary or right after a colon.
 */
export function toTitleCase(input: string | undefined | null): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Tokenize by whitespace, but preserve original spacing as ' ' between.
  const words = trimmed.split(/\s+/);
  const result: string[] = [];
  let forceCapNext = true; // first word always caps
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isLast = i === words.length - 1;
    const lowered = w.toLowerCase().replace(/[^a-z']/g, '');
    if (forceCapNext || isLast || !TITLE_CASE_STOPWORDS.has(lowered)) {
      result.push(capitalizeWord(w));
    } else {
      // Preserve all-caps acronyms even when in stoplist position
      // (e.g., "USA" — but those wouldn't be in the stoplist anyway).
      result.push(w.toLowerCase());
    }
    // Force-cap the word after a colon or em-dash.
    forceCapNext = /[:—–]$/.test(w);
  }
  return result.join(' ');
}

export const CSV_HEADERS = [
  'TITLE',
  'AUTHOR (last, first)',
  'ISBN',
  // BINDING sits next to ISBN where edition-specific fields cluster.
  // Populated from book.format (user-set via Add Copy), NOT from
  // book.binding (auto-detected from lookup tier). Blank when format
  // is unset.
  'BINDING',
  'PUBLICATION',
  'DATE',
  'TAGS',
  'COLLECTIONS',
  'COMMENTS',
  'COPIES',
];

export interface CsvOptions {
  /** Append the batch label to the COLLECTIONS column. Default true. */
  collectionsFromBatch?: boolean;
  /** Append `location:{batchLabel}` to the TAGS column. Default true. */
  tagsFromBatch?: boolean;
}

export function bookToCsvRow(b: BookRecord, options: CsvOptions = {}): string[] {
  const { collectionsFromBatch = true, tagsFromBatch = true } = options;
  // Strip the `[Proposed]` prefix on export — LibraryThing should see clean
  // tag names. The proposal status is repo-side metadata only.
  const tagList = [...b.genreTags, ...b.formTags].map((t) =>
    t.replace(/^\[Proposed\]\s*/i, '')
  );
  if (tagsFromBatch && b.batchLabel) tagList.push(`location:${b.batchLabel}`);
  const tags = tagList.join(', ');
  const collections = collectionsFromBatch && b.batchLabel ? b.batchLabel : '';
  // Combine batch-level notes (set at upload, applies to every book in the
  // batch) with per-book notes (edited on the BookCard). Either may be empty.
  const commentParts = [b.batchNotes, b.notes].filter((s) => s && s.trim()).map((s) => s!.trim());
  const comments = commentParts.join(' · ');
  return [
    b.title,
    // CSV author column: trust `authorLF` only when it carries a
    // multi-author "Last, First; Last, First" value (which the
    // canonical-title commit writes for books whose lookup returned a
    // full author list). For single-author cases we recompute from
    // `author` — that protects against stale localStorage records
    // where `authorLF` was cached in the malformed
    // "Wineburg, Mike Caulfield & Sam" form before the multi-author
    // splitter shipped. Two regimes, one rule: if it has a semicolon,
    // it's the new canonical form; otherwise recompute.
    b.authorLF && b.authorLF.includes(';')
      ? b.authorLF
      : toAuthorLastFirst(b.author),
    b.isbn,
    b.format ?? '',
    b.publisher,
    b.publicationYear ? String(b.publicationYear) : '',
    tags,
    collections,
    comments,
    '1',
  ];
}

export function generateCsv(books: BookRecord[], options: CsvOptions = {}): string {
  const lines: string[] = [];
  lines.push(CSV_HEADERS.map(escape).join(','));
  for (const book of books) {
    lines.push(bookToCsvRow(book, options).map(escape).join(','));
  }
  return lines.join('\n');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function exportFilename(
  count: number,
  date: Date = new Date(),
  label?: string,
  extension: 'csv' | 'json' = 'csv'
): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const slug = label ? `-${slugify(label)}` : '';
  return `carnegie-lt-import-${yyyy}-${mm}-${dd}${slug}-${count}books.${extension}`;
}

// ---------------------------------------------------------------------------
// toTitleCase dev assertions — fire at module load in dev. The
// apostrophe-handling regression that prompted this commit is the
// most-tested case; a future "fix" that reverts the heuristic will
// throw here loudly instead of silently mangling user titles again.
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  const cases: { in: string; out: string }[] = [
    { in: "can't find my way home", out: "Can't Find My Way Home" },
    { in: "o'brien's pub", out: "O'Brien's Pub" },
    { in: "d'angelo and the vanguard", out: "D'Angelo and the Vanguard" },
    { in: 'first-class travel', out: 'First-Class Travel' },
    { in: 'the lord of the rings', out: 'The Lord of the Rings' },
    { in: "CAN'T FIND MY WAY HOME", out: "Can't Find My Way Home" },
  ];
  for (const c of cases) {
    const got = toTitleCase(c.in);
    if (got !== c.out) {
      throw new Error(
        `toTitleCase regression: ${JSON.stringify(c.in)} → ${JSON.stringify(got)} (expected ${JSON.stringify(c.out)})`
      );
    }
  }
}
