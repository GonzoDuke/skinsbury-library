import type { BookRecord } from './types';

const LEDGER_KEY = 'carnegie:export-ledger:v1';
const REMOTE_AVAILABLE_KEY = 'carnegie:export-ledger:remote-available:v1';

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
  /**
   * Genre + form tags applied at export time. Used by the Vocabulary
   * screen to compute usage counts so we don't enable "delete" on a tag
   * that's already shipped to LibraryThing. Optional because older
   * ledger entries (pre v3 step 7) didn't capture tags.
   */
  tags?: string[];
  /**
   * Display fields captured at export time so the History screen can
   * re-download a CSV that matches what the user actually shipped.
   * Optional because older ledger entries (pre v3 step 8) only carried
   * the normalized forms.
   */
  title?: string;
  author?: string;
  authorLF?: string;
  publisher?: string;
  publicationYear?: number;
  batchNotes?: string;
  /**
   * LCC at the time of export. Populated by new exports so future
   * features (author-similarity backfill, domain-clustering analytics)
   * can read it directly off the ledger. Optional because pre-step-4
   * ledger entries don't carry it; getAuthorPattern simply ignores
   * entries without an LCC when computing the dominant class letter.
   */
  lcc?: string;
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

/** Replace the local cache wholesale. Used after a remote sync returns
 *  authoritative state from lib/export-ledger.json. */
export function setLedgerCache(entries: LedgerEntry[]): void {
  saveLedger(entries);
}

/**
 * Merge a list of additions into an existing ledger using the same
 * dedupe rules as appendToLedger. Pure — does not touch storage.
 * Exported so the API route can share the exact same merge semantics
 * as the client.
 */
export function mergeLedgerAdditions(
  existing: LedgerEntry[],
  additions: LedgerEntry[]
): LedgerEntry[] {
  const out = [...existing];
  for (const add of additions) {
    if (!add.isbn && !add.titleNorm) continue;
    const idx = out.findIndex((e) => entriesMatch(e, add));
    if (idx >= 0) {
      // Refresh on the later sighting so the warning reflects the most
      // recent export. Same date wins for the incoming record (keeps
      // batchLabel current).
      if (add.date >= out[idx].date) out[idx] = add;
    } else {
      out.push(add);
    }
  }
  return out;
}

interface RemoteLedgerResponse {
  available: boolean;
  entries?: LedgerEntry[];
  /** Latest remote SHA, returned for caller logging. We don't need it again
   *  on the client because the API route resolves SHA server-side per call. */
  sha?: string | null;
  /** Commit URL when a write happened. */
  commit?: { url?: string; sha?: string };
  error?: string;
}

/**
 * Fetch the authoritative ledger from lib/export-ledger.json via the
 * /api/ledger route. Updates the localStorage cache when the remote is
 * available. Returns the remote entries when fetched, or null when the
 * remote is unavailable (caller should fall back to localStorage).
 */
export async function syncLedgerFromRepo(): Promise<LedgerEntry[] | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch('/api/ledger', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as RemoteLedgerResponse;
    rememberRemoteAvailability(data.available);
    if (!data.available || !Array.isArray(data.entries)) return null;
    // Defensive merge: union the remote entries with whatever's in local
    // cache — covers the case where this is the first sync after the
    // localStorage→repo migration and the user has unmigrated entries.
    const local = loadLedger();
    const merged = mergeLedgerAdditions(data.entries, local);
    saveLedger(merged);
    return merged;
  } catch {
    return null;
  }
}

/**
 * Push a delta to the remote ledger. The route applies adds/removes
 * server-side against the current remote state, so two devices writing
 * concurrently won't clobber each other. On success, refresh the cache
 * with the post-merge state returned by the route.
 */
export async function pushLedgerDelta(
  delta: {
    add?: LedgerEntry[];
    removeBatchLabels?: (string | null)[];
    clearAll?: boolean;
    /** Replace every occurrence of `from` in `tags` arrays with `to`. */
    renameTag?: { from: string; to: string };
  }
): Promise<RemoteLedgerResponse> {
  if (typeof window === 'undefined') return { available: false };
  try {
    const res = await fetch('/api/ledger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delta),
    });
    const data = (await res.json().catch(() => ({}))) as RemoteLedgerResponse;
    if (res.status === 501) {
      rememberRemoteAvailability(false);
      return { available: false, error: data.error };
    }
    if (!res.ok) {
      return { available: data.available ?? true, error: data.error ?? `HTTP ${res.status}` };
    }
    rememberRemoteAvailability(true);
    if (Array.isArray(data.entries)) saveLedger(data.entries);
    return data;
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function rememberRemoteAvailability(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(REMOTE_AVAILABLE_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

/**
 * Last known availability of the remote ledger, cached so the UI doesn't
 * have to wait for a network probe to render the right state. Returns
 * `null` when we haven't checked yet.
 */
export function getCachedRemoteAvailability(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(REMOTE_AVAILABLE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  } catch {
    return null;
  }
}

export function bookToLedgerEntry(book: BookRecord, date: Date = new Date()): LedgerEntry {
  // Strip the [Proposed] prefix so the recorded tags match the cleaned form
  // that ships in the CSV — this is the same form the Vocabulary screen
  // uses when it counts usage.
  const tags = [...book.genreTags, ...book.formTags]
    .map((t) => t.replace(/^\[Proposed\]\s*/i, '').trim())
    .filter(Boolean);
  return {
    isbn: normalizeIsbn(book.isbn),
    titleNorm: normalizeTitle(book.title),
    authorNorm: normalizeAuthor(book.author),
    date: date.toISOString().slice(0, 10),
    batchLabel: book.batchLabel,
    tags: tags.length > 0 ? tags : undefined,
    title: book.title || undefined,
    author: book.author || undefined,
    authorLF: book.authorLF || undefined,
    publisher: book.publisher || undefined,
    publicationYear: book.publicationYear || undefined,
    batchNotes: book.batchNotes || undefined,
    lcc: book.lcc || undefined,
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

export function entriesMatch(a: LedgerEntry, b: LedgerEntry): boolean {
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

// ---------------------------------------------------------------------------
// Author-pattern lookup — Step 4 of the post-audit plan. Reads the local
// ledger to surface "books by this author the user already owns and exported"
// as a personalized signal feeding LCC fallback + tag inference. No network,
// no GitHub round-trip — the in-memory localStorage cache is what we read.
// ---------------------------------------------------------------------------

/**
 * Build an author key (lastname + first-given-name, both lowercased)
 * from any of the author forms the ledger or pipeline carry. Returns
 * an empty string when the input is unusable.
 *
 * Match logic:
 *   "Sontag, Susan"        → "sontag|susan"
 *   "Sontag, Susan J."     → "sontag|susan"   ✓ matches above
 *   "Sontag, Susan Jane"   → "sontag|susan"   ✓ matches above
 *   "Le Guin, Ursula K."   → "le guin|ursula"
 *   "Le Guin, Ursula"      → "le guin|ursula" ✓ matches
 *   "Doe, John"            → "doe|john"
 *   "Doe, Jane"            → "doe|jane"       ✗ different first-given
 *
 * For multi-word last names ("Le Guin", "van der Linden"), the lastname
 * is everything before the comma. The first-given-name is the FIRST
 * whitespace-separated token after the comma — middle names + initials
 * are ignored.
 *
 * Display-form ("First Last") inputs without a comma are accepted too:
 * "Susan Sontag" → "sontag|susan". Last token wins as the lastname.
 */
function authorKey(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let lastname = '';
  let firstGiven = '';
  if (trimmed.includes(',')) {
    const [last, rest] = trimmed.split(',', 2);
    lastname = last.trim();
    const restTokens = (rest ?? '').trim().split(/\s+/).filter(Boolean);
    firstGiven = restTokens[0] ?? '';
  } else {
    // Display form "First Middle Last". Last token is the lastname,
    // first token is the first-given. Middle parts ignored.
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';
    lastname = tokens[tokens.length - 1];
    firstGiven = tokens[0] !== lastname ? tokens[0] : '';
  }
  // Strip any trailing punctuation (initials with periods, commas) and
  // lowercase. "Susan J." → "susan" once the period is stripped.
  const cleanLast = lastname.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const cleanFirst = firstGiven.toLowerCase().replace(/[^a-z]/g, '');
  if (!cleanLast || !cleanFirst) return '';
  return `${cleanLast}|${cleanFirst}`;
}

/**
 * Split a multi-author string ("Caulfield, Mike; Wineburg, Sam" or
 * "Mike Caulfield & Sam Wineburg") into individual author keys. The
 * caller can then test whether any of the query's keys match any of an
 * entry's keys — the "match either author independently" semantics.
 */
function authorKeysFor(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/;|\s&\s|\sand\s/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const keys = parts.map(authorKey).filter(Boolean);
  return Array.from(new Set(keys));
}

export interface AuthorPatternResult {
  /**
   * Most common LCC class letter (e.g. "B", "PR", "QA") across matched
   * books, computed from each entry's `lcc` field's leading 1–3 letter
   * prefix. Null when no matched book has an LCC.
   */
  dominantLccLetter: string | null;
  /** Top 5 most-frequent tags across matched books (genreTags + formTags merged). */
  frequentTags: string[];
  /** Number of matched ledger entries — caller's minimum-sample guard. */
  sampleSize: number;
}

/**
 * Scan the local ledger for books whose author overlaps with the
 * supplied authorLF (display form also accepted) and return aggregate
 * signals: dominant LCC class letter and top tags. Pure read; no
 * mutation; returns `{sampleSize: 0, dominantLccLetter: null,
 * frequentTags: []}` when nothing matches.
 *
 * Caller is responsible for the minimum-sample-size guard. Below 3,
 * two books prove nothing — but this helper still returns the count
 * so other features can use sampleSize === 1 for display purposes.
 */
export function getAuthorPattern(authorLF: string): AuthorPatternResult {
  const empty: AuthorPatternResult = {
    dominantLccLetter: null,
    frequentTags: [],
    sampleSize: 0,
  };
  const queryKeys = authorKeysFor(authorLF);
  if (queryKeys.length === 0) return empty;
  const querySet = new Set(queryKeys);

  const ledger = loadLedger();
  if (ledger.length === 0) return empty;

  // Match: a ledger entry matches when any of its individual author
  // keys is in the query's key set. Prefer authorLF (preserves the
  // "Last, First" form). Fall back to author (display form) for older
  // entries that didn't capture LF. Skip entries whose authors can't
  // be parsed — they don't contribute either way.
  const matches: LedgerEntry[] = [];
  for (const e of ledger) {
    const candidate = e.authorLF ?? e.author;
    if (!candidate) continue;
    const eKeys = authorKeysFor(candidate);
    if (eKeys.some((k) => querySet.has(k))) matches.push(e);
  }
  if (matches.length === 0) return empty;

  // Dominant LCC class letter — leading run of uppercase letters from
  // each entry's LCC. Old entries without an LCC simply don't vote.
  const letterCounts = new Map<string, number>();
  for (const e of matches) {
    if (!e.lcc) continue;
    const m = e.lcc.match(/^([A-Z]{1,3})/);
    if (!m) continue;
    const letter = m[1];
    letterCounts.set(letter, (letterCounts.get(letter) ?? 0) + 1);
  }
  let dominantLccLetter: string | null = null;
  let bestCount = 0;
  for (const [letter, count] of letterCounts) {
    if (count > bestCount) {
      bestCount = count;
      dominantLccLetter = letter;
    }
  }

  // Top tags by frequency across genre+form. Cap at 5 — we want signal,
  // not a full tag dump that would dilute the prompt's other guidance.
  const tagCounts = new Map<string, number>();
  for (const e of matches) {
    if (!e.tags || e.tags.length === 0) continue;
    for (const t of e.tags) {
      const tag = t.trim();
      if (!tag) continue;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const frequentTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([tag]) => tag);

  return {
    dominantLccLetter,
    frequentTags,
    sampleSize: matches.length,
  };
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
