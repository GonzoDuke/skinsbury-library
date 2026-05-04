'use client';

/**
 * Collection — the library tools page.
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
  detectDuplicates,
  detectAuthorityIssues,
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

export default function CollectionPage() {
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
        <h1 className="typo-page-title">Collection</h1>
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
          <h1 className="typo-page-title">Collection</h1>
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

          <div className="typo-section-label mt-6 mb-2">Cataloging tools</div>
          <ToolsRow ledger={ledger} />

          <RecentActivityPanel ledger={ledger} />

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

  // For the all-21-domains grid we want canonical taxonomy order (the
  // VOCAB key order) so the layout is stable even as counts shift between
  // syncs. perDomain is sorted by count desc — fine for the bar, less
  // useful for the grid where the user expects the same domain in the
  // same slot every visit.
  const allDomainsOrdered = (Object.keys(VOCAB.domains) as DomainKey[]).map(
    (domain) => ({
      domain,
      label: VOCAB.domains[domain].label,
      count: stats.perDomain.find((d) => d.domain === domain)?.count ?? 0,
    })
  );

  return (
    <section className="bg-surface-card border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-4">
        <div className="typo-section-label">Collection overview</div>
        <Link href="/vocabulary" className="text-[12px] text-navy hover:underline">
          View vocabulary →
        </Link>
      </div>

      <div className="flex flex-wrap gap-x-10 gap-y-3 mb-6">
        <Stat label="Total books" value={stats.totalBooks} />
        <Stat label="Unique works" value={stats.uniqueWorks} />
        <Stat label="Domains populated" value={`${stats.domainsPopulated} / 21`} />
      </div>

      {populated.length > 0 && (
        <>
          <div className="typo-stat-label mb-2">Distribution by domain</div>
          {/* Stacked bar — each populated domain gets a flex-grow segment
              proportional to its count. Empty domains are omitted from
              the bar (they'd render zero-width). Bumped from 8px to 22px
              so the bar reads as a substantive distribution view rather
              than a hairline accent. */}
          <div className="flex h-[22px] rounded-md overflow-hidden mb-5 bg-surface-page border border-line-light">
            {populated.map((d) => (
              <div
                key={d.domain}
                style={{
                  background: DOMAIN_COLOR[d.domain],
                  flexGrow: d.count,
                  flexBasis: 0,
                  minWidth: 2,
                }}
                title={`${d.label} — ${d.count} (${Math.round((d.count / totalForBar) * 100)}%)`}
                aria-label={`${d.label}: ${d.count} books, ${Math.round((d.count / totalForBar) * 100)}%`}
              />
            ))}
          </div>

          {/* Full 21-domain grid. Replaces the count-ordered legend with
              taxonomy-ordered cards — populated domains visually loud,
              empty domains muted with an em-dash so the user sees the
              shape of their library against the LCC universe at a glance.
              3 columns on desktop, 2 on tablet, 1 on mobile. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {allDomainsOrdered.map((d) => (
              <DomainCard key={d.domain} domain={d.domain} label={d.label} count={d.count} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function DomainCard({
  domain,
  label,
  count,
}: {
  domain: DomainKey;
  label: string;
  count: number;
}) {
  const empty = count === 0;
  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2 rounded-md border ${
        empty
          ? 'border-line-light bg-surface-page/50 opacity-60'
          : 'border-line bg-surface-card'
      }`}
    >
      <span
        aria-hidden
        className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
        style={{ background: DOMAIN_COLOR[domain] }}
      />
      <span className="flex-1 min-w-0 truncate text-[13px] text-text-secondary">
        {label}
      </span>
      <span
        className={`font-mono text-[12px] ${empty ? 'text-text-quaternary' : 'text-text-primary font-medium'}`}
      >
        {empty ? '—' : count}
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="typo-stat-number">{value}</div>
      <div className="typo-stat-label mt-1.5">{label}</div>
    </div>
  );
}

function ToolsRow({ ledger }: { ledger: LedgerEntry[] }) {
  const authorityGroups = useMemo(
    () => detectAuthorityIssues(ledger).groups.length,
    [ledger]
  );
  const duplicateGroups = useMemo(
    () => detectDuplicates(ledger).groups.length,
    [ledger]
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <ToolCard
        href="/collection/authority"
        title="Authority check"
        body='Inconsistent author names across your library. "Solnit, R." vs "Solnit, Rebecca" — merge or keep separate.'
        badge={
          authorityGroups === 0
            ? { text: 'All clear', tone: 'green' }
            : {
                text: `${authorityGroups} ${authorityGroups === 1 ? 'group' : 'groups'}`,
                tone: 'amber',
              }
        }
      />
      <ToolCard
        href="/collection/duplicates"
        title="Duplicates & editions"
        body="Multiple copies or editions of the same work."
        badge={
          duplicateGroups === 0
            ? { text: 'All clear', tone: 'green' }
            : {
                text: `${duplicateGroups} ${duplicateGroups === 1 ? 'group' : 'groups'}`,
                tone: 'amber',
              }
        }
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

// ---------------------------------------------------------------------------
// Recent activity — fills the dead space below the tool cards on the
// dashboard with the last N books cataloged across all batches. Each row
// links to /review so the user can pick up where they left off; that route
// already lists every book in the active session, so the click target is
// "go look at what I've been working on" rather than scroll-into-view.
// ---------------------------------------------------------------------------

function RecentActivityPanel({ ledger }: { ledger: LedgerEntry[] }) {
  // Sort by date descending. Ties on date (multiple books exported the
  // same day) tiebreak alphabetically on title for stable order across
  // re-renders.
  const recent = useMemo(() => {
    const sorted = [...ledger].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const at = a.title ?? a.titleNorm;
      const bt = b.title ?? b.titleNorm;
      return at.localeCompare(bt);
    });
    return sorted.slice(0, 10);
  }, [ledger]);

  if (recent.length === 0) return null;

  return (
    <section className="bg-surface-card border border-line rounded-lg p-5 mt-3">
      <div className="flex items-baseline justify-between mb-3">
        <div className="typo-section-label">Recent activity</div>
        <Link href="/history" className="text-[12px] text-navy hover:underline">
          View history →
        </Link>
      </div>
      <ul className="divide-y divide-line-light">
        {recent.map((e) => (
          <li key={`${e.isbn || 'noisbn'}-${e.titleNorm}-${e.date}-${e.batchLabel ?? ''}`}>
            <RecentActivityRow entry={e} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentActivityRow({ entry }: { entry: LedgerEntry }) {
  const cover = entry.isbn
    ? `https://covers.openlibrary.org/b/isbn/${entry.isbn}-S.jpg?default=false`
    : '';
  return (
    <Link
      href="/review"
      className="flex items-center gap-3 py-2.5 hover:bg-surface-page/60 transition rounded-md -mx-2 px-2"
    >
      <div className="w-[36px] h-[50px] flex-shrink-0 bg-surface-page rounded overflow-hidden">
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
          {entry.batchLabel ? ` · ${entry.batchLabel}` : ''}
        </div>
      </div>
      <div className="text-[12px] text-text-tertiary flex-shrink-0 hidden sm:block">
        {timeAgo(entry.date)}
      </div>
    </Link>
  );
}
