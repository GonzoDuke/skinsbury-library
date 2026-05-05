'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BookTableRow } from '@/components/BookTableRow';
import { MobileBookCard } from '@/components/MobileBookCard';
import { DebugErrorBoundary } from '@/components/DebugErrorBoundary';
import { SpineSelector } from '@/components/SpineSelector';
import { useStore } from '@/lib/store';
import { VOCAB, domainForLcc, type DomainKey } from '@/lib/tag-domains';
import type { PhotoBatch } from '@/lib/types';
import {
  flagIfPreviouslyExported,
  renameBatchLabelInLocalLedger,
  syncLedgerFromRepo,
} from '@/lib/export-ledger';
import { syncCorrectionsFromRepo } from '@/lib/corrections-log';
import { confirmDiscardSession } from '@/lib/session';
import { fireUndo } from '@/components/UndoToast';
import { EditableBatchLabel } from '@/components/EditableBatchLabel';

type Filter = 'all' | 'pending' | 'approved' | 'rejected' | 'low';
type Sort =
  | 'position'
  | 'confidence-desc'
  | 'confidence-asc'
  | 'title-asc'
  | 'title-desc'
  | 'tags-desc'
  | 'tags-asc';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'low', label: 'Low confidence' },
];

const SORTS: { id: Sort; label: string; title: string }[] = [
  { id: 'position', label: 'Position', title: 'Order books left-to-right by where they were on the shelf' },
  { id: 'confidence-desc', label: 'Confidence ↓', title: 'High confidence first' },
  { id: 'confidence-asc', label: 'Confidence ↑', title: 'Low confidence first' },
];

const CONFIDENCE_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

export default function ReviewPage() {
  const { state, updateBook, updateBatch, addBook, addBatch, getPendingFile, bulkRetag, clear } = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('position');
  const [addingFor, setAddingFor] = useState<PhotoBatch | null>(null);
  const [retagBusy, setRetagBusy] = useState(false);
  const [retagDomainOpen, setRetagDomainOpen] = useState(false);
  const [retagToast, setRetagToast] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<
    'idle' | 'pending' | 'done' | 'error'
  >('idle');
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  async function refreshFromCloud() {
    if (refreshState === 'pending') return;
    setRefreshState('pending');
    setRefreshMessage(null);
    try {
      // Pull the export ledger and corrections log from GitHub. The
      // ledger drives previously-exported flagging — a stale local copy
      // means duplicates can slip through. Cross-device pending-batches
      // sync was removed; in-flight batches are device-local.
      const [ledger, corrections] = await Promise.all([
        syncLedgerFromRepo().catch(() => null),
        syncCorrectionsFromRepo().catch(() => null),
      ]);
      if (!ledger && !corrections) {
        setRefreshState('error');
        setRefreshMessage('Sync unavailable — working offline.');
        setTimeout(() => setRefreshState('idle'), 3500);
        return;
      }
      setRefreshState('done');
      const ledgerPart = ledger
        ? `Ledger synced (${ledger.length} entries)`
        : 'Ledger unchanged';
      const correctionsPart = corrections
        ? `; corrections synced (${corrections.length}).`
        : '.';
      setRefreshMessage(`${ledgerPart}${correctionsPart}`);
      setTimeout(() => setRefreshState('idle'), 3500);
    } catch {
      setRefreshState('error');
      setRefreshMessage('Refresh failed.');
      setTimeout(() => setRefreshState('idle'), 3500);
    }
  }

  async function runBulkRetag(ids: string[], scopeLabel: string) {
    if (ids.length === 0 || retagBusy) return;
    const ok = window.confirm(
      `This will replace existing tags on ${ids.length} ${
        ids.length === 1 ? 'book' : 'books'
      } (${scopeLabel}) with fresh inferences from the current vocabulary.\n\n` +
        'Books where you manually edited tags will MERGE — your additions are kept.\n\n' +
        'Continue?'
    );
    if (!ok) return;
    setRetagBusy(true);
    setRetagToast(null);
    const result = await bulkRetag(ids);
    setRetagBusy(false);
    setRetagDomainOpen(false);
    setRetagToast(
      result.errors > 0
        ? `Re-tagged ${result.done} of ${ids.length} (${result.errors} failed)`
        : `Re-tagged ${result.done} ${result.done === 1 ? 'book' : 'books'}`
    );
    setTimeout(() => setRetagToast(null), 5000);
  }

  function bookMatchesDomain(bookLcc: string, domainKey: DomainKey): boolean {
    if (!bookLcc) return false;
    return domainForLcc(bookLcc) === domainKey;
  }

  const counts = useMemo(() => {
    const c = { total: 0, pending: 0, approved: 0, rejected: 0, low: 0 };
    for (const b of state.allBooks) {
      c.total += 1;
      c[b.status] += 1;
      if (b.confidence === 'LOW') c.low += 1;
    }
    return c;
  }, [state.allBooks]);

  const visibleBooks = useMemo(() => {
    const filtered = state.allBooks.filter((b) => {
      if (filter === 'all') return true;
      if (filter === 'low') return b.confidence === 'LOW';
      return b.status === filter;
    });
    const byPosition = (a: typeof filtered[number], b: typeof filtered[number]) =>
      a.spineRead.position - b.spineRead.position;
    if (sort === 'position') {
      return [...filtered].sort(byPosition);
    }
    if (sort === 'title-asc' || sort === 'title-desc') {
      const dir = sort === 'title-desc' ? -1 : 1;
      return [...filtered].sort((a, b) => {
        const d = (a.title || '').localeCompare(b.title || '') * dir;
        return d !== 0 ? d : byPosition(a, b);
      });
    }
    if (sort === 'tags-asc' || sort === 'tags-desc') {
      const dir = sort === 'tags-desc' ? -1 : 1;
      return [...filtered].sort((a, b) => {
        const aCount = (a.genreTags?.length ?? 0) + (a.formTags?.length ?? 0);
        const bCount = (b.genreTags?.length ?? 0) + (b.formTags?.length ?? 0);
        const d = (aCount - bCount) * dir;
        return d !== 0 ? d : byPosition(a, b);
      });
    }
    const dir = sort === 'confidence-desc' ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const d = (CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]) * dir;
      return d !== 0 ? d : byPosition(a, b);
    });
  }, [state.allBooks, filter, sort]);

  function approveAllHigh() {
    state.allBooks
      .filter((b) => b.confidence === 'HIGH' && b.status === 'pending')
      .forEach((b) => updateBook(b.id, { status: 'approved' }));
  }

  function approveRemaining() {
    state.allBooks
      .filter((b) => b.status === 'pending')
      .forEach((b) => updateBook(b.id, { status: 'approved' }));
  }

  const router = useRouter();
  function approveAllAndExport() {
    const willApprove = state.allBooks.filter((b) => b.status === 'pending').length;
    const total = state.allBooks.length;
    const ok = window.confirm(
      `Approve ${willApprove > 0 ? willApprove + ' remaining ' : ''}${total === 1 ? 'book' : 'books'} and download CSV?`
    );
    if (!ok) return;
    state.allBooks
      .filter((b) => b.status === 'pending')
      .forEach((b) => updateBook(b.id, { status: 'approved' }));
    // Hand off to /export?auto=1 — that page reads the param and
    // auto-fires its own downloadCsv() on mount.
    router.push('/export?auto=1');
  }

  // Render the header (with the Refresh button) ALWAYS, then
  // conditionally render either the EmptyState content or the
  // populated body underneath. This is what makes "↻ Refresh from
  // cloud" visible on tablet / desktop before any books have synced
  // — which is the very moment the user wants to click it.
  const isEmpty = state.allBooks.length === 0;

  return (
    <DebugErrorBoundary>
    <div className="space-y-8">
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-4 flex-wrap">
            <h1 className="typo-page-title">Review &amp; approve</h1>
            {!isEmpty && (
              <span className="text-base text-ink/50 dark:text-cream-300/50 font-mono">
                {counts.total} {counts.total === 1 ? 'book' : 'books'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshFromCloud}
              disabled={refreshState === 'pending'}
              className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-line text-text-secondary hover:border-navy hover:text-navy hover:bg-navy-soft transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Pull batches just-processed on other devices (e.g. a phone capture)."
            >
              {refreshState === 'pending' ? '⟳ Refreshing…' : '↻ Refresh from cloud'}
            </button>
            {!isEmpty && (
              <button
                type="button"
                onClick={() => {
                  if (!confirmDiscardSession(state.allBooks)) return;
                  const snapshot = state.batches;
                  const batchCount = snapshot.length;
                  clear();
                  if (batchCount > 0) {
                    fireUndo(
                      `Cleared session (${batchCount} ${batchCount === 1 ? 'batch' : 'batches'}).`,
                      () => {
                        for (const b of snapshot) addBatch(b);
                      }
                    );
                  }
                }}
                disabled={state.allBooks.length === 0 && state.batches.length === 0}
                className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-line text-text-secondary hover:border-carnegie-red hover:text-carnegie-red hover:bg-carnegie-red-soft transition disabled:opacity-40 disabled:cursor-not-allowed"
                title="Discard the current batch and start fresh — exported books stay in the ledger."
              >
                Clear batch
              </button>
            )}
          </div>
        </div>
        {refreshMessage && refreshState !== 'pending' && (
          <div
            className={`mt-2 text-[12px] ${
              refreshState === 'error' ? 'text-carnegie-red' : 'text-text-tertiary'
            }`}
          >
            {refreshMessage}
          </div>
        )}
        {!isEmpty && (
          <p className="typo-page-desc max-w-3xl">
            Verify each book&apos;s metadata and tags. Edit fields by clicking them. Only
            approved books make it into the export.
          </p>
        )}

        {/* Batch label strip — one editable chip per batch in the
            session. Click a label to rename; the change updates the
            local store immediately and rewrites matching ledger entries
            (local cache) so already-exported books reflect the new
            label without waiting on a remote write. */}
        {!isEmpty && state.batches.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-3">
            <span className="typo-label">
              {state.batches.length === 1 ? 'Batch' : 'Batches'}
            </span>
            {state.batches.map((b, i) => (
              <span key={b.id} className="inline-flex items-center gap-1.5">
                {i > 0 && (
                  <span aria-hidden className="text-text-quaternary">
                    ·
                  </span>
                )}
                <EditableBatchLabel
                  size="sm"
                  value={b.batchLabel ?? ''}
                  placeholder="Untitled batch"
                  onSave={(next) => {
                    const prev = b.batchLabel;
                    updateBatch(b.id, { batchLabel: next });
                    renameBatchLabelInLocalLedger(prev, next);
                  }}
                />
              </span>
            ))}
          </div>
        )}
      </div>

      {isEmpty && (
        // EmptyState body inlined here so the page header (with the
        // Refresh button) stays visible above it. The Refresh button
        // is exactly what the user wants to click in this state — to
        // pull batches another device just processed.
        <div className="text-center py-12">
          <p className="text-sm text-ink/60 dark:text-cream-300/60 mb-6">
            Nothing to review yet. Upload a shelf photo, or click <span className="font-mono">↻ Refresh from cloud</span> above to pull batches processed on another device.
          </p>
          <Link
            href="/upload"
            className="inline-block px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition"
          >
            Go to upload
          </Link>
        </div>
      )}

      {!isEmpty && (
      <>
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-8">
        <Stat label="Total" value={counts.total} active={filter === 'all'} />
        <Stat label="Pending" value={counts.pending} tone="brass" active={filter === 'pending'} />
        <Stat label="Approved" value={counts.approved} tone="green" active={filter === 'approved'} />
        <Stat label="Rejected" value={counts.rejected} tone="red" active={filter === 'rejected'} />
        <Stat label="Low confidence" value={counts.low} tone="mahogany" active={filter === 'low'} />
      </div>

      {/* Phone filter chips — just the basic status filters, no sort
          controls and no bulk re-tag (those are desktop affordances). */}
      <div className="md:hidden flex gap-1.5 flex-wrap pb-3 border-b border-cream-300 dark:border-ink-soft">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`text-xs px-3 py-1.5 rounded-md transition ${
              filter === f.id
                ? 'bg-accent text-cream-50'
                : 'bg-cream-100 text-ink/70 dark:text-cream-300/70'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Filter + sort row + bulk actions (desktop / tablet). */}
      <div className="hidden md:flex flex-wrap items-center gap-3 pb-3 border-b border-cream-300 dark:border-ink-soft">
        <div className="flex gap-1 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`text-xs px-3 py-1.5 rounded-md transition ${
                filter === f.id
                  ? 'bg-accent text-cream-50'
                  : 'bg-cream-100 text-ink/70 dark:text-cream-300/70 hover:bg-accent-soft dark:hover:bg-accent/20'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-2">
          <span className="text-[11px] uppercase tracking-wider text-ink/40 dark:text-cream-300/40 font-semibold mr-1">
            Sort
          </span>
          {SORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSort(s.id)}
              title={s.title}
              className={`text-xs px-3 py-1.5 rounded-md transition ${
                sort === s.id
                  ? 'bg-accent text-cream-50'
                  : 'bg-cream-100 text-ink/70 dark:text-cream-300/70 hover:bg-accent-soft dark:hover:bg-accent/20'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Bulk re-tag controls */}
        <div className="relative">
          <button
            onClick={() =>
              runBulkRetag(
                state.allBooks.filter((b) => b.status === 'approved').map((b) => b.id),
                'all approved'
              )
            }
            disabled={
              retagBusy ||
              state.allBooks.filter((b) => b.status === 'approved').length === 0
            }
            className="text-xs px-3 py-1.5 rounded-md border border-fern/40 text-fern dark:text-brass hover:bg-fern/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
            title="Re-run tag inference on every approved book using the current vocabulary"
          >
            ↻ Re-tag all approved
          </button>
        </div>
        <div className="relative">
          <button
            onClick={() => setRetagDomainOpen((v) => !v)}
            disabled={retagBusy}
            className="text-xs px-3 py-1.5 rounded-md border border-fern/40 text-fern dark:text-brass hover:bg-fern/10 transition disabled:opacity-40"
          >
            ↻ Re-tag by domain ▾
          </button>
          {retagDomainOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 w-72 bg-cream-50 border border-cream-300 dark:border-ink-soft rounded-md shadow-lg p-2 space-y-0.5">
              {(Object.entries(VOCAB.domains) as [DomainKey, typeof VOCAB.domains[DomainKey]][])
                .map(([key, def]) => {
                  const matchingIds = state.allBooks
                    .filter((b) => bookMatchesDomain(b.lcc, key))
                    .map((b) => b.id);
                  return (
                    <button
                      key={key}
                      onClick={() => runBulkRetag(matchingIds, def.label)}
                      disabled={matchingIds.length === 0}
                      className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent-soft dark:hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition flex justify-between items-center"
                    >
                      <span>{def.label}</span>
                      <span className="text-[10px] text-ink/45 dark:text-cream-300/45 font-mono">
                        {matchingIds.length}
                      </span>
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        <button
          onClick={approveAllHigh}
          className="text-xs px-3 py-1.5 rounded-md bg-brass-soft text-brass-deep hover:bg-brass hover:text-accent-deep transition font-medium"
        >
          Approve all HIGH confidence
        </button>
      </div>

      {/* Retag toast */}
      {retagToast && (
        <div className="bg-brass-soft dark:bg-brass/15 border border-brass/40 rounded-md px-4 py-2 text-sm text-brass-deep dark:text-brass">
          {retagToast}
        </div>
      )}

      {/* Compact book table (desktop / tablet). Sticky column header,
          click any row to expand its detail panel. */}
      <div className="hidden md:block bg-surface-card border border-line rounded-lg overflow-hidden">
        <div className="grid grid-cols-[72px_1fr_90px_240px_120px] items-center gap-4 px-[16px] py-[10px] bg-surface-page border-b border-line sticky top-0 z-[5]">
          <span />
          <SortHeader
            label="Book"
            current={sort}
            asc="title-asc"
            desc="title-desc"
            setSort={setSort}
          />
          <SortHeader
            label="Conf."
            current={sort}
            asc="confidence-asc"
            desc="confidence-desc"
            setSort={setSort}
          />
          <SortHeader
            label="Tags"
            current={sort}
            asc="tags-asc"
            desc="tags-desc"
            setSort={setSort}
          />
          <span className="typo-label text-right">Action</span>
        </div>

        {visibleBooks.length === 0 ? (
          <div className="text-sm text-text-tertiary italic p-8 text-center">
            No books in this filter.
          </div>
        ) : (
          visibleBooks.map((book) => <BookTableRow key={book.id} book={book} />)
        )}
      </div>

      {/* Phone card list. Same data, same store, same filter chips. */}
      <div className="md:hidden space-y-3">
        {visibleBooks.length === 0 ? (
          <div className="text-sm text-text-tertiary italic p-8 text-center bg-surface-card border border-line rounded-lg">
            No books in this filter.
          </div>
        ) : (
          visibleBooks.map((book) => <MobileBookCard key={book.id} book={book} />)
        )}
      </div>

      {/* Add-missing-book launcher — flat list of every photo batch with a
          source file still in memory. Per-batch grouping moved off the
          review list, so this row is the entry point now. */}
      {state.batches.filter(
        (b) => b.status === 'done' || b.status === 'processing'
      ).length > 0 && (
        <div className="hidden md:flex flex-wrap items-center gap-2 pt-2">
          <span className="typo-label">Add a missed book:</span>
          {state.batches
            .filter((b) => b.status === 'done' || b.status === 'processing')
            .map((b) => (
              <button
                key={b.id}
                onClick={() => setAddingFor(b)}
                className="text-xs px-3 py-1.5 rounded-md border border-dashed border-navy/60 text-navy hover:bg-navy-soft transition"
                title={`Open ${b.filename} and draw / type a missed spine`}
              >
                + from {b.filename.length > 28 ? b.filename.slice(0, 25) + '…' : b.filename}
              </button>
            ))}
        </div>
      )}

      {/* Bottom bulk action */}
      {counts.pending > 0 && (
        <div className="sticky bottom-4 flex justify-center gap-2 flex-wrap">
          <button
            onClick={approveRemaining}
            className="text-sm px-6 py-2 rounded-md bg-navy-soft text-navy font-semibold shadow-md hover:bg-navy-mid transition"
          >
            Approve remaining ({counts.pending})
          </button>
          <button
            onClick={approveAllAndExport}
            className="text-sm px-6 py-2 rounded-md bg-accent text-cream-50 font-semibold shadow-md hover:bg-accent-deep transition"
            title="Approve every pending book and immediately download the CSV"
          >
            Approve all &amp; export
          </button>
        </div>
      )}
      {counts.pending === 0 && counts.approved > 0 && (
        <div className="sticky bottom-4 flex justify-center">
          <button
            onClick={approveAllAndExport}
            className="text-sm px-6 py-2 rounded-md bg-accent text-cream-50 font-semibold shadow-md hover:bg-accent-deep transition"
            title="Download a CSV of every approved book"
          >
            Export all approved ({counts.approved})
          </button>
        </div>
      )}

      <div className="flex justify-end pt-4 border-t border-cream-300 dark:border-ink-soft">
        <Link
          href="/export"
          className="text-sm px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition shadow-sm"
        >
          Continue to export →
        </Link>
      </div>

      {addingFor && (
        <SpineSelector
          batch={addingFor}
          sourceFile={getPendingFile(addingFor.id)}
          onAdd={(book) => addBook(addingFor.id, flagIfPreviouslyExported(book))}
          onClose={() => setAddingFor(null)}
        />
      )}
      </>
      )}
    </div>
    </DebugErrorBoundary>
  );
}

/**
 * Clickable column header that toggles between asc / desc / off.
 * First click → desc (most users want "best at top" for confidence
 * and "most tags" for tags); second click flips to asc; third click
 * resets to position order. Active arrow tells the user which
 * column drives the current sort.
 */
function SortHeader({
  label,
  current,
  asc,
  desc,
  setSort,
}: {
  label: string;
  current: Sort;
  asc: Sort;
  desc: Sort;
  setSort: (s: Sort) => void;
}) {
  const active = current === asc || current === desc;
  const arrow = current === desc ? '↓' : current === asc ? '↑' : '';
  function onClick() {
    if (current === desc) setSort(asc);
    else if (current === asc) setSort('position');
    else setSort(desc);
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`typo-label inline-flex items-center gap-1 hover:text-navy transition cursor-pointer ${active ? 'text-navy' : ''}`}
    >
      {label}
      {arrow && <span className="text-[10px]">{arrow}</span>}
    </button>
  );
}

function Stat({
  label,
  value,
  tone,
  active,
}: {
  label: string;
  value: number;
  tone?: 'brass' | 'green' | 'red' | 'mahogany';
  active?: boolean;
}) {
  // Each tile gets a colored left rail. The text tone follows it. Active
  // filter brightens the tile's background slightly toward its accent
  // color so the user sees which filter the list is responding to.
  const accent =
    tone === 'brass'
      ? { rail: '#C4A35A', text: 'text-brass-deep dark:text-brass', tint: 'bg-brass/5 dark:bg-brass/10' }
      : tone === 'green'
        ? { rail: '#1A8754', text: 'text-[#1A8754] dark:text-green-400', tint: 'bg-[#1A8754]/5 dark:bg-green-900/15' }
        : tone === 'red'
          ? { rail: '#B83232', text: 'text-[#B83232] dark:text-orange-300', tint: 'bg-[#B83232]/5 dark:bg-red-900/15' }
          : tone === 'mahogany'
            ? { rail: '#B83232', text: 'text-mahogany dark:text-orange-200', tint: 'bg-mahogany/5 dark:bg-mahogany/15' }
            : { rail: '#1B3A5C', text: 'text-accent dark:text-accent', tint: 'bg-accent/5 dark:bg-accent/15' };
  return (
    <div
      className={`relative bg-cream-50/60 border border-cream-300 dark:border-ink-soft rounded-xl p-4 pl-5 transition-colors ${
        active ? accent.tint : ''
      }`}
      style={{ borderLeft: `3px solid ${accent.rail}` }}
    >
      <div className="text-[11px] uppercase tracking-[0.5px] font-medium text-ink/55 dark:text-cream-300/55 mb-1.5">
        {label}
      </div>
      <div className={`text-[28px] font-semibold leading-none ${accent.text}`}>{value}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <h1 className="font-serif text-3xl mb-3">Nothing to review yet</h1>
      <p className="text-sm text-ink/60 dark:text-cream-300/60 mb-6">
        Upload some shelf photos first.
      </p>
      <Link
        href="/upload"
        className="inline-block px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition"
      >
        Go to upload
      </Link>
    </div>
  );
}
