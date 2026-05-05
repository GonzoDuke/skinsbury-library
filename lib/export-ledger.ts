import type { BookRecord } from './types';
import { isNoWriteMode, logSkippedWrite } from './no-write-mode';

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
  /**
   * Set when the user dismissed this entry from the Duplicates &
   * editions tool. `type` records which action they took:
   *   - `intentional`: "These multiple copies are deliberate" (exact dupes)
   *   - `different_works`: "These aren't actually the same work" (edition false positive)
   * Either way, `detectDuplicates` excludes the entry from future
   * grouping. `dismissedFromGroup` records the matchKey at the time
   * of dismissal so we can audit later if we add an undo flow.
   */
  dedupe_dismissed?: {
    type: 'intentional' | 'different_works';
    dismissedAt: string;
    dismissedFromGroup: string;
  };
  /**
   * Cross-reference id linking ledger entries the user has confirmed
   * are the same underlying work (different editions, printings,
   * translations). Written by the "Confirm same work" action in the
   * duplicates tool.
   */
  work_group_id?: string;
  /**
   * Set when the user dismissed this entry from the Authority check
   * tool. `canonical_form` is recorded when the user picked a canonical
   * version (the merge action) so we can audit the standardization
   * later. Without `canonical_form`, the dismissal means "tool was
   * wrong, these are different people."
   */
  authority_dismissed?: {
    dismissedAt: string;
    canonical_form?: string;
  };
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
 * Stable per-entry identity for the duplicates tool. The append/merge
 * paths dedupe via entriesMatch (ISBN-or-title+author), so this composite
 * is technically redundant for those paths — but the duplicates UI may
 * see entries that bypassed dedupe (sync race, manual JSON edits, future
 * second-copy support), so we hash on the full tuple to keep updates
 * surgical. `date` and `batchLabel` are included so two entries that
 * share an ISBN but were exported on different days remain distinct.
 */
export interface EntryHandle {
  isbn: string;
  titleNorm: string;
  authorNorm: string;
  date: string;
  batchLabel: string | null;
}

export function entryHandle(e: LedgerEntry): EntryHandle {
  return {
    isbn: e.isbn,
    titleNorm: e.titleNorm,
    authorNorm: e.authorNorm,
    date: e.date,
    batchLabel: e.batchLabel ?? null,
  };
}

function handleEquals(h: EntryHandle, e: LedgerEntry): boolean {
  return (
    h.isbn === e.isbn &&
    h.titleNorm === e.titleNorm &&
    h.authorNorm === e.authorNorm &&
    h.date === e.date &&
    (h.batchLabel ?? null) === (e.batchLabel ?? null)
  );
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
    /**
     * Apply a partial update to specific entries, identified by EntryHandle.
     * Used by the duplicates tool for dismissals and work-group cross-refs.
     */
    updateEntries?: {
      match: EntryHandle;
      set: Partial<
        Pick<
          LedgerEntry,
          | 'dedupe_dismissed'
          | 'work_group_id'
          | 'authority_dismissed'
          | 'author'
          | 'authorLF'
          | 'authorNorm'
        >
      >;
    }[];
    /** Delete specific entries identified by EntryHandle. Destructive. */
    removeEntries?: EntryHandle[];
  }
): Promise<RemoteLedgerResponse> {
  if (typeof window === 'undefined') return { available: false };
  // Local-only mode early-return — caller gets a success-shaped
  // response (no error, no commit) so success-path UI renders without
  // the "couldn't sync" toast. The local cache update happens in the
  // calling helpers (saveLedger via dismissDuplicateGroup etc.) before
  // pushLedgerDelta is invoked, so local state stays consistent.
  if (isNoWriteMode()) {
    logSkippedWrite('pushLedgerDelta', delta);
    return { available: true };
  }
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

/**
 * Rename a batch in the local ledger cache only. Touches every entry
 * whose batchLabel matches `from` (including the unlabeled bucket via
 * `from = undefined`) and rewrites it to `to`. Persists synchronously.
 *
 * Local-only by design: this commit specifically does NOT push the
 * rename to GitHub. The new label propagates to the repo on the next
 * regular ledger commit (export, batch-label rename done at history,
 * etc.). Returns the count of entries renamed so the caller can log.
 */
export function renameBatchLabelInLocalLedger(
  from: string | undefined,
  to: string
): number {
  if (from === to) return 0;
  const before = loadLedger();
  let touched = 0;
  const next = before.map((e) => {
    if ((e.batchLabel ?? undefined) === from) {
      touched += 1;
      return { ...e, batchLabel: to };
    }
    return e;
  });
  if (touched > 0) saveLedger(next);
  return touched;
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

// ---------------------------------------------------------------------------
// Duplicates & editions detection. Originally consumed by the
// /collection/duplicates tool (since removed). Helpers preserved for
// future reuse; ledger fields they write (dedupe_dismissed,
// work_group_id) persist on existing entries.
// Two distinct cases:
//   1. EXACT: multiple ledger entries that share the same ISBN.
//   2. EDITION: multiple entries that resolve to the same work
//      (matching normalized title + author last name) but have
//      DIFFERENT ISBNs — different printings, paperback vs hardcover,
//      translations, etc.
//
// In practice exact-by-ISBN groups are rare because appendToLedger
// dedupes same-ISBN re-exports in place. They show up when entries
// bypassed dedupe (manual JSON edit, sync race, future second-copy
// support). Edition groups are the meatier real-world case.
// ---------------------------------------------------------------------------

const SOFT_DISMISS_KEY = 'carnegie:dedupe-soft-dismissals:v1';

export interface DuplicateGroup {
  type: 'exact' | 'edition';
  /** ISBN for exact groups, normalized "title|author" for edition groups. */
  matchKey: string;
  entries: LedgerEntry[];
}

/** Normalize a title for edition matching: strip subtitle, leading
 *  articles, punctuation; lowercase; collapse whitespace. */
function normalizeTitleForEdition(title: string | undefined): string {
  if (!title) return '';
  let t = title.toLowerCase().trim();
  // Strip subtitle (everything after first colon).
  const colon = t.indexOf(':');
  if (colon >= 0) t = t.slice(0, colon).trim();
  // Strip leading articles.
  t = t.replace(/^(the|a|an)\s+/, '');
  // Strip punctuation, collapse whitespace.
  t = t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

/** Last-name only normalization for edition matching. Accepts both
 *  "Last, First" and "First Last" forms. */
function normalizeAuthorLastnameOnly(author: string | undefined): string {
  if (!author) return '';
  const trimmed = author.trim();
  if (!trimmed) return '';
  let lastname = '';
  if (trimmed.includes(',')) {
    lastname = trimmed.split(',', 1)[0];
  } else {
    const tokens = trimmed.split(/\s+/);
    lastname = tokens[tokens.length - 1] ?? '';
  }
  return lastname
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadSoftDismissals(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(SOFT_DISMISS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === 'string'));
  } catch {
    return new Set();
  }
}

function saveSoftDismissals(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SOFT_DISMISS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // ignore quota errors
  }
}

/** Soft-dismiss a group from the duplicates view. Local-only. The
 *  ledger is not modified — re-detection on a different device will
 *  still surface the group there. */
export function softDismissDuplicateGroup(matchKey: string): void {
  const set = loadSoftDismissals();
  set.add(matchKey);
  saveSoftDismissals(set);
}

/**
 * Detect duplicate groups across the ledger.
 *
 * Exact groups: any cluster of ≥2 entries sharing a non-empty ISBN.
 * Edition groups: any cluster of ≥2 entries with DIFFERENT ISBNs but
 *   matching (normalizeTitleForEdition, normalizeAuthorLastnameOnly).
 *
 * Excludes entries with `dedupe_dismissed` set (the user said "this
 * group is settled"). Excludes match keys in localStorage soft-dismiss
 * set (the user said "keep all as-is, hide this group").
 *
 * Sorted by entry count descending, then alphabetical by matchKey for
 * stable rendering. Caps at 50 groups for v1; the caller can read
 * `truncated` and surface a "{N} more" message.
 */
export function detectDuplicates(
  entries: LedgerEntry[],
  options: { cap?: number } = {}
): { groups: DuplicateGroup[]; truncated: number } {
  const cap = options.cap ?? 50;
  const softDismissed = loadSoftDismissals();
  const eligible = entries.filter((e) => !e.dedupe_dismissed);

  // 1. Exact groups by ISBN.
  const byIsbn = new Map<string, LedgerEntry[]>();
  for (const e of eligible) {
    if (!e.isbn) continue;
    const list = byIsbn.get(e.isbn) ?? [];
    list.push(e);
    byIsbn.set(e.isbn, list);
  }
  const exactGroups: DuplicateGroup[] = [];
  for (const [isbn, list] of byIsbn) {
    if (list.length < 2) continue;
    if (softDismissed.has(`exact:${isbn}`)) continue;
    exactGroups.push({ type: 'exact', matchKey: isbn, entries: list });
  }

  // 2. Edition groups by normalized title+author. Skip entries with
  //    no usable normalized form — those would all collide on "|" and
  //    create false groups.
  const byWork = new Map<string, LedgerEntry[]>();
  for (const e of eligible) {
    const t = normalizeTitleForEdition(e.title ?? e.titleNorm);
    const a = normalizeAuthorLastnameOnly(e.authorLF ?? e.author ?? '');
    if (!t || !a) continue;
    const key = `${t}|${a}`;
    const list = byWork.get(key) ?? [];
    list.push(e);
    byWork.set(key, list);
  }
  const editionGroups: DuplicateGroup[] = [];
  for (const [key, list] of byWork) {
    if (list.length < 2) continue;
    if (softDismissed.has(`edition:${key}`)) continue;
    // Edition group requires DIFFERENT ISBNs — otherwise it's covered
    // by an exact group above.
    const isbns = new Set(list.map((e) => e.isbn).filter(Boolean));
    if (isbns.size < 2) continue;
    editionGroups.push({ type: 'edition', matchKey: key, entries: list });
  }

  const all = [...exactGroups, ...editionGroups].sort((a, b) => {
    if (a.entries.length !== b.entries.length) {
      return b.entries.length - a.entries.length;
    }
    return a.matchKey.localeCompare(b.matchKey);
  });

  const truncated = Math.max(0, all.length - cap);
  return { groups: all.slice(0, cap), truncated };
}

/**
 * Mark a list of ledger entries as dismissed from the duplicates tool.
 * Writes both locally and to the remote ledger. Caller should refetch
 * the ledger after this resolves.
 */
export async function dismissDuplicateGroup(
  handles: EntryHandle[],
  type: 'intentional' | 'different_works',
  matchKey: string
): Promise<RemoteLedgerResponse> {
  const dismissedAt = new Date().toISOString();
  const dismissedFromGroup = matchKey;

  // Optimistic local update so the UI sees the change immediately.
  const local = loadLedger();
  const updated = local.map((e) => {
    if (handles.some((h) => handleEquals(h, e))) {
      return {
        ...e,
        dedupe_dismissed: { type, dismissedAt, dismissedFromGroup },
      };
    }
    return e;
  });
  saveLedger(updated);

  return pushLedgerDelta({
    updateEntries: handles.map((h) => ({
      match: h,
      set: {
        dedupe_dismissed: { type, dismissedAt, dismissedFromGroup },
      },
    })),
  });
}

/**
 * Confirm a list of ledger entries as the same work — assigns them a
 * shared work_group_id and marks them dismissed-as-different_works=false
 * (well, marks as dismissed since they're settled). Future series
 * tooling can read work_group_id to count "the same work" once.
 */
export async function confirmSameWork(
  handles: EntryHandle[],
  matchKey: string
): Promise<RemoteLedgerResponse> {
  // Reuse an existing work_group_id if any of the entries already has one,
  // so this is idempotent across multiple confirmations.
  const local = loadLedger();
  const matched = local.filter((e) => handles.some((h) => handleEquals(h, e)));
  const existing = matched.find((e) => e.work_group_id)?.work_group_id;
  const work_group_id = existing ?? generateWorkGroupId();
  const dismissedAt = new Date().toISOString();
  const dismissed = {
    type: 'different_works' as const, // settled — exclude from future detection
    dismissedAt,
    dismissedFromGroup: matchKey,
  };

  const updated = local.map((e) => {
    if (handles.some((h) => handleEquals(h, e))) {
      return { ...e, work_group_id, dedupe_dismissed: dismissed };
    }
    return e;
  });
  saveLedger(updated);

  return pushLedgerDelta({
    updateEntries: handles.map((h) => ({
      match: h,
      set: { work_group_id, dedupe_dismissed: dismissed },
    })),
  });
}

/**
 * Remove specific ledger entries by handle. Destructive. The caller
 * is responsible for confirming with the user before invoking.
 */
export async function removeLedgerEntries(
  handles: EntryHandle[]
): Promise<RemoteLedgerResponse> {
  const local = loadLedger();
  const filtered = local.filter((e) => !handles.some((h) => handleEquals(h, e)));
  saveLedger(filtered);
  return pushLedgerDelta({ removeEntries: handles });
}

function generateWorkGroupId(): string {
  // No need for cryptographic strength — we're avoiding collisions
  // across a user's own ledger, not generating session keys.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `wg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Authority check. Originally consumed by the /collection/authority
// tool (since removed). Helpers preserved for future reuse; the
// authority_dismissed ledger field persists on existing entries.
//
// Detects entries whose author is likely the same person but stored in
// inconsistent forms ("Solnit, Rebecca" vs "Solnit, R." vs "Solnit,
// Rebecca J."). The detection groups by lastname + first-initial, then
// reports any group with ≥2 distinct stored-name strings. The user
// resolves each group by picking a canonical form (which rewrites the
// author field on every matched entry) or dismissing the group as
// "actually different people."
// ---------------------------------------------------------------------------

const AUTHORITY_SOFT_DISMISS_KEY = 'carnegie:authority-soft-dismissals:v1';

export interface AuthorityVariant {
  /** The author name as stored on the entry (e.g. "Solnit, Rebecca"). */
  name: string;
  /** How many ledger entries use this exact form. */
  entryCount: number;
  /** Handles for every ledger entry that has this variant. */
  handles: EntryHandle[];
}

export interface AuthorityGroup {
  /** Canonical match key, e.g. "solnit|r" (lastname + first initial). */
  matchKey: string;
  /** Display form of the match key for UI ("Solnit, R."). */
  matchKeyDisplay: string;
  /** Distinct stored variants of this author, sorted by entry count desc. */
  variants: AuthorityVariant[];
  /** Sum of entryCount across all variants. */
  totalEntries: number;
}

/** Strip a single author string into a comparable last-name and a
 *  first-initial. Returns null when the name is unusable. Handles both
 *  "Last, First" and display "First Last" forms. Multi-word last names
 *  ("Le Guin", "García Márquez") are preserved when the comma form is
 *  used; for display form, the LAST whitespace-separated token is the
 *  lastname (a known limitation — display forms with multi-word last
 *  names will misclassify). */
function splitAuthorParts(
  raw: string
): { lastname: string; firstFull: string; firstInitial: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let lastname = '';
  let firstFull = '';
  if (trimmed.includes(',')) {
    const [last, rest] = trimmed.split(',', 2);
    lastname = last.trim();
    const restTokens = (rest ?? '').trim().split(/\s+/).filter(Boolean);
    firstFull = restTokens[0] ?? '';
  } else {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    lastname = tokens[tokens.length - 1];
    firstFull = tokens.length > 1 ? tokens[0] : '';
  }
  // Normalize for comparison: strip diacritics, lowercase, strip
  // non-alpha (handles initials with periods, hyphens, apostrophes).
  const lastNorm = lastname
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstNorm = firstFull
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
  if (!lastNorm || !firstNorm) return null;
  return {
    lastname: lastNorm,
    firstFull: firstNorm,
    firstInitial: firstNorm.charAt(0),
  };
}

/** Split a multi-author string into individual author names. The
 *  ledger pipeline uses semicolons as the canonical separator, but we
 *  also tolerate "&" and " and " for older entries. */
function splitMultiAuthor(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/;|\s&\s|\sand\s/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

function loadAuthoritySoftDismissals(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(AUTHORITY_SOFT_DISMISS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === 'string'));
  } catch {
    return new Set();
  }
}

function saveAuthoritySoftDismissals(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      AUTHORITY_SOFT_DISMISS_KEY,
      JSON.stringify(Array.from(set))
    );
  } catch {
    // ignore quota errors
  }
}

/** Soft-dismiss an authority group from the tool view. Local-only —
 *  re-detection on a different device or after localStorage clear will
 *  still surface it there. */
export function softDismissAuthorityGroup(matchKey: string): void {
  const set = loadAuthoritySoftDismissals();
  set.add(matchKey);
  saveAuthoritySoftDismissals(set);
}

/**
 * Detect groups of entries whose authors share a lastname + first-name
 * initial but are stored in inconsistent forms.
 *
 * Multi-author entries: each author is checked independently. The
 * group's handles point at the full ledger entry where any matching
 * author appears (so a "Caulfield, Mike; Wineburg, Sam" entry can show
 * up in BOTH a Caulfield group and a Wineburg group if either is in
 * conflict).
 *
 * Skips entries with `authority_dismissed` set. Skips match keys in
 * the localStorage soft-dismiss set. Caps at 50 groups.
 */
export function detectAuthorityIssues(
  entries: LedgerEntry[],
  options: { cap?: number } = {}
): { groups: AuthorityGroup[]; truncated: number } {
  const cap = options.cap ?? 50;
  const softDismissed = loadAuthoritySoftDismissals();
  const eligible = entries.filter((e) => !e.authority_dismissed);

  // Bucket: matchKey ("lastname|firstInitial") → variant ("Solnit,
  // Rebecca J." as stored) → { entryCount, handles }
  const buckets = new Map<
    string,
    Map<
      string,
      { handles: EntryHandle[]; firstFullSeen: Set<string>; matchKeyDisplay: string }
    >
  >();

  for (const e of eligible) {
    const fullAuthor = e.authorLF ?? e.author ?? '';
    if (!fullAuthor.trim()) continue;
    const individuals = splitMultiAuthor(fullAuthor);
    for (const indiv of individuals) {
      const parts = splitAuthorParts(indiv);
      if (!parts) continue;
      const matchKey = `${parts.lastname}|${parts.firstInitial}`;
      // Display form for the header — capitalize lastname, plus first
      // initial with a period. "solnit|r" → "Solnit, R."
      const lastDisplay = parts.lastname
        .split(/\s+/)
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ''))
        .join(' ');
      const matchKeyDisplay = `${lastDisplay}, ${parts.firstInitial.toUpperCase()}.`;

      let variants = buckets.get(matchKey);
      if (!variants) {
        variants = new Map();
        buckets.set(matchKey, variants);
      }
      const variantKey = indiv.trim();
      let v = variants.get(variantKey);
      if (!v) {
        v = {
          handles: [],
          firstFullSeen: new Set(),
          matchKeyDisplay,
        };
        variants.set(variantKey, v);
      }
      v.firstFullSeen.add(parts.firstFull);
      // Don't double-add a handle if the same multi-author entry has
      // two authors that hash to this same matchKey (rare, but defensive).
      const handle = entryHandle(e);
      if (
        !v.handles.some((h) =>
          h.isbn === handle.isbn &&
          h.titleNorm === handle.titleNorm &&
          h.authorNorm === handle.authorNorm &&
          h.date === handle.date &&
          h.batchLabel === handle.batchLabel
        )
      ) {
        v.handles.push(handle);
      }
    }
  }

  const groups: AuthorityGroup[] = [];
  for (const [matchKey, variantsMap] of buckets) {
    if (variantsMap.size < 2) continue;
    if (softDismissed.has(matchKey)) continue;
    // Filter: at least one variant must differ from the others in
    // first-name representation (full vs initial vs middle). If every
    // variant has the EXACT same firstFull spelling, they're really
    // identical strings (case/whitespace differences only) — those
    // aren't worth surfacing to the user.
    const allFirstFulls = new Set<string>();
    for (const v of variantsMap.values()) {
      for (const ff of v.firstFullSeen) allFirstFulls.add(ff);
    }
    if (allFirstFulls.size < 2) continue;

    const variants: AuthorityVariant[] = Array.from(variantsMap.entries())
      .map(([name, v]) => ({
        name,
        entryCount: v.handles.length,
        handles: v.handles,
      }))
      .sort((a, b) => b.entryCount - a.entryCount || a.name.localeCompare(b.name));
    const totalEntries = variants.reduce((s, v) => s + v.entryCount, 0);
    const display = variantsMap.values().next().value?.matchKeyDisplay ?? matchKey;
    groups.push({ matchKey, matchKeyDisplay: display, variants, totalEntries });
  }

  groups.sort((a, b) => {
    if (a.totalEntries !== b.totalEntries) {
      return b.totalEntries - a.totalEntries;
    }
    return a.matchKey.localeCompare(b.matchKey);
  });

  const truncated = Math.max(0, groups.length - cap);
  return { groups: groups.slice(0, cap), truncated };
}

/**
 * Standardize a list of ledger entries to a canonical author form.
 * Updates the author / authorLF / authorNorm fields and marks the
 * entry as authority_dismissed with `canonical_form` recorded so the
 * tool doesn't re-flag.
 *
 * `canonicalForm` should be the "Last, First Middle" string the user
 * picked — for multi-author entries we replace ONLY the matching
 * individual author within the original full string, leaving the
 * other co-authors intact.
 *
 * `lastnameInitial` is the matchKey ("lastname|firstInitial") of the
 * group — used to identify which individual author within a multi-
 * author entry to substitute.
 */
export async function applyAuthorityCanonical(
  handles: EntryHandle[],
  canonicalForm: string,
  matchKey: string
): Promise<RemoteLedgerResponse> {
  const dismissedAt = new Date().toISOString();
  const dismissed = { dismissedAt, canonical_form: canonicalForm };

  const local = loadLedger();
  const updates: {
    match: EntryHandle;
    set: Partial<
      Pick<
        LedgerEntry,
        'authority_dismissed' | 'author' | 'authorLF' | 'authorNorm'
      >
    >;
  }[] = [];

  const updated = local.map((e) => {
    const matched = handles.some(
      (h) =>
        h.isbn === e.isbn &&
        h.titleNorm === e.titleNorm &&
        h.authorNorm === e.authorNorm &&
        h.date === e.date &&
        (h.batchLabel ?? null) === (e.batchLabel ?? null)
    );
    if (!matched) return e;
    // Compute the new author string. For single-author entries it's
    // just the canonical form. For multi-author entries we substitute
    // only the individual author whose matchKey hits.
    const fullAuthor = e.authorLF ?? e.author ?? '';
    const individuals = splitMultiAuthor(fullAuthor);
    const rebuilt = individuals
      .map((indiv) => {
        const parts = splitAuthorParts(indiv);
        if (!parts) return indiv;
        const indivKey = `${parts.lastname}|${parts.firstInitial}`;
        return indivKey === matchKey ? canonicalForm : indiv;
      })
      .join('; ');
    const set: Partial<LedgerEntry> = {
      authority_dismissed: dismissed,
    };
    if (rebuilt !== fullAuthor) {
      set.authorLF = rebuilt;
      set.author = rebuilt;
      set.authorNorm = normalizeAuthor(rebuilt);
    }
    updates.push({
      match: {
        isbn: e.isbn,
        titleNorm: e.titleNorm,
        authorNorm: e.authorNorm,
        date: e.date,
        batchLabel: e.batchLabel ?? null,
      },
      set,
    });
    return { ...e, ...set };
  });
  saveLedger(updated);

  return pushLedgerDelta({ updateEntries: updates });
}

/** Dismiss an authority group as "actually different people" — sets
 *  authority_dismissed (no canonical_form) on every entry. */
export async function dismissAuthorityGroup(
  handles: EntryHandle[]
): Promise<RemoteLedgerResponse> {
  const dismissedAt = new Date().toISOString();
  const dismissed = { dismissedAt };

  const local = loadLedger();
  const updated = local.map((e) => {
    if (
      handles.some(
        (h) =>
          h.isbn === e.isbn &&
          h.titleNorm === e.titleNorm &&
          h.authorNorm === e.authorNorm &&
          h.date === e.date &&
          (h.batchLabel ?? null) === (e.batchLabel ?? null)
      )
    ) {
      return { ...e, authority_dismissed: dismissed };
    }
    return e;
  });
  saveLedger(updated);

  return pushLedgerDelta({
    updateEntries: handles.map((h) => ({
      match: h,
      set: { authority_dismissed: dismissed },
    })),
  });
}
