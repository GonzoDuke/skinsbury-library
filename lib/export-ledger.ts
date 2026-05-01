import type { BookRecord } from './types';

const LEDGER_KEY = 'carnegie:export-ledger:v1';

export interface LedgerEntry {
  /** Normalized ISBN (digits + X only). Empty when the source book had no ISBN. */
  isbn: string;
  /** Lowercase, punctuation-stripped, whitespace-collapsed title. */
  titleNorm: string;
  /** Lowercase, punctuation-stripped, whitespace-collapsed author. */
  authorNorm: string;
  /** ISO date (YYYY-MM-DD) the book was exported. */
  date: string;
  /** Batch label at the time of export. Undefined when the book had no label. */
  batchLabel?: string;
}

export function normalizeIsbn(isbn: string | undefined | null): string {
  if (!isbn) return '';
  return isbn.replace(/[^\dxX]/g, '').toUpperCase();
}

function normalizeText(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const normalizeTitle = normalizeText;
export const normalizeAuthor = normalizeText;

export function loadLedger(): LedgerEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        e &&
        typeof e.date === 'string' &&
        typeof e.titleNorm === 'string' &&
        typeof e.authorNorm === 'string' &&
        typeof e.isbn === 'string'
    );
  } catch {
    return [];
  }
}

function saveLedger(entries: LedgerEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
  } catch {
    // ignore quota errors — ledger is best-effort
  }
}

export function bookToLedgerEntry(book: BookRecord, date: Date = new Date()): LedgerEntry {
  return {
    isbn: normalizeIsbn(book.isbn),
    titleNorm: normalizeTitle(book.title),
    authorNorm: normalizeAuthor(book.author),
    date: date.toISOString().slice(0, 10),
    batchLabel: book.batchLabel,
  };
}

/**
 * Append the given books to the ledger. Dedupes against existing entries
 * (same ISBN, or same title+author when ISBN is missing) so re-exporting
 * the same book on different days doesn't multiply ledger rows for it.
 */
export function appendToLedger(books: BookRecord[], date: Date = new Date()): void {
  if (books.length === 0) return;
  const existing = loadLedger();
  const next = [...existing];
  for (const book of books) {
    const entry = bookToLedgerEntry(book, date);
    // Skip empty-shell entries — nothing to match on.
    if (!entry.isbn && !entry.titleNorm) continue;
    const dupeIndex = next.findIndex((e) => entriesMatch(e, entry));
    if (dupeIndex >= 0) {
      // Refresh the date/batch on re-export so the warning reflects the
      // latest known export.
      next[dupeIndex] = entry;
    } else {
      next.push(entry);
    }
  }
  saveLedger(next);
}

function entriesMatch(a: LedgerEntry, b: LedgerEntry): boolean {
  if (a.isbn && b.isbn) return a.isbn === b.isbn;
  // ISBN missing on one or both sides — fall back to title+author.
  if (!a.titleNorm || !b.titleNorm) return false;
  if (a.titleNorm !== b.titleNorm) return false;
  // If both have authors, require match. If either is missing, accept on title alone.
  if (a.authorNorm && b.authorNorm) return a.authorNorm === b.authorNorm;
  return true;
}

/**
 * Check whether `book` has been previously exported. Returns the matching
 * ledger entry, or null. Matches by ISBN when present; otherwise by
 * normalized title + author.
 */
export function findDuplicate(book: BookRecord, ledger?: LedgerEntry[]): LedgerEntry | null {
  const entries = ledger ?? loadLedger();
  const candidate = bookToLedgerEntry(book);
  if (!candidate.isbn && !candidate.titleNorm) return null;
  for (const e of entries) {
    if (entriesMatch(e, candidate)) return e;
  }
  return null;
}

/**
 * Mutate the book in-place if it matches a ledger entry: set status to
 * rejected, push a warning describing the prior export, and set
 * `previouslyExported` for the BookCard badge. Returns the same book for
 * chaining.
 */
export function flagIfPreviouslyExported(book: BookRecord, ledger?: LedgerEntry[]): BookRecord {
  const hit = findDuplicate(book, ledger);
  if (!hit) return book;
  const where = hit.batchLabel ? `batch "${hit.batchLabel}"` : 'an unlabeled batch';
  const warning = `Previously exported on ${hit.date} in ${where}. Rejected by default — approve to export as a second copy.`;
  book.status = 'rejected';
  book.warnings = [warning, ...(book.warnings ?? [])];
  book.previouslyExported = { date: hit.date, batchLabel: hit.batchLabel };
  return book;
}

/** Clear the ledger entirely. Exposed for a future settings/reset control. */
export function clearLedger(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(LEDGER_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Batch-level views and mutations — used by the /ledger management screen.
// ---------------------------------------------------------------------------

export interface LedgerBatch {
  /**
   * Undefined when the books were exported with no batch label. The
   * ledger screen renders this as italic "Unlabeled".
   */
  batchLabel: string | undefined;
  bookCount: number;
  /** Earliest export date in this batch (YYYY-MM-DD). */
  earliestDate: string;
  /**
   * Most recent export date — differs from earliestDate when some books
   * were re-exported on a later session (appendToLedger refreshes the
   * date in place rather than duplicating).
   */
  latestDate: string;
}

/**
 * Group ledger entries by batchLabel and summarize each group. Sorted
 * by latestDate descending so the most recently touched batches appear
 * first on the management screen.
 */
export function getLedgerBatches(): LedgerBatch[] {
  const entries = loadLedger();
  // Use a sentinel string for the unlabeled bucket — Map can't key on
  // `undefined` reliably for our equality needs.
  const UNLABELED = '\0unlabeled\0';
  const groups = new Map<string, LedgerBatch>();
  for (const e of entries) {
    const key = e.batchLabel ?? UNLABELED;
    const existing = groups.get(key);
    if (existing) {
      existing.bookCount += 1;
      if (e.date < existing.earliestDate) existing.earliestDate = e.date;
      if (e.date > existing.latestDate) existing.latestDate = e.date;
    } else {
      groups.set(key, {
        batchLabel: e.batchLabel,
        bookCount: 1,
        earliestDate: e.date,
        latestDate: e.date,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (a.latestDate !== b.latestDate) return a.latestDate < b.latestDate ? 1 : -1;
    // Tiebreak on label so the order is stable across renders.
    const al = a.batchLabel ?? '';
    const bl = b.batchLabel ?? '';
    return al.localeCompare(bl);
  });
}

/**
 * Remove every ledger entry whose batchLabel matches the argument
 * (pass `undefined` to clear the unlabeled bucket). Persists synchronously.
 * Returns the number of entries removed so the caller can confirm/log.
 */
export function deleteLedgerBatch(batchLabel: string | undefined): number {
  const before = loadLedger();
  const after = before.filter((e) => e.batchLabel !== batchLabel);
  const removed = before.length - after.length;
  if (removed > 0) saveLedger(after);
  return removed;
}
