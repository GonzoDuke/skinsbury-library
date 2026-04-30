import type { BookRecord } from './types';

function escape(field: string): string {
  const needsQuoting = /[",\n\r]/.test(field);
  const escaped = field.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : `"${escaped}"`;
}

export function toAuthorLastFirst(author: string): string {
  if (!author) return '';
  if (author.includes(',')) return author;
  const parts = author.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${last}, ${first}`;
}

const TITLE_CASE_STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from',
  'in', 'into', 'nor', 'of', 'on', 'or', 'so', 'the', 'to',
  'up', 'vs', 'with', 'yet',
]);

const ROMAN_NUMERAL_RE = /^[IVXLCDM]+$/;

// Dotted initialisms: U.S.A., F.B.I., T.S., B.C., U.S., etc.
// Requires at least two letter+dot pairs; an optional trailing letter
// catches things like "T.S" (no final dot). Case-insensitive on the way
// in; we always emit uppercase.
const DOTTED_INITIALISM_RE = /^([A-Za-z]\.){2,}[A-Za-z]?\.?$/;

function capitalizeWord(word: string): string {
  if (!word) return word;
  // Dotted initialism — preserve uppercase regardless of input casing.
  if (DOTTED_INITIALISM_RE.test(word)) return word.toUpperCase();
  // All-caps acronyms / Roman numerals — leave as-is when 2–4 letters.
  if (/^[A-Z]+$/.test(word) && word.length >= 2 && word.length <= 4) return word;
  if (ROMAN_NUMERAL_RE.test(word.toUpperCase()) && word.length <= 5) {
    return word.toUpperCase();
  }
  // Hyphenated word: capitalize each segment ("Twenty-Twenty", "Self-Made").
  if (word.includes('-')) {
    return word.split('-').map(capitalizeWord).join('-');
  }
  // Apostrophes: "alice's" → "Alice's"; "o'brien" → "O'Brien".
  if (word.includes("'")) {
    return word
      .split("'")
      .map((seg, i) => (i === 0 ? capitalizeWord(seg) : seg.toLowerCase().replace(/^./, (c) => c.toUpperCase())))
      .join("'")
      // Common possessive ("Alice's") shouldn't capitalize the s.
      .replace(/'S\b/, "'s");
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
  const tagList = [...b.genreTags, ...b.formTags];
  if (tagsFromBatch && b.batchLabel) tagList.push(`location:${b.batchLabel}`);
  const tags = tagList.join(', ');
  const collections = collectionsFromBatch && b.batchLabel ? b.batchLabel : '';
  // Combine batch-level notes (set at upload, applies to every book in the
  // batch) with per-book notes (edited on the BookCard). Either may be empty.
  const commentParts = [b.batchNotes, b.notes].filter((s) => s && s.trim()).map((s) => s!.trim());
  const comments = commentParts.join(' · ');
  return [
    b.title,
    b.authorLF || toAuthorLastFirst(b.author),
    b.isbn,
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

export function exportFilename(count: number, date: Date = new Date(), label?: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const slug = label ? `-${slugify(label)}` : '';
  return `skinsbury-lt-import-${yyyy}-${mm}-${dd}${slug}-${count}books.csv`;
}
