'use client';

/**
 * Stacks — the new library landing page.
 *
 * Replaces Upload as the default route. Reframes Carnegie from "tool I
 * open to do work" to "place that knows my library." Reads from the
 * existing export ledger + active in-progress batches; no new data
 * infrastructure.
 *
 * Sections (top → bottom):
 *   1. Header: title + summary line + Refresh-from-cloud button
 *   2. Search bar (library-wide, ⌘K focuses, fuzzy match)
 *   3. Unclassified-books banner (when any books default to general_works)
 *   4. Collection Overview (counts, distribution-by-domain bar + legend)
 *   5. Cataloging tools (Authority check / Duplicates & editions / Series)
 *   6. Resume cataloging callout (only when there's pending review work)
 *
 * Search live-replaces the dashboard view while a query is active.
 */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import {
  loadLedger,
  syncLedgerFromRepo,
  type LedgerEntry,
} from '@/lib/export-ledger';
import {
  syncPendingBatchesFromRepo,
} from '@/lib/pending-batches';
import { VOCAB, domainForLcc, type DomainKey } from '@/lib/tag-domains';

// Domain accent colors mirror tailwind.config.ts. Inlined here as hex
// because Tailwind's purge can't see dynamic class names like
// `bg-${domain}-fg`. The bar + legend swatches use these directly via
// `style={{ background }}`.
const DOMAIN_COLOR: Record<DomainKey, string> = {
  general_works: '#5C5C5C',
  philosophy_psychology_religion: '#4547A9',
  auxiliary_history: '#6B4D2E',
  world_history: '#8B3A1D',
  american_history: '#A03517',
  local_american_history: '#8A4F38',
  geography_recreation: '#44663B',
  social_sciences: '#3A6B1A',
  political_science: '#294E18',
  law: '#3A4A6B',
  education: '#8C6A1A',
  music: '#A33D5E',
  fine_arts: '#B05030',
  language_literature: '#2A5F9E',
  science: '#1F4F87',
  medicine: '#2D6E60',
  agriculture: '#4F5C24',
  technology: '#4A4840',
  military_science: '#6F6427',
  naval_science: '#2D4A6B',
  books_libraries: '#6B5E3D',
};

interface DashboardStats {
  totalBooks: number;
  uniqueWorks: number;
  domainsPopulated: number;
  perDomain: { domain: DomainKey; label: string; count: number }[];
  unclassifiedCount: number;
  batchCount: number;
  lastActivity: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return 'never';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function computeStats(entries: LedgerEntry[]): DashboardStats {
  const totalBooks = entries.length;
  const uniqueKeys = new Set<string>();
  for (const e of entries) {
    if (e.isbn) uniqueKeys.add(`isbn:${e.isbn}`);
    else uniqueKeys.add(`ta:${e.titleNorm}|${e.authorNorm}`);
  }
  const uniqueWorks = uniqueKeys.size;

  // Per-domain count via current LCC → domain matcher (the 21-class
  // taxonomy). Books with no LCC fall to general_works (A) — those
  // are the "unclassified" pool.
  const counts = new Map<DomainKey, number>();
  let unclassifiedCount = 0;
  for (const e of entries) {
    const d = domainForLcc(e.lcc);
    counts.set(d, (counts.get(d) ?? 0) + 1);
    if (!e.lcc || e.lcc.trim() === '') unclassifiedCount += 1;
  }

  const perDomain = (Object.keys(VOCAB.domains) as DomainKey[])
    .map((domain) => ({
      domain,
      label: VOCAB.domains[domain].label,
      count: counts.get(domain) ?? 0,
    }))
    .sort((a, b) => b.count - a.count);

  const batchSet = new Set<string | undefined>();
  for (const e of entries) batchSet.add(e.batchLabel);
  const batchCount = batchSet.size;

  const lastActivity = entries.reduce<string | null>((acc, e) => {
    if (!acc) return e.date;
    return e.date > acc ? e.date : acc;
  }, null);

  return {
    totalBooks,
    uniqueWorks,
    domainsPopulated: perDomain.filter((d) => d.count > 0).length,
    perDomain,
    unclassifiedCount,
    batchCount,
    lastActivity,
  };
}

interface SearchHit {
  entry: LedgerEntry;
  score: number;
}

function searchLedger(entries: LedgerEntry[], q: string): SearchHit[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const tokens = query.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const e of entries) {
    const haystack = [
      e.title ?? '',
      e.author ?? '',
      e.authorLF ?? '',
      e.publisher ?? '',
      e.batchLabel ?? '',
      e.isbn,
      ...(e.tags ?? []),
    ]
      .join(' ')
      .toLowerCase();
    let score = 0;
    let allMatch = true;
    for (const tok of tokens) {
      if (!haystack.includes(tok)) {
        allMatch = false;
        break;
      }
      score += 1;
      if ((e.title ?? '').toLowerCase().startsWith(tok)) score += 3;
      if ((e.isbn ?? '').toLowerCase().startsWith(tok)) score += 5;
    }
    if (!allMatch) continue;
    hits.push({ entry: e, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 50);
}

export default function StacksPage() {
  const { state } = useStore();
  const [hydrated, setHydrated] = useState(false);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Hydrate on mount — reads localStorage cache, then triggers a
  // background sync from GitHub. The dashboard re-renders when the
  // sync completes.
  useEffect(() => {
    const initial = loadLedger();
    setLedger(initial);
    setStats(computeStats(initial));
    setHydrated(true);
  }, []);

  // Debounce the search query so each keystroke doesn't re-render.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  // ⌘K / Ctrl+K focuses the search input from anywhere on the page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMacShortcut = e.metaKey && e.key === 'k';
      const isWinShortcut = e.ctrlKey && e.key === 'k';
      if (isMacShortcut || isWinShortcut) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function refreshFromCloud() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const [remoteLedger] = await Promise.all([
        syncLedgerFromRepo(),
        syncPendingBatchesFromRepo(),
      ]);
      const next = remoteLedger ?? loadLedger();
      setLedger(next);
      setStats(computeStats(next));
      setRefreshMsg(remoteLedger ? 'Synced.' : 'Sync unavailable.');
    } catch {
      setRefreshMsg('Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }

  // Search hits — recomputed when ledger or debounced query change.
  const searchHits = useMemo(
    () => searchLedger(ledger, debouncedQuery),
    [ledger, debouncedQuery]
  );

  // Active-batch detection: any batch in the live store with at least
  // one pending book is the "resume cataloging" target.
  const pendingBatch = useMemo(() => {
    for (const b of state.batches) {
      const pending = b.books.filter((bk) => bk.status === 'pending').length;
      if (pending > 0) return { batch: b, pending };
    }
    return null;
  }, [state.batches]);

  // Pre-mount placeholder — avoids a flash of "0 books" while
  // localStorage hydrates on the first frame.
  if (!hydrated || !stats) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-surface-card border border-line rounded-md animate-pulse" />
      </div>
    );
  }

  // Empty-library shortcut. Skip the whole dashboard; show the friendly
  // first-run state instead.
  if (stats.totalBooks === 0 && !pendingBatch && !debouncedQuery) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <h1 className="typo-page-title">Stacks</h1>
        <p className="text-text-secondary mt-3 mb-8 leading-relaxed">
          Your library is empty. Catalog your first shelf to get started.
        </p>
        <Link
          href="/upload"
          className="inline-block px-5 py-2.5 rounded-md bg-navy text-white hover:bg-navy-deep transition font-medium"
        >
          Start cataloging →
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="typo-page-title">Stacks</h1>
          <div className="text-[13px] text-text-secondary mt-0.5">
            {stats.totalBooks.toLocaleString()}{' '}
            {stats.totalBooks === 1 ? 'book' : 'books'} cataloged ·{' '}
            {stats.batchCount}{' '}
            {stats.batchCount === 1 ? 'batch' : 'batches'} exported · last
            activity {timeAgo(stats.lastActivity)}
          </div>
        </div>
        <button
          type="button"
          onClick={refreshFromCloud}
          disabled={refreshing}
          className="text-[12px] px-3.5 py-1.5 rounded-md bg-surface-card border border-line text-navy hover:bg-surface-page transition disabled:opacity-50"
          title="Pull the latest ledger + pending batches from the cloud."
        >
          {refreshing ? '⟳ Refreshing…' : '↻ Refresh from cloud'}
        </button>
      </div>
      {refreshMsg && (
        <div className="text-[12px] text-text-tertiary -mt-3">{refreshMsg}</div>
      )}

      {/* Search bar — full width, monospace ⌘K hint, library-wide. */}
      <div className="relative">
        <div className="bg-surface-card border border-line-light rounded-lg px-4 py-2 flex items-center gap-2.5">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-text-tertiary flex-shrink-0"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, author, ISBN, or tag — across your entire library"
            className="flex-1 bg-transparent border-none outline-none text-[14px] py-1.5 text-text-primary placeholder:text-text-tertiary"
            aria-label="Search the library"
          />
          <kbd className="hidden sm:inline-block text-[11px] font-mono text-text-tertiary bg-surface-page border border-line-light px-1.5 py-0.5 rounded">
            ⌘K
          </kbd>
        </div>
      </div>

      {/* Search results — replace the dashboard view while a query is active. */}
      {debouncedQuery ? (
        <SearchResults hits={searchHits} query={debouncedQuery} />
      ) : (
        <>
          {stats.unclassifiedCount > 0 && (
            <div className="bg-navy-soft border border-navy/20 rounded-md px-4 py-2.5 text-[13px] text-navy">
              {stats.unclassifiedCount}{' '}
              {stats.unclassifiedCount === 1 ? 'book needs' : 'books need'}{' '}
              classification — review on the{' '}
              <Link href="/review" className="underline font-medium">
                Review page
              </Link>{' '}
              and add an LCC to file them properly.
            </div>
          )}

          <CollectionOverview stats={stats} />

          <div className="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary mt-6 mb-2">
            Cataloging tools
          </div>
          <ToolsRow ledger={ledger} />

          {pendingBatch && (
            <div className="bg-surface-card border border-line rounded-lg px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="font-medium text-text-primary">Resume cataloging</div>
                <div className="text-[13px] text-text-secondary mt-0.5">
                  {pendingBatch.pending}{' '}
                  {pendingBatch.pending === 1 ? 'book' : 'books'} pending
                  review from your last batch
                  {pendingBatch.batch.batchLabel
                    ? ` · ${pendingBatch.batch.batchLabel}`
                    : ''}
                </div>
              </div>
              <Link
                href="/review"
                className="px-4 py-2 rounded-md bg-navy text-white hover:bg-navy-deep transition text-[13px] font-medium whitespace-nowrap"
              >
                Continue to Review →
              </Link>
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

function CollectionOverview({ stats }: { stats: DashboardStats }) {
  const populated = stats.perDomain.filter((d) => d.count > 0);
  const totalForBar = populated.reduce((s, d) => s + d.count, 0) || 1;

  return (
    <section className="bg-surface-card border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-4">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary">
          Collection overview
        </div>
        <Link href="/vocabulary" className="text-[11px] text-navy hover:underline">
          View all →
        </Link>
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-3 mb-5">
        <Stat label="Total books" value={stats.totalBooks} />
        <Stat label="Unique works" value={stats.uniqueWorks} />
        <Stat label="Domains populated" value={`${stats.domainsPopulated} / 21`} />
      </div>

      {populated.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-text-tertiary mb-1.5">
            Distribution by domain
          </div>
          {/* Stacked bar — each populated domain gets a flex-grow segment
              proportional to its count. Empty domains are omitted from
              the bar (they'd render zero-width); the legend below picks
              them up if the user cares. */}
          <div className="flex h-2 rounded overflow-hidden mb-3 bg-surface-page">
            {populated.map((d) => (
              <div
                key={d.domain}
                style={{
                  background: DOMAIN_COLOR[d.domain],
                  flexGrow: d.count,
                  flexBasis: 0,
                  minWidth: 1,
                }}
                title={`${d.label} — ${d.count}`}
                aria-label={`${d.label}: ${d.count} books, ${Math.round((d.count / totalForBar) * 100)}%`}
              />
            ))}
          </div>
          {/* Legend — populated domains in count-descending order. */}
          <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[12px]">
            {populated.map((d) => (
              <span key={d.domain} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block w-2.5 h-2.5 rounded-sm"
                  style={{ background: DOMAIN_COLOR[d.domain] }}
                />
                <span className="text-text-secondary">{d.label}</span>
                <span className="font-mono text-[11px] text-text-tertiary">
                  {d.count}
                </span>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[26px] font-medium text-text-primary leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary mt-1.5">
        {label}
      </div>
    </div>
  );
}

// Author-similarity for the Authority-check count: cluster ledger
// entries on lastname-only and flag clusters where ≥2 distinct
// first-name spellings co-exist (e.g. "Solnit, R." vs "Solnit,
// Rebecca"). Cheap heuristic that matches the spec's example exactly.
function countAuthorityConflicts(entries: LedgerEntry[]): number {
  const byLastname = new Map<string, Set<string>>();
  for (const e of entries) {
    const lf = e.authorLF ?? e.author ?? '';
    const trimmed = lf.trim();
    if (!trimmed) continue;
    const [last, rest] = trimmed.includes(',')
      ? trimmed.split(',', 2)
      : [trimmed.split(' ').slice(-1)[0], trimmed.split(' ').slice(0, -1).join(' ')];
    const lastKey = last.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (!lastKey) continue;
    const firstKey = (rest ?? '').toLowerCase().replace(/[^a-z]/g, '');
    if (!firstKey) continue;
    if (!byLastname.has(lastKey)) byLastname.set(lastKey, new Set());
    byLastname.get(lastKey)!.add(firstKey);
  }
  let conflicts = 0;
  for (const firstNames of byLastname.values()) {
    if (firstNames.size < 2) continue;
    // Conflict only when two first-given names share a prefix — "R." vs
    // "Rebecca" is a conflict; "John" vs "Jane" is two different
    // people. Heuristic: any two entries where one is a prefix of the
    // other counts as one conflict.
    const arr = Array.from(firstNames);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[i].startsWith(arr[j]) || arr[j].startsWith(arr[i])) {
          conflicts += 1;
          break;
        }
      }
    }
  }
  return conflicts;
}

// Duplicates by ISBN, then by normalized title+author. A "duplicate
// work" is any cluster of ≥2 ledger entries that resolve to the same
// book.
function countDuplicateWorks(entries: LedgerEntry[]): number {
  const seen = new Map<string, number>();
  for (const e of entries) {
    const key = e.isbn ? `isbn:${e.isbn}` : `ta:${e.titleNorm}|${e.authorNorm}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let count = 0;
  for (const v of seen.values()) if (v > 1) count += 1;
  return count;
}

function ToolsRow({ ledger }: { ledger: LedgerEntry[] }) {
  const authorityCount = useMemo(() => countAuthorityConflicts(ledger), [ledger]);
  const duplicatesCount = useMemo(() => countDuplicateWorks(ledger), [ledger]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <ToolCard
        href="/stacks/authority"
        title="Authority check"
        body='Inconsistent author names across your library. "Solnit, R." vs "Solnit, Rebecca" — merge or keep separate.'
        badge={
          authorityCount === 0
            ? { text: 'All clear', tone: 'green' }
            : {
                text: `${authorityCount} to review`,
                tone: 'amber',
              }
        }
      />
      <ToolCard
        href="/stacks/duplicates"
        title="Duplicates & editions"
        body="Multiple copies or editions of the same work."
        badge={
          duplicatesCount === 0
            ? { text: 'All clear', tone: 'green' }
            : {
                text: `${duplicatesCount} ${duplicatesCount === 1 ? 'work' : 'works'}`,
                tone: 'green',
              }
        }
      />
      <ToolCard
        href="/stacks/series"
        title="Series tracking"
        body="Gaps in series you collect."
        badge={{ text: '—', tone: 'muted', tooltip: 'Coming soon' }}
      />
    </div>
  );
}

interface ToolBadge {
  text: string;
  tone: 'green' | 'amber' | 'red' | 'muted';
  tooltip?: string;
}

function ToolCard({
  href,
  title,
  body,
  badge,
}: {
  href: string;
  title: string;
  body: string;
  badge: ToolBadge;
}) {
  const toneClass =
    badge.tone === 'green'
      ? 'bg-carnegie-green-soft text-carnegie-green'
      : badge.tone === 'amber'
        ? 'bg-carnegie-amber-soft text-carnegie-amber'
        : badge.tone === 'red'
          ? 'bg-carnegie-red-soft text-carnegie-red'
          : 'bg-surface-page text-text-tertiary';
  return (
    <Link
      href={href}
      className="block bg-surface-card border border-line rounded-lg p-4 hover:border-navy transition"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="text-[14px] font-medium text-text-primary">{title}</div>
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${toneClass}`}
          title={badge.tooltip}
        >
          {badge.text}
        </span>
      </div>
      <div className="text-[12px] text-text-secondary leading-relaxed">{body}</div>
    </Link>
  );
}

function SearchResults({ hits, query }: { hits: SearchHit[]; query: string }) {
  if (hits.length === 0) {
    return (
      <div className="bg-surface-card border border-line rounded-lg p-6 text-center">
        <div className="text-text-secondary text-[14px]">
          No books match <span className="font-mono">{`"${query}"`}</span>.
        </div>
        <div className="text-text-tertiary text-[12px] mt-2">
          Try a different term, or click <span className="font-mono">↻ Refresh from cloud</span>{' '}
          if you've added books on another device.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
        {hits.length} {hits.length === 1 ? 'result' : 'results'}
      </div>
      {hits.map((h) => (
        <SearchResultRow key={`${h.entry.isbn}-${h.entry.titleNorm}`} entry={h.entry} />
      ))}
    </div>
  );
}

function SearchResultRow({ entry }: { entry: LedgerEntry }) {
  const cover = entry.isbn
    ? `https://covers.openlibrary.org/b/isbn/${entry.isbn}-S.jpg?default=false`
    : '';
  return (
    <div className="bg-surface-card border border-line rounded-md px-3 py-2.5 flex items-center gap-3">
      <div className="w-10 h-14 flex-shrink-0 bg-surface-page rounded overflow-hidden">
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
        <div className="text-[14px] font-medium text-text-primary truncate">
          {entry.title ?? entry.titleNorm}
        </div>
        <div className="text-[12px] text-text-secondary truncate">
          {entry.author ?? entry.authorNorm}
          {entry.publicationYear ? ` · ${entry.publicationYear}` : ''}
          {entry.batchLabel ? ` · ${entry.batchLabel}` : ''}
        </div>
      </div>
      {entry.isbn && (
        <div className="text-[11px] font-mono text-text-tertiary flex-shrink-0 hidden sm:block">
          {entry.isbn}
        </div>
      )}
    </div>
  );
}
