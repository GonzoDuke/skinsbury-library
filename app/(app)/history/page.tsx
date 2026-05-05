'use client';

/**
 * History screen — a record of every batch the user has exported, with
 * the same expand-on-click pattern as the Review table. Source of
 * truth is the export ledger (lib/export-ledger.json on the repo,
 * mirrored to localStorage).
 *
 * Per spec §7:
 *   Top: lifetime stats line ("N books cataloged · M batches exported
 *        · First export: <date>") read from the ledger.
 *   Body: one row per batch with columns
 *           batch label / date exported / books / notes / actions.
 *         Sorted most-recent-first. Click to expand → compact sub-table
 *         of every book in that batch (title, author, ISBN, tags).
 *   Per-row actions:
 *           Re-download CSV — regenerate from ledger entries (uses the
 *           shared csv-export module).
 *           Delete from ledger — confirm-then-commit. Pushes through
 *           pushLedgerDelta({ removeBatchLabels }) so the change lands
 *           on the repo ledger and propagates to other devices on
 *           their next sync.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  loadLedger,
  pushLedgerDelta,
  syncLedgerFromRepo,
  type LedgerEntry,
} from '@/lib/export-ledger';
import { CSV_HEADERS, exportFilename, toAuthorLastFirst } from '@/lib/csv-export';
import { ImportLibraryThingDialog } from '@/components/ImportLibraryThingDialog';

/** Same escape rules as the canonical CSV writer in lib/csv-export.ts —
 *  inlined here so we don't have to widen its export surface for one
 *  call site. */
function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
import { TagChip } from '@/components/TagChip';

interface BatchGroup {
  /** Undefined for the unlabeled bucket. */
  batchLabel: string | undefined;
  earliestDate: string;
  latestDate: string;
  notes: string | undefined;
  entries: LedgerEntry[];
}

const UNLABELED = '\0unlabeled\0';

function groupByBatch(entries: LedgerEntry[]): BatchGroup[] {
  const map = new Map<string, BatchGroup>();
  for (const e of entries) {
    const key = e.batchLabel ?? UNLABELED;
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(e);
      if (e.date < existing.earliestDate) existing.earliestDate = e.date;
      if (e.date > existing.latestDate) existing.latestDate = e.date;
      if (!existing.notes && e.batchNotes) existing.notes = e.batchNotes;
    } else {
      map.set(key, {
        batchLabel: e.batchLabel,
        earliestDate: e.date,
        latestDate: e.date,
        notes: e.batchNotes,
        entries: [e],
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.latestDate !== b.latestDate) return a.latestDate < b.latestDate ? 1 : -1;
    const al = a.batchLabel ?? '';
    const bl = b.batchLabel ?? '';
    return al.localeCompare(bl);
  });
}

/** Build a CSV that matches what was originally exported, falling back
 *  to normalized fields for entries that pre-date the display-field
 *  capture (LedgerEntry { title, author, ... } added in step 8). */
function ledgerEntryToCsvRow(e: LedgerEntry): string[] {
  const tags = e.tags && e.tags.length > 0 ? e.tags.join(', ') : '';
  const title = e.title ?? e.titleNorm ?? '';
  const author = e.author ?? e.authorNorm ?? '';
  // Always recompute from the raw author string. Old ledger entries
  // carry a malformed authorLF for multi-author books cataloged before
  // the multi-author splitter shipped — recomputing fixes them at
  // re-download time.
  const authorLF = toAuthorLastFirst(author);
  const isbn = e.isbn ?? '';
  const publisher = e.publisher ?? '';
  const year = e.publicationYear ? String(e.publicationYear) : '';
  const collections = e.batchLabel ?? '';
  const comments = e.batchNotes ?? '';
  return [title, authorLF, isbn, publisher, year, tags, collections, comments, '1'];
}

function buildCsvFromLedger(entries: LedgerEntry[]): string {
  const lines: string[] = [];
  lines.push(CSV_HEADERS.map(csvEscape).join(','));
  for (const e of entries) {
    lines.push(ledgerEntryToCsvRow(e).map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function HistoryPage() {
  const [hydrated, setHydrated] = useState(false);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ kind: 'delete'; key: string } | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Pull the canonical ledger before rendering. If the remote isn't
  // available we fall back silently to localStorage.
  useEffect(() => {
    let cancelled = false;
    syncLedgerFromRepo()
      .catch(() => null)
      .finally(() => {
        if (cancelled) return;
        setEntries(loadLedger());
        setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function refreshFromLocal() {
    setEntries(loadLedger());
  }

  const groups = useMemo(() => groupByBatch(entries), [entries]);

  const lifetime = useMemo(() => {
    if (entries.length === 0) {
      return { books: 0, batches: 0, firstDate: '' };
    }
    let firstDate = entries[0].date;
    const labels = new Set<string>();
    for (const e of entries) {
      if (e.date < firstDate) firstDate = e.date;
      labels.add(e.batchLabel ?? UNLABELED);
    }
    return { books: entries.length, batches: labels.size, firstDate };
  }, [entries]);

  function batchKey(g: BatchGroup): string {
    return g.batchLabel ?? UNLABELED;
  }

  function downloadBatch(g: BatchGroup) {
    const csv = buildCsvFromLedger(g.entries);
    const earliest = new Date(g.earliestDate);
    const filename = exportFilename(g.entries.length, earliest, g.batchLabel, 'csv');
    // Prepend BOM so Excel reads UTF-8 — same convention the Export
    // screen uses for fresh downloads.
    triggerDownload(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }), filename);
    setStatusMsg(
      `Re-downloaded ${g.entries.length} ${g.entries.length === 1 ? 'book' : 'books'} from ${
        g.batchLabel ? `"${g.batchLabel}"` : 'unlabeled batch'
      }.`
    );
    window.setTimeout(() => setStatusMsg(null), 4000);
  }

  async function deleteBatch(g: BatchGroup) {
    const key = batchKey(g);
    setBusy({ kind: 'delete', key });
    setConfirmDelete(null);
    setStatusMsg('Deleting batch from ledger…');
    const res = await pushLedgerDelta({
      removeBatchLabels: [g.batchLabel ?? null],
    });
    setBusy(null);
    if (!res.available) {
      // Local-only fallback — remove from local cache directly.
      const next = loadLedger().filter((e) => (e.batchLabel ?? null) !== (g.batchLabel ?? null));
      try {
        localStorage.setItem('carnegie:export-ledger:v1', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      refreshFromLocal();
      setStatusMsg('Deleted locally — repo sync unavailable.');
      window.setTimeout(() => setStatusMsg(null), 4000);
      return;
    }
    if (res.error) {
      setStatusMsg(`Delete failed: ${res.error}`);
      // pushLedgerDelta already updated cache on success; on error we
      // leave it alone and re-pull from local.
      refreshFromLocal();
      return;
    }
    refreshFromLocal();
    setStatusMsg(
      `Deleted batch ${g.batchLabel ? `"${g.batchLabel}"` : '(unlabeled)'} — ${
        g.entries.length
      } ${g.entries.length === 1 ? 'entry' : 'entries'} removed.`
    );
    window.setTimeout(() => setStatusMsg(null), 4000);
  }

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <h1 className="typo-page-title">History</h1>
        <div className="text-[12px] text-text-tertiary italic">Loading ledger…</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="typo-page-title">History</h1>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-line text-text-secondary hover:border-navy hover:text-navy hover:bg-navy-soft transition"
          title="Seed the ledger from your existing LibraryThing catalog"
        >
          + Import from LibraryThing
        </button>
      </div>

      {importOpen && (
        <ImportLibraryThingDialog
          onClose={() => setImportOpen(false)}
          onImported={(count) => {
            // Refresh from local cache (pushLedgerDelta already updated it).
            refreshFromLocal();
            if (count > 0) {
              setStatusMsg(
                `Imported ${count} ${count === 1 ? 'book' : 'books'} from LibraryThing — visible below as the “LibraryThing Import” batch.`
              );
              window.setTimeout(() => setStatusMsg(null), 6000);
            }
          }}
        />
      )}

      {/* Lifetime stats line */}
      <div className="text-[13px] text-text-secondary border-b border-line pb-3">
        {lifetime.books === 0 ? (
          <>No batches exported yet.</>
        ) : (
          <>
            <span className="font-semibold text-text-primary">{lifetime.books}</span>{' '}
            {lifetime.books === 1 ? 'book' : 'books'} cataloged
            <span className="mx-2 text-text-quaternary">·</span>
            <span className="font-semibold text-text-primary">{lifetime.batches}</span>{' '}
            {lifetime.batches === 1 ? 'batch' : 'batches'} exported
            <span className="mx-2 text-text-quaternary">·</span>
            <span>First export:</span>{' '}
            <span className="font-mono text-[12px] text-text-tertiary">
              {lifetime.firstDate}
            </span>
          </>
        )}
      </div>

      {statusMsg && (
        <div className="bg-surface-card border border-line rounded-md px-3 py-2 text-[12px] text-text-secondary">
          {statusMsg}
        </div>
      )}

      {/* Batch table */}
      {groups.length === 0 ? (
        <div className="bg-surface-card border border-line rounded-lg p-10 text-center">
          <p className="text-[14px] font-semibold text-text-primary mb-1">
            No exported batches yet
          </p>
          <p className="text-[12px] text-text-tertiary">
            Books appear here after you download a CSV from the Export screen.
          </p>
        </div>
      ) : (
        <div className="bg-surface-card border border-line rounded-lg overflow-hidden">
          <div className="grid grid-cols-[1fr_120px_60px_1fr_180px] items-center gap-3 px-[14px] py-[7px] bg-surface-page border-b border-line">
            <span className="typo-label">Batch</span>
            <span className="typo-label">Date</span>
            <span className="typo-label">Books</span>
            <span className="typo-label">Notes</span>
            <span className="typo-label text-right">Actions</span>
          </div>
          {groups.map((g) => {
            const key = batchKey(g);
            const isOpen = openKey === key;
            const isConfirming = confirmDelete === key;
            const dateRange =
              g.earliestDate === g.latestDate
                ? g.earliestDate
                : `${g.earliestDate} – ${g.latestDate}`;
            return (
              <div key={key}>
                <div
                  onClick={() => setOpenKey(isOpen ? null : key)}
                  className="grid grid-cols-[1fr_120px_60px_1fr_180px] items-center gap-3 px-[14px] py-[10px] border-b border-line-light cursor-pointer transition-colors hover:bg-surface-card-hover"
                  role="button"
                  aria-expanded={isOpen}
                >
                  <div className="text-[14px] font-semibold text-text-primary truncate">
                    {g.batchLabel ?? (
                      <span className="italic text-text-tertiary font-normal">
                        Unlabeled
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-text-tertiary">
                    {dateRange}
                  </div>
                  <div className="text-[12px] text-text-secondary">
                    {g.entries.length}
                  </div>
                  <div className="text-[12px] text-text-tertiary truncate">
                    {g.notes ?? <span className="text-text-quaternary">—</span>}
                  </div>
                  <div
                    className="flex items-center gap-1 justify-end"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    {isConfirming ? (
                      <>
                        <button
                          type="button"
                          onClick={() => deleteBatch(g)}
                          disabled={busy?.kind === 'delete'}
                          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-carnegie-red text-carnegie-red hover:bg-carnegie-red-soft disabled:opacity-50 transition"
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(null)}
                          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-line text-text-tertiary hover:bg-surface-page transition"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => downloadBatch(g)}
                          className="text-[11px] px-2.5 py-1 rounded border border-line text-text-secondary hover:border-navy hover:text-navy hover:bg-navy-soft transition"
                          title="Regenerate the CSV from the ledger"
                        >
                          ↓ CSV
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(key)}
                          className="text-[11px] px-2.5 py-1 rounded border border-line text-text-tertiary hover:border-carnegie-red hover:text-carnegie-red hover:bg-carnegie-red-soft transition"
                          title="Remove this batch from duplicate detection (does not affect LibraryThing)"
                        >
                          ✕ Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isConfirming && (
                  <div className="px-[66px] py-3 bg-carnegie-red-soft/40 border-b border-line text-[12px] text-text-secondary">
                    Delete batch{' '}
                    {g.batchLabel ? (
                      <>
                        &ldquo;<strong>{g.batchLabel}</strong>&rdquo;
                      </>
                    ) : (
                      <em>(unlabeled)</em>
                    )}{' '}
                    ({g.entries.length} {g.entries.length === 1 ? 'book' : 'books'}) from
                    the ledger? These books will no longer be flagged as duplicates if
                    re-scanned. <strong>This does not affect LibraryThing.</strong>
                  </div>
                )}

                {isOpen && (
                  <div className="bg-surface-page px-[66px] py-3 border-b border-line">
                    <div className="grid grid-cols-[1fr_180px_140px_1fr] gap-3 px-2 py-1.5 text-[10px] uppercase tracking-[0.5px] text-text-tertiary font-semibold border-b border-line-light">
                      <span>Title</span>
                      <span>Author</span>
                      <span>ISBN</span>
                      <span>Tags</span>
                    </div>
                    {g.entries.map((e, i) => (
                      <div
                        key={`${e.isbn}-${i}`}
                        className="grid grid-cols-[1fr_180px_140px_1fr] gap-3 px-2 py-1.5 text-[12px] border-b border-line-light/60/60 last:border-b-0 items-center"
                      >
                        <span className="text-text-primary truncate">
                          {e.title ?? e.titleNorm ?? <em className="italic">untitled</em>}
                        </span>
                        <span className="text-text-secondary truncate">
                          {e.author ?? e.authorNorm ?? '—'}
                        </span>
                        <span className="font-mono text-[11px] text-text-tertiary">
                          {e.isbn || '—'}
                        </span>
                        <span className="flex flex-wrap gap-1 overflow-hidden">
                          {(e.tags ?? []).slice(0, 4).map((t) => (
                            <TagChip key={t} tag={t} variant="genre" size="sm" />
                          ))}
                          {(e.tags?.length ?? 0) > 4 && (
                            <span className="text-[10px] text-text-quaternary">
                              +{(e.tags?.length ?? 0) - 4}
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
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
