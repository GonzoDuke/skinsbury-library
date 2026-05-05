/**
 * Batch label defaults — every newly-created batch gets a meaningful
 * label even when the user doesn't type one. The user's own label
 * always wins; this helper only fires when the input was empty at
 * batch creation time.
 *
 * Naming convention by entry method:
 *   photo  → "Shelf YYYY-MM-DD"     (subsequent same-day → " #2", " #3")
 *   scan   → "Scans YYYY-MM-DD"
 *   manual → "Manual YYYY-MM-DD"
 *
 * Disambiguation looks at BOTH the in-progress local batches and the
 * historical export-ledger entries so a label that previously shipped
 * isn't reused. Returns the bare base label when no collision exists,
 * else " #N" where N is the lowest unused integer ≥ 2.
 */

import type { PhotoBatch } from './types';
import type { LedgerEntry } from './export-ledger';

export type BatchSourceKind = 'photo' | 'scan' | 'manual';

const PREFIX_BY_KIND: Record<BatchSourceKind, string> = {
  photo: 'Shelf',
  scan: 'Scans',
  manual: 'Manual',
};

function todayISO(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Compute the auto-default label for a freshly-created batch. Pass
 * `existingBatches` (the in-progress store) and `ledgerEntries` (the
 * local ledger cache via loadLedger) so the helper can detect both
 * already-shipped collisions and active-session collisions.
 */
export function getDefaultBatchLabel(
  kind: BatchSourceKind,
  existingBatches: PhotoBatch[],
  ledgerEntries: LedgerEntry[],
  now: Date = new Date()
): string {
  const date = todayISO(now);
  const base = `${PREFIX_BY_KIND[kind]} ${date}`;

  // Build the set of labels already in use today across both the live
  // store and the ledger. Match on exact case-sensitive equality —
  // user-typed custom labels with different casing don't collide.
  const used = new Set<string>();
  for (const b of existingBatches) {
    if (b.batchLabel) used.add(b.batchLabel);
  }
  for (const e of ledgerEntries) {
    if (e.batchLabel) used.add(e.batchLabel);
  }

  if (!used.has(base)) return base;

  // Walk #2, #3, ... until we find an unused suffix. Cap at #999 as a
  // sanity bound — practically the user will never approach this.
  for (let n = 2; n <= 999; n++) {
    const candidate = `${base} #${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Last resort: append a millisecond timestamp. Shouldn't fire in
  // practice; defensive only.
  return `${base} #${now.getTime()}`;
}
