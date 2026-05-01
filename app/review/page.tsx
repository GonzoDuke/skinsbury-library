'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { BookCard } from '@/components/BookCard';
import { SpineSelector } from '@/components/SpineSelector';
import { useStore } from '@/lib/store';
import { VOCAB, type DomainKey } from '@/lib/tag-domains';
import type { PhotoBatch } from '@/lib/types';
import { flagIfPreviouslyExported } from '@/lib/export-ledger';

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
  const { state, updateBook, addBook, getPendingFile, bulkRetag } = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('position');
  const [addingFor, setAddingFor] = useState<PhotoBatch | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retagBusy, setRetagBusy] = useState(false);
  const [retagDomainOpen, setRetagDomainOpen] = useState(false);
  const [retagToast, setRetagToast] = useState<string | null>(null);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    <div className="space-y-8">
      <div>
        <div className="flex items-baseline gap-4 flex-wrap">
          <h1 className="typo-page-title">Review &amp; approve</h1>
          <span className="text-base text-ink/50 dark:text-cream-300/50 font-mono">
            {counts.total} {counts.total === 1 ? 'book' : 'books'}
          </span>
        </div>
        <p className="typo-page-desc max-w-3xl">
          Verify each book&apos;s metadata and tags. Edit fields by clicking them. Only
          approved books make it into the export.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-8">
        <Stat label="Total" value={counts.total} />
        <Stat label="Pending" value={counts.pending} tone="brass" />
        <Stat label="Approved" value={counts.approved} tone="green" />
        <Stat label="Rejected" value={counts.rejected} tone="red" />
        <Stat label="Low confidence" value={counts.low} tone="mahogany" />
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
                  : 'bg-cream-100 dark:bg-ink-soft text-ink/70 dark:text-cream-300/70 hover:bg-accent-soft dark:hover:bg-accent/20'
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
                  : 'bg-cream-100 dark:bg-ink-soft text-ink/70 dark:text-cream-300/70 hover:bg-accent-soft dark:hover:bg-accent/20'
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
            <div className="absolute right-0 top-full mt-1 z-20 w-72 bg-cream-50 dark:bg-ink-soft border border-cream-300 dark:border-ink-soft rounded-md shadow-lg p-2 space-y-0.5">
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

      {/* Book list — grouped by batch label */}
      <div className="space-y-6">
        {visibleBooks.length === 0 ? (
          <div className="text-sm text-ink/50 dark:text-cream-300/50 italic p-8 text-center border border-dashed border-cream-300 dark:border-ink-soft rounded-lg">
            No books in this filter.
          </div>
        ) : (
          (() => {
            const groups = new Map<string, typeof visibleBooks>();
            for (const b of visibleBooks) {
              const key = b.batchLabel ?? '';
              const arr = groups.get(key) ?? [];
              arr.push(b);
              groups.set(key, arr);
            }
            const groupKeys = Array.from(groups.keys()).sort((a, b) => {
              if (a === '' && b !== '') return 1; // Uncategorized last
              if (b === '' && a !== '') return -1;
              return a.localeCompare(b);
            });
            const onlyOneGroup = groupKeys.length === 1 && groupKeys[0] === '';
            return groupKeys.map((key) => {
              const groupBooks = groups.get(key)!;
              const label = key || 'Uncategorized';
              const pendingInGroup = groupBooks.filter((b) => b.status === 'pending');
              // Photo batches that belong to this label-group. Used by the
              // "Add missing book" button — we render one per photo so the
              // user can pick which photo to augment when a label has more
              // than one.
              const groupBatches = state.batches.filter(
                (b) => (b.batchLabel ?? '') === key && (b.status === 'done' || b.status === 'processing')
              );
              return (
                <div key={key} className="space-y-3">
                  {!onlyOneGroup && (
                    <div className="sticky top-[88px] z-[5] bg-cream-50/95 dark:bg-ink/95 backdrop-blur border-b border-cream-300 dark:border-ink-soft py-2 -mx-2 px-2 flex items-center gap-3">
                      <h2 className="font-serif text-xl text-ink dark:text-cream-100">{label}</h2>
                      <span className="text-xs text-ink/50 dark:text-cream-300/50">
                        {groupBooks.length} book{groupBooks.length !== 1 ? 's' : ''}
                      </span>
                      <div className="flex-1" />
                      {pendingInGroup.length > 0 && (
                        <button
                          onClick={() =>
                            pendingInGroup.forEach((b) =>
                              updateBook(b.id, { status: 'approved' })
                            )
                          }
                          className="text-[11px] px-2.5 py-1 rounded border border-green-400/70 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/30 transition"
                        >
                          Approve all in {label} ({pendingInGroup.length})
                        </button>
                      )}
                    </div>
                  )}
                  <div className="space-y-3">
                    {groupBooks.map((book) => (
                      <BookCard
                        key={book.id}
                        book={book}
                        selectable
                        selected={selected.has(book.id)}
                        onToggleSelected={toggleSelected}
                      />
                    ))}
                  </div>
                  {groupBatches.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                      <span className="text-[11px] uppercase tracking-wider text-ink/40 dark:text-cream-300/40 font-semibold">
                        Add a missed book:
                      </span>
                      {groupBatches.map((b) => (
                        <button
                          key={b.id}
                          onClick={() => setAddingFor(b)}
                          className="text-xs px-3 py-1.5 rounded-md border border-dashed border-accent/60 text-accent hover:bg-accent-soft dark:hover:bg-accent/20 transition"
                          title={`Open ${b.filename} and draw / type a missed spine`}
                        >
                          + from {b.filename.length > 28 ? b.filename.slice(0, 25) + '…' : b.filename}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            });
          })()
        )}
      </div>

      {/* Floating selection action bar — only when ≥ 1 books are checkbox-selected */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 flex justify-center z-10">
          <div className="flex items-center gap-2 bg-accent text-limestone rounded-full pl-5 pr-2 py-2 shadow-lg">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <span className="opacity-50">·</span>
            <button
              onClick={() =>
                runBulkRetag(Array.from(selected), `${selected.size} selected`)
              }
              disabled={retagBusy}
              className="text-xs px-3 py-1.5 rounded-full bg-brass text-accent-deep font-medium hover:bg-brass-deep hover:text-limestone transition disabled:opacity-50"
            >
              ↻ Re-tag
            </button>
            <button
              onClick={() => {
                Array.from(selected).forEach((id) =>
                  updateBook(id, { status: 'approved' })
                );
                setSelected(new Set());
              }}
              className="text-xs px-3 py-1.5 rounded-full bg-fern text-limestone hover:bg-accent-deep transition"
            >
              Approve
            </button>
            <button
              onClick={() => {
                Array.from(selected).forEach((id) =>
                  updateBook(id, { status: 'rejected' })
                );
                setSelected(new Set());
              }}
              className="text-xs px-3 py-1.5 rounded-full bg-mahogany/30 text-limestone hover:bg-mahogany transition"
            >
              Reject
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs px-2 py-1.5 rounded-full text-limestone/70 hover:text-limestone transition"
              aria-label="Clear selection"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Bottom bulk action + nav — hidden when selection bar is active */}
      {counts.pending > 0 && selected.size === 0 && (
        <div className="sticky bottom-4 flex justify-center">
          <button
            onClick={approveRemaining}
            className="text-sm px-5 py-2.5 rounded-full bg-brass text-accent-deep font-medium shadow-md hover:bg-brass-deep hover:text-limestone transition"
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
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'brass' | 'green' | 'red' | 'mahogany';
}) {
  const toneClass =
    tone === 'brass'
      ? 'text-brass-deep dark:text-brass'
      : tone === 'green'
      ? 'text-green-700 dark:text-green-400'
      : tone === 'red'
      ? 'text-red-700 dark:text-red-400'
      : tone === 'mahogany'
      ? 'text-mahogany dark:text-orange-200'
      : 'text-ink dark:text-cream-100';
  return (
    <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-xl p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-ink/50 dark:text-cream-300/50 mb-1.5">
        {label}
      </div>
      <div className={`text-3xl font-display ${toneClass}`}>{value}</div>
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
