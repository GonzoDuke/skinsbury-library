import type { BookRecord } from './types';
import { bookToLedgerEntry, entriesMatch, loadLedger } from './export-ledger';

/**
 * Shared between the Upload-page "New session" button and the Review-page
 * "Clear batch" button — both warn before discarding the in-memory batch
 * data. When approved books exist that aren't in the ledger yet, we
 * upgrade the warning to a louder "export first?" message because those
 * are the ones that actually disappear forever on clear.
 *
 * Returns true when the user confirms (and the caller should proceed
 * with the destructive action), false when they cancel.
 */
export function confirmDiscardSession(books: BookRecord[]): boolean {
  if (books.length === 0) return true;
  const ledger = loadLedger();
  const approvedNotExported = books.filter((b) => {
    if (b.status !== 'approved') return false;
    const candidate = bookToLedgerEntry(b);
    // Books with no identifying fields can't match the ledger either way —
    // treat them as not-yet-exported so the loud warning fires.
    if (!candidate.isbn && !candidate.titleNorm) return true;
    return !ledger.some((e) => entriesMatch(e, candidate));
  });
  const message =
    approvedNotExported.length > 0
      ? `You have ${approvedNotExported.length} approved ${
          approvedNotExported.length === 1 ? 'book' : 'books'
        } that haven't been exported yet. Starting a new session will discard them. Export first?\n\nClick OK to discard anyway.`
      : `Start a new session? Any unapproved books will be lost. Exported books are safe in the ledger.`;
  return window.confirm(message);
}
