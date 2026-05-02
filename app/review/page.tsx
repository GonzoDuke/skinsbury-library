'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { BookTableRow } from '@/components/BookTableRow';
import { DebugErrorBoundary } from '@/components/DebugErrorBoundary';
import { SpineSelector } from '@/components/SpineSelector';
import { useStore } from '@/lib/store';
import { VOCAB, type DomainKey } from '@/lib/tag-domains';
import type { PhotoBatch } from '@/lib/types';
import { flagIfPreviouslyExported } from '@/lib/export-ledger';
import { confirmDiscardSession } from '@/lib/session';

type Filter = 'all' | 'pending' | 'approved' | 'rejected' | 'low';
type Sort = 'position' | 'confidence-desc' | 'confidence-asc';

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
  const { state, updateBook, addBook, getPendingFile, bulkRetag, clear } = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('position');
  const [addingFor, setAddingFor] = useState<PhotoBatch | null>(null);
  const [retagBusy, setRetagBusy] = useState(false);
  const [retagDomainOpen, setRetagDomainOpen] = useState(false);
  const [retagToast, setRetagToast] = useState<string | null>(null);

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
    if (!bookLcc || domainKey === '_unclassified') return false;
    const prefix = bookLcc.toUpperCase().match(/^[A-Z]{1,3}/)?.[0];
    if (!prefix) return false;
    return VOCAB.domains[domainKey].lcc_prefixes.some((p) => prefix.startsWith(p));
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
    if (sort === 'position') {
      return [...filtered].sort(
        (a, b) => a.spineRead.position - b.spineRead.position
      );
    }
    const dir = sort === 'confidence-desc' ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const d = (CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]) * dir;
      return d !== 0 ? d : a.spineRead.position - b.spineRead.position;
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

  if (state.allBooks.length === 0) {
    return <EmptyState />;
  }

  return (
    <DebugErrorBoundary>
    <div className="space-y-8">
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-4 flex-wrap">
            <h1 className="typo-page-title">Review &amp; approve</h1>
            <span className="text-base text-ink/50 dark:text-cream-300/50 font-mono">
              {counts.total} {counts.total === 1 ? 'book' : 'books'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              if (confirmDiscardSession(state.allBooks)) clear();
            }}
            disabled={state.allBooks.length === 0 && state.batches.length === 0}
            className="text-[12px] font-medium px-3 py-1.5 rounded-md border border-line text-text-secondary hover:border-carnegie-red hover:text-carnegie-red hover:bg-carnegie-red-soft transition disabled:opacity-40 disabled:cursor-not-allowed"
            title="Discard the current batch and start fresh — exported books stay in the ledger."
          >
            Clear batch
          </button>
        </div>
        <p className="typo-page-desc max-w-3xl">
          Verify each book&apos;s metadata and tags. Edit fields by clicking them. Only
          approved books make it into the export.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-8">
        <Stat label="Total" value={counts.total} active={filter === 'all'} />
        <Stat label="Pending" value={counts.pending} tone="brass" active={filter === 'pending'} />
        <Stat label="Approved" value={counts.approved} tone="green" active={filter === 'approved'} />
        <Stat label="Rejected" value={counts.rejected} tone="red" active={filter === 'rejected'} />
        <Stat label="Low confidence" value={counts.low} tone="mahogany" active={filter === 'low'} />
      </div>

      {/* Filter + sort row + bulk actions */}
      <div className="flex flex-wrap items-center gap-3 pb-3 border-b border-cream-300 dark:border-ink-soft">
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
                .filter(([k]) => k !== '_unclassified')
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

      {/* Compact book table — replaces the v2 grouped-card layout. Sticky
          column header, click any row to expand its detail panel. */}
      <div className="bg-surface-card border border-line rounded-lg overflow-hidden">
        <div className="grid grid-cols-[52px_1fr_80px_200px_100px] items-center gap-3 px-[14px] py-[7px] bg-surface-page border-b border-line sticky top-0 z-[5]">
          <span />
          <span className="typo-label">Book</span>
          <span className="typo-label">Conf.</span>
          <span className="typo-label">Tags</span>
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

      {/* Add-missing-book launcher — flat list of every photo batch with a
          source file still in memory. Per-batch grouping moved off the
          review list, so this row is the entry point now. */}
      {state.batches.filter(
        (b) => b.status === 'done' || b.status === 'processing'
      ).length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-2">
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
        <div className="sticky bottom-4 flex justify-center">
          <button
            onClick={approveRemaining}
            className="text-sm px-6 py-2 rounded-md bg-navy-soft text-navy font-semibold shadow-md hover:bg-navy-mid transition"
          >
            Approve remaining ({counts.pending})
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
    </div>
    </DebugErrorBoundary>
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
        href="/"
        className="inline-block px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition"
      >
        Go to upload
      </Link>
    </div>
  );
}
