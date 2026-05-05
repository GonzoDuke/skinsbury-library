'use client';

import { useEffect, useState } from 'react';
import {
  deleteLedgerBatch,
  getLedgerBatches,
  pushLedgerDelta,
  syncLedgerFromRepo,
  type LedgerBatch,
} from '@/lib/export-ledger';

export default function LedgerPage() {
  const [batches, setBatches] = useState<LedgerBatch[]>([]);
  // Confirm-state lives in the page rather than per-card so opening one
  // confirmation closes any other open one — prevents accidental
  // multi-confirms when the user is bulk-cleaning the ledger.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Pull the authoritative ledger before rendering. If the remote isn't
    // available we silently fall back to whatever's in localStorage.
    syncLedgerFromRepo()
      .catch(() => null)
      .finally(() => {
        if (cancelled) return;
        setBatches(getLedgerBatches());
        setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function refresh() {
    setBatches(getLedgerBatches());
  }

  function batchKey(b: LedgerBatch): string {
    return b.batchLabel ?? '\0unlabeled\0';
  }

  function onDelete(b: LedgerBatch) {
    // Update local cache immediately so the UI never lags behind a click.
    deleteLedgerBatch(b.batchLabel);
    setConfirming(null);
    refresh();
    setSyncMessage('Syncing deletion to repo…');
    pushLedgerDelta({ removeBatchLabels: [b.batchLabel ?? null] })
      .then((res) => {
        if (!res.available) {
          setSyncMessage('Deleted locally — repo sync unavailable.');
          return;
        }
        if (res.error) {
          setSyncMessage(`Deleted locally; repo sync failed: ${res.error}`);
          return;
        }
        setSyncMessage('Deletion synced to repo.');
        // Server returns the post-merge state; refresh from the cache it
        // populated so any concurrent additions don't disappear from view.
        refresh();
        window.setTimeout(() => setSyncMessage(null), 4000);
      })
      .catch((err: unknown) =>
        setSyncMessage(
          `Deleted locally; repo sync failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }

  // Avoid the empty-state flashing on first paint while we read localStorage.
  if (!hydrated) {
    return (
      <div className="text-center py-16 text-ink/40 dark:text-cream-300/40 text-sm">
        Loading ledger…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="typo-page-title">Export Ledger</h1>
        <p className="typo-page-desc max-w-3xl">
          These are the books Carnegie remembers exporting. New scans that
          match an entry here are auto-rejected as duplicates on the Review
          screen. Delete a batch if you re-photograph the same shelf and
          want it treated as fresh — this only clears the app&apos;s local
          memory, never anything you&apos;ve already uploaded to LibraryThing.
        </p>
      </div>

      {syncMessage && (
        <div className="px-4 py-2 rounded-md text-xs bg-cream-100 dark:bg-ink/60 border border-cream-300 dark:border-brass/20 text-ink/70 dark:text-cream-300/80">
          {syncMessage}
        </div>
      )}

      {batches.length === 0 ? (
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-10 text-center">
          <h2 className="font-serif text-xl mb-2">No exported batches yet</h2>
          <p className="text-sm text-ink/55 dark:text-cream-300/55">
            Books appear here after you download a CSV from the Export screen.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {batches.map((b) => {
            const key = batchKey(b);
            const isConfirming = confirming === key;
            const dateRange =
              b.earliestDate === b.latestDate
                ? b.earliestDate
                : `${b.earliestDate} – ${b.latestDate}`;
            const labelDisplay =
              b.batchLabel === undefined ? (
                <span className="italic text-ink/55 dark:text-cream-300/55">
                  Unlabeled
                </span>
              ) : (
                <span className="font-medium">{b.batchLabel}</span>
              );

            return (
              <div
                key={key}
                className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-4 transition-all"
              >
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="text-base">{labelDisplay}</div>
                    <div className="mt-1 text-xs text-ink/55 dark:text-cream-300/55 flex items-center gap-2 flex-wrap">
                      <span>
                        {b.bookCount} book{b.bookCount === 1 ? '' : 's'}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="font-mono">{dateRange}</span>
                    </div>
                  </div>
                  {!isConfirming && (
                    <button
                      type="button"
                      onClick={() => setConfirming(key)}
                      className="text-xs px-3 py-1.5 rounded-md border border-cream-300 dark:border-ink-soft hover:border-mahogany dark:hover:border-tartan hover:text-mahogany dark:hover:text-orange-200 transition"
                    >
                      Delete batch
                    </button>
                  )}
                </div>

                {isConfirming && (
                  <div className="mt-3 pt-3 border-t border-cream-300 dark:border-ink-soft">
                    <p className="text-xs text-ink/75 dark:text-cream-300/75 leading-relaxed mb-3">
                      Delete batch{' '}
                      {b.batchLabel === undefined ? (
                        <span className="italic">Unlabeled</span>
                      ) : (
                        <>&ldquo;<span className="font-semibold">{b.batchLabel}</span>&rdquo;</>
                      )}{' '}
                      ({b.bookCount} book{b.bookCount === 1 ? '' : 's'})?
                      This removes them from the duplicate ledger — they will
                      no longer be flagged if re-scanned.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => onDelete(b)}
                        className="text-xs px-3 py-1.5 rounded-md bg-mahogany dark:bg-tartan text-cream-50 hover:bg-mahogany/90 dark:hover:bg-tartan/90 transition font-medium"
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="text-xs px-3 py-1.5 rounded-md border border-cream-300 dark:border-ink-soft hover:border-accent hover:text-accent transition"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
