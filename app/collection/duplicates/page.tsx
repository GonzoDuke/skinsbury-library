'use client';

/**
 * Duplicates & editions tool. Surfaces two distinct cases:
 *
 *   EXACT — multiple ledger entries sharing the same ISBN. Rare in
 *   practice because appendToLedger dedupes same-ISBN re-exports in
 *   place; surfaces the cases where dedupe was bypassed (manual JSON
 *   edits, sync race, future second-copy support).
 *
 *   EDITION — multiple entries that resolve to the same work
 *   (matching normalized title + author last name) but have different
 *   ISBNs. PB vs HC, different publishers, translations, etc.
 *
 * The tool never auto-merges. Each group offers user actions:
 *   - Mark intentional / Mark as different works → ledger-level
 *     dismissal (writes dedupe_dismissed; future detection skips).
 *   - Confirm same work → assigns a shared work_group_id and dismisses
 *     (settled) so future series tools can count "the same work" once.
 *   - Remove duplicates → destructive entry-level deletion with
 *     per-entry selection.
 *   - Keep all as-is → soft dismissal in localStorage only.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  loadLedger,
  syncLedgerFromRepo,
  detectDuplicates,
  dismissDuplicateGroup,
  confirmSameWork,
  removeLedgerEntries,
  softDismissDuplicateGroup,
  entryHandle,
  type DuplicateGroup,
  type LedgerEntry,
} from '@/lib/export-ledger';

type TabKey = 'all' | 'exact' | 'edition';

export default function DuplicatesPage() {
  const [hydrated, setHydrated] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [tab, setTab] = useState<TabKey>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Hydrate from localStorage cache, then trigger a remote sync so the
  // detection runs against the authoritative ledger.
  useEffect(() => {
    setLedger(loadLedger());
    setHydrated(true);
    void (async () => {
      const remote = await syncLedgerFromRepo();
      if (remote) setLedger(remote);
    })();
  }, []);

  const detection = useMemo(() => detectDuplicates(ledger), [ledger]);

  const counts = useMemo(() => {
    const exact = detection.groups.filter((g) => g.type === 'exact').length;
    const edition = detection.groups.filter((g) => g.type === 'edition').length;
    return { exact, edition, total: exact + edition };
  }, [detection.groups]);

  const visibleGroups = useMemo(() => {
    if (tab === 'all') return detection.groups;
    return detection.groups.filter((g) => g.type === tab);
  }, [detection.groups, tab]);

  const totalEntriesInvolved = useMemo(
    () =>
      detection.groups.reduce((s, g) => s + g.entries.length, 0),
    [detection.groups]
  );

  async function refreshLedger() {
    const next = (await syncLedgerFromRepo()) ?? loadLedger();
    setLedger(next);
  }

  async function handleAction<T>(
    label: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    if (busy) return null;
    setBusy(label);
    setErrMsg(null);
    try {
      const result = await fn();
      await refreshLedger();
      return result;
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <div className="h-10 bg-surface-card border border-line rounded-md animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <Link
          href="/collection"
          className="text-[12px] text-text-tertiary hover:text-navy hover:underline"
        >
          ← Collection
        </Link>
        <h1 className="typo-page-title mt-1">Duplicates &amp; editions</h1>
        <div className="text-[13px] text-text-secondary mt-0.5">
          {counts.total === 0 ? (
            <>No duplicate groups detected.</>
          ) : (
            <>
              {counts.total}{' '}
              {counts.total === 1 ? 'group' : 'groups'} detected ·{' '}
              {totalEntriesInvolved} total{' '}
              {totalEntriesInvolved === 1 ? 'entry' : 'entries'} involved
            </>
          )}
        </div>
      </div>

      {errMsg && (
        <div className="bg-mahogany-soft border border-mahogany/30 text-mahogany text-[13px] rounded-md px-4 py-2.5">
          {errMsg}
        </div>
      )}

      {/* Empty state */}
      {counts.total === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-line-light text-[13px]">
            <TabButton
              active={tab === 'all'}
              onClick={() => setTab('all')}
              label={`All (${counts.total})`}
            />
            <TabButton
              active={tab === 'exact'}
              onClick={() => setTab('exact')}
              label={`Exact duplicates (${counts.exact})`}
            />
            <TabButton
              active={tab === 'edition'}
              onClick={() => setTab('edition')}
              label={`Different editions (${counts.edition})`}
            />
          </div>

          {/* Group list */}
          <div className="space-y-3">
            {visibleGroups.map((group) => (
              <GroupCard
                key={`${group.type}:${group.matchKey}`}
                group={group}
                busy={busy}
                onMarkIntentional={() =>
                  handleAction('intentional', () =>
                    dismissDuplicateGroup(
                      group.entries.map(entryHandle),
                      'intentional',
                      group.matchKey
                    )
                  )
                }
                onMarkDifferentWorks={() =>
                  handleAction('different_works', () =>
                    dismissDuplicateGroup(
                      group.entries.map(entryHandle),
                      'different_works',
                      group.matchKey
                    )
                  )
                }
                onConfirmSameWork={() =>
                  handleAction('confirm_same_work', () =>
                    confirmSameWork(
                      group.entries.map(entryHandle),
                      group.matchKey
                    )
                  )
                }
                onRemoveSelected={(handles) =>
                  handleAction('remove', () => removeLedgerEntries(handles))
                }
                onKeepAsIs={() => {
                  softDismissDuplicateGroup(
                    `${group.type}:${group.matchKey}`
                  );
                  // Local-only — re-detect synchronously.
                  setLedger((current) => [...current]);
                }}
              />
            ))}
          </div>

          {detection.truncated > 0 && (
            <div className="text-center text-[12px] text-text-tertiary pt-2">
              {detection.truncated} more{' '}
              {detection.truncated === 1 ? 'group' : 'groups'} not shown —
              refine your detection threshold (coming soon).
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'px-3 py-2 -mb-px border-b-2 transition ' +
        (active
          ? 'border-navy text-navy font-medium'
          : 'border-transparent text-text-secondary hover:text-text-primary')
      }
    >
      {label}
    </button>
  );
}

function GroupCard({
  group,
  busy,
  onMarkIntentional,
  onMarkDifferentWorks,
  onConfirmSameWork,
  onRemoveSelected,
  onKeepAsIs,
}: {
  group: DuplicateGroup;
  busy: string | null;
  onMarkIntentional: () => Promise<unknown>;
  onMarkDifferentWorks: () => Promise<unknown>;
  onConfirmSameWork: () => Promise<unknown>;
  onRemoveSelected: (handles: ReturnType<typeof entryHandle>[]) => Promise<unknown>;
  onKeepAsIs: () => void;
}) {
  const [removeMode, setRemoveMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const isExact = group.type === 'exact';
  const first = group.entries[0];
  const cover = first?.isbn
    ? `https://covers.openlibrary.org/b/isbn/${first.isbn}-S.jpg?default=false`
    : '';

  // Display info: exact uses the shared identifying record; edition
  // uses the work-level title+author (any entry will do — they all
  // resolve to the same normalized work).
  const displayTitle = first?.title ?? first?.titleNorm ?? '(untitled)';
  const displayAuthor = first?.author ?? first?.authorLF ?? first?.authorNorm ?? '';

  function toggleSelected(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleType() {
    return isExact
      ? `${group.entries.length} copies of the same edition`
      : `${group.entries.length} editions of the same work`;
  }

  async function confirmRemove() {
    const handles = group.entries
      .filter((e) => selected.has(entryKey(e)))
      .map(entryHandle);
    if (handles.length === 0) return;
    if (handles.length === group.entries.length) {
      const confirmed =
        typeof window !== 'undefined' &&
        window.confirm(
          'You\'ve selected every entry in this group. Removing them all will erase the entire ledger record for this book/work. Continue?'
        );
      if (!confirmed) return;
    }
    await onRemoveSelected(handles);
    setRemoveMode(false);
    setSelected(new Set());
  }

  return (
    <section className="bg-surface-card border border-line rounded-lg p-4">
      <div className="flex items-start gap-3">
        <div className="w-12 h-16 flex-shrink-0 bg-surface-page rounded overflow-hidden">
          {cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary">
            {handleType()}
          </div>
          <div className="text-[15px] font-medium text-text-primary mt-0.5 truncate">
            {displayTitle}
          </div>
          <div className="text-[12px] text-text-secondary truncate">
            {displayAuthor}
            {isExact && first?.isbn ? ` · ISBN ${first.isbn}` : ''}
          </div>
        </div>
      </div>

      {/* Per-entry list */}
      <ul className="mt-3 divide-y divide-line-light border-t border-line-light">
        {group.entries.map((e) => {
          const key = entryKey(e);
          const checked = selected.has(key);
          return (
            <li
              key={key}
              className="py-2 flex items-center gap-3 text-[12px]"
            >
              {removeMode && (
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSelected(key)}
                  aria-label={`Select entry from ${e.batchLabel ?? 'unlabeled batch'} on ${e.date}`}
                  className="flex-shrink-0"
                />
              )}
              {!isExact && e.isbn && (
                <span className="font-mono text-[11px] text-text-tertiary flex-shrink-0">
                  {e.isbn}
                </span>
              )}
              <span className="flex-1 min-w-0 truncate text-text-secondary">
                {!isExact && e.publisher ? `${e.publisher}` : ''}
                {!isExact && e.publisher && e.publicationYear ? ' · ' : ''}
                {!isExact && e.publicationYear ? `${e.publicationYear}` : ''}
                {(!isExact && (e.publisher || e.publicationYear)) ? ' · ' : ''}
                {e.batchLabel ? e.batchLabel : <em>unlabeled batch</em>}
                {' · '}
                <span className="font-mono text-[11px] text-text-tertiary">
                  {e.date}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {/* Actions */}
      {!removeMode ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {isExact ? (
            <ActionButton
              variant="primary"
              onClick={onMarkIntentional}
              disabled={!!busy}
            >
              Mark intentional
            </ActionButton>
          ) : (
            <>
              <ActionButton
                variant="primary"
                onClick={onConfirmSameWork}
                disabled={!!busy}
              >
                Confirm same work
              </ActionButton>
              <ActionButton
                variant="secondary"
                onClick={onMarkDifferentWorks}
                disabled={!!busy}
              >
                Mark as different works
              </ActionButton>
            </>
          )}
          <ActionButton
            variant="secondary"
            onClick={() => setRemoveMode(true)}
            disabled={!!busy}
          >
            Remove duplicates
          </ActionButton>
          <ActionButton
            variant="ghost"
            onClick={onKeepAsIs}
            disabled={!!busy}
          >
            Keep all as-is
          </ActionButton>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span className="text-[12px] text-text-secondary mr-auto">
            Select entries to remove · {selected.size} of{' '}
            {group.entries.length} selected
          </span>
          <ActionButton
            variant="danger"
            onClick={() => void confirmRemove()}
            disabled={!!busy || selected.size === 0}
          >
            {busy === 'remove' ? 'Removing…' : `Remove ${selected.size}`}
          </ActionButton>
          <ActionButton
            variant="ghost"
            onClick={() => {
              setRemoveMode(false);
              setSelected(new Set());
            }}
            disabled={!!busy}
          >
            Cancel
          </ActionButton>
        </div>
      )}
    </section>
  );
}

function entryKey(e: LedgerEntry): string {
  return `${e.isbn}|${e.titleNorm}|${e.authorNorm}|${e.date}|${e.batchLabel ?? ''}`;
}

function ActionButton({
  variant,
  children,
  onClick,
  disabled,
}: {
  variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const base =
    'px-3 py-1.5 text-[12px] rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed';
  const cls =
    variant === 'primary'
      ? 'bg-navy text-white hover:bg-navy-deep font-medium'
      : variant === 'secondary'
        ? 'bg-surface-page border border-line text-text-secondary hover:bg-surface-card'
        : variant === 'danger'
          ? 'bg-mahogany text-white hover:bg-mahogany/90 font-medium'
          : 'text-text-tertiary hover:text-text-primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${cls}`}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="bg-surface-card border border-line rounded-lg p-6 text-center">
      <div className="text-text-secondary text-[14px]">
        No duplicates or multi-edition works detected. Your library is
        well-deduplicated.
      </div>
      <details className="mt-4 text-left max-w-md mx-auto">
        <summary className="text-[12px] text-text-tertiary cursor-pointer hover:text-text-primary">
          How this works
        </summary>
        <div className="text-[12px] text-text-tertiary mt-2 leading-relaxed">
          The tool checks two things:
          <ol className="list-decimal pl-5 mt-1 space-y-1">
            <li>
              <strong>Exact duplicates</strong>: multiple ledger entries
              sharing the same ISBN. The export pipeline normally
              deduplicates these in place, so they show up only when
              dedupe was bypassed (e.g. manual JSON edits, sync races).
            </li>
            <li>
              <strong>Different editions</strong>: multiple entries with
              different ISBNs that resolve to the same work — same
              normalized title and author last name. Subtitles and
              leading articles ("The", "A") are stripped before
              matching.
            </li>
          </ol>
        </div>
      </details>
      <div className="mt-4">
        <Link
          href="/collection"
          className="inline-block px-4 py-2 rounded-md bg-surface-page border border-line text-text-secondary hover:bg-surface-card transition text-[12px]"
        >
          ← Back to Collection
        </Link>
      </div>
    </div>
  );
}
