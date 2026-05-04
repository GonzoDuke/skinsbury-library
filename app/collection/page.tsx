'use client';

/**
 * Collection — Carnegie's library homepage. Renamed from "Stacks" with
 * a structural redesign: a navy hero band at the top with the wordmark,
 * an editorial italic quote, and a row of cover thumbnails fanned along
 * the bottom edge. The dashboard sits in an asymmetric two-column body
 * below the hero (1.85fr / 1fr). Search results take over the body when
 * a query is active.
 *
 * The page is rendered inside AppShell's main column, which applies its
 * own px-4/8/12 + py-4/10 padding. The hero and body break out of that
 * padding via negative margins so the navy band reads as a full-bleed
 * top of the main column. The page body's pure-white surface (vs the
 * page's off-white default) creates the visual separation the design
 * wants between hero and content.
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
import { syncPendingBatchesFromRepo } from '@/lib/pending-batches';
import { VOCAB, domainForLcc, type DomainKey } from '@/lib/tag-domains';

const NAVY = '#1B3A5C';
const GOLD = '#C4A35A';

// Domain accent colors mirror tailwind.config.ts. Inlined as hex because
// Tailwind purge can't see dynamic class names like `bg-${domain}-fg`.
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

  useEffect(() => {
    const initial = loadLedger();
    setLedger(initial);
    setStats(computeStats(initial));
    setHydrated(true);
  }, []);

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

  const searchHits = useMemo(
    () => searchLedger(ledger, debouncedQuery),
    [ledger, debouncedQuery]
  );

  // Active-batch detection — any in-flight batch with at least one
  // pending book becomes the "resume cataloging" target at the bottom.
  const pendingBatch = useMemo(() => {
    for (const b of state.batches) {
      const pending = b.books.filter((bk) => bk.status === 'pending').length;
      if (pending > 0) return { batch: b, pending };
    }
    return null;
  }, [state.batches]);

  // Cover thumbnails for the hero's bottom edge — pull the most recent
  // entries with ISBNs. If we can't reach 12, we backfill with domain-
  // colored placeholders so the row still reads as a "cover stack" on
  // a fresh-install ledger.
  const heroCovers = useMemo(() => buildHeroCovers(ledger), [ledger]);

  if (!hydrated || !stats) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-surface-card border border-line rounded-md animate-pulse" />
      </div>
    );
  }

  const isEmptyLedger =
    stats.totalBooks === 0 && !pendingBatch && !debouncedQuery;

  return (
    // Negative margins defeat AppShell's px-4/8/12 + py-4/10 padding so
    // the navy hero and white body stretch edge-to-edge of the main
    // column.
    <div className="-mx-4 md:-mx-8 lg:-mx-12 -mt-4 md:-mt-10 -mb-4 md:-mb-0">
      <Hero
        lastActivity={stats.lastActivity}
        refreshFromCloud={refreshFromCloud}
        refreshing={refreshing}
        refreshMsg={refreshMsg}
        query={query}
        setQuery={setQuery}
        searchInputRef={searchInputRef}
        covers={heroCovers}
      />

      <div className="bg-surface-card">
        <div className="px-6 sm:px-8 md:px-11 py-7 md:py-9">
          {debouncedQuery ? (
            <SearchResults hits={searchHits} query={debouncedQuery} />
          ) : isEmptyLedger ? (
            <EmptyLibraryState />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[1.85fr_1fr] gap-7">
              <CollectionOverview stats={stats} />
              <RightColumn ledger={ledger} />
            </div>
          )}

          {pendingBatch && !debouncedQuery && (
            <div className="mt-7 bg-surface-card border border-line rounded-lg px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
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
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero band
// ---------------------------------------------------------------------------

interface HeroProps {
  lastActivity: string | null;
  refreshFromCloud: () => Promise<void> | void;
  refreshing: boolean;
  refreshMsg: string | null;
  query: string;
  setQuery: (v: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  covers: HeroCover[];
}

function Hero({
  lastActivity,
  refreshFromCloud,
  refreshing,
  refreshMsg,
  query,
  setQuery,
  searchInputRef,
  covers,
}: HeroProps) {
  return (
    <section
      className="relative overflow-hidden"
      style={{ background: NAVY, minHeight: 320 }}
    >
      {/* Top-right utility cluster — refresh button + last-activity. */}
      <div className="absolute top-5 right-5 sm:top-6 sm:right-7 flex flex-col items-end gap-1.5 z-10">
        <button
          type="button"
          onClick={refreshFromCloud}
          disabled={refreshing}
          className="text-[12px] font-medium px-3 py-1.5 rounded-md transition disabled:opacity-50"
          style={{
            color: 'rgba(255,255,255,0.85)',
            background: 'rgba(255,255,255,0.10)',
            border: '1px solid rgba(255,255,255,0.20)',
          }}
          title="Pull the latest ledger + pending batches from the cloud."
        >
          {refreshing ? '⟳ Refreshing…' : '↻ Refresh from cloud'}
        </button>
        <span
          className="text-[11px]"
          style={{ color: 'rgba(255,255,255,0.55)' }}
        >
          {refreshMsg ?? `last activity ${timeAgo(lastActivity)}`}
        </span>
      </div>

      {/* Left-aligned content block */}
      <div className="relative pt-9 sm:pt-11 pb-[110px] sm:pb-[120px] px-6 sm:px-8 md:px-11">
        <div
          className="uppercase mb-2.5"
          style={{
            color: GOLD,
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '2px',
          }}
        >
          Your library
        </div>
        <h1
          style={{
            color: '#FFFFFF',
            fontSize: 'clamp(40px, 8vw, 56px)',
            fontWeight: 500,
            letterSpacing: '-1px',
            lineHeight: 0.95,
            margin: 0,
          }}
        >
          Collection
        </h1>
        <p
          className="hidden sm:block"
          style={{
            color: 'rgba(255,255,255,0.7)',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontStyle: 'italic',
            fontSize: 16,
            maxWidth: 520,
            marginTop: 16,
            lineHeight: 1.5,
          }}
        >
          “Every library is a kind of autobiography.”
        </p>

        {/* Search bar — same logic as before, white-on-translucent. */}
        <div
          className="mt-5 sm:mt-6 flex items-center gap-2.5 px-4 py-2 rounded-lg max-w-[680px]"
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.18)',
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'rgba(255,255,255,0.55)', flexShrink: 0 }}
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
            aria-label="Search the library"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#FFFFFF',
              fontSize: 15,
              fontWeight: 400,
              padding: '6px 0',
              minHeight: 0,
            }}
          />
          <kbd
            className="hidden sm:inline-block text-[11px] font-mono px-1.5 py-0.5 rounded"
            style={{
              color: 'rgba(255,255,255,0.7)',
              background: 'rgba(255,255,255,0.14)',
              border: '1px solid rgba(255,255,255,0.20)',
            }}
          >
            ⌘K
          </kbd>
        </div>
      </div>

      {/* Cover row pinned to the bottom edge — covers "rise" from the
          navy/white seam. Hidden on phones to keep the hero compact;
          desktop is where the design gets its visual rhythm. */}
      <div
        className="hidden sm:flex absolute left-0 right-0 bottom-0 items-end gap-1.5 px-6 md:px-11 overflow-hidden"
        aria-hidden
        style={{ paddingBottom: 0 }}
      >
        {covers.map((c, i) => (
          <HeroCoverTile key={i} cover={c} />
        ))}
      </div>
    </section>
  );
}

interface HeroCover {
  url?: string;
  height: number;
  fallbackColor?: string;
}

const COVER_HEIGHT_CYCLE = [80, 84, 76, 88, 82, 78, 86, 90, 79, 83, 87, 81];

function buildHeroCovers(ledger: LedgerEntry[]): HeroCover[] {
  // Pull the 12 most recent entries with ISBNs.
  const sorted = [...ledger].sort((a, b) => (a.date < b.date ? 1 : -1));
  const withIsbn = sorted.filter((e) => !!e.isbn).slice(0, 12);
  const covers: HeroCover[] = withIsbn.map((e, i) => ({
    url: `https://covers.openlibrary.org/b/isbn/${e.isbn}-S.jpg?default=false`,
    height: COVER_HEIGHT_CYCLE[i % COVER_HEIGHT_CYCLE.length],
  }));
  // Backfill with domain-colored placeholders so the row reads as a cover
  // stack even on a fresh ledger. Cycle through the 21 domain colors.
  const palette = Object.values(DOMAIN_COLOR);
  while (covers.length < 12) {
    const i = covers.length;
    covers.push({
      height: COVER_HEIGHT_CYCLE[i % COVER_HEIGHT_CYCLE.length],
      fallbackColor: palette[i % palette.length],
    });
  }
  return covers;
}

function HeroCoverTile({ cover }: { cover: HeroCover }) {
  return (
    <div
      className="flex-shrink-0"
      style={{
        width: 56,
        height: cover.height,
        borderTopLeftRadius: 2,
        borderTopRightRadius: 2,
        overflow: 'hidden',
        background: cover.fallbackColor ?? 'rgba(255,255,255,0.06)',
        boxShadow: '0 -2px 6px rgba(0,0,0,0.25)',
      }}
    >
      {cover.url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cover.url}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page body — Collection Overview (left, dominant) + Right column
// ---------------------------------------------------------------------------

function CollectionOverview({ stats }: { stats: DashboardStats }) {
  // Order: populated first (count desc), then empty in canonical
  // taxonomy order — populated work surfaces first while empty rows
  // round out the LCC universe at a glance.
  const populated = stats.perDomain.filter((d) => d.count > 0);
  const populatedSet = new Set(populated.map((d) => d.domain));
  const empty = (Object.keys(VOCAB.domains) as DomainKey[])
    .filter((d) => !populatedSet.has(d))
    .map((domain) => ({
      domain,
      label: VOCAB.domains[domain].label,
      count: 0,
    }));
  const totalForBar = populated.reduce((s, d) => s + d.count, 0) || 1;

  return (
    <section>
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-6">
        <div>
          <div className="typo-section-label mb-1.5">Collection overview</div>
          <h2
            style={{
              fontSize: 22,
              fontWeight: 500,
              lineHeight: 1.25,
              color: 'rgb(var(--color-text-primary))',
              margin: 0,
            }}
          >
            Across the LCC taxonomy
          </h2>
        </div>
        <Link
          href="/vocabulary"
          className="text-[12px] font-medium text-navy hover:underline"
        >
          View all →
        </Link>
      </div>

      {/* Stats row — three large numbers, generous gap. The DOMAINS
          POPULATED stat splits the proportion into primary + muted so
          the "{N} / 21" reads as a fraction, not a single number. */}
      <div className="flex flex-wrap gap-x-10 gap-y-5 pb-6 border-b border-line-light">
        <BigStat label="Total books" value={stats.totalBooks} />
        <BigStat label="Unique works" value={stats.uniqueWorks} />
        <BigStatFraction
          label="Domains populated"
          numerator={stats.domainsPopulated}
          denominator={21}
        />
      </div>

      {/* Distribution bar */}
      <div className="mt-5 mb-4">
        <div
          className="flex h-[28px] rounded-md overflow-hidden border border-line-light"
          style={{ background: 'rgb(var(--color-surface-page))' }}
        >
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
          {populated.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-[11px] text-text-tertiary">
              No domains populated yet
            </div>
          )}
        </div>
      </div>

      {/* Domain legend grid — populated first, then empty. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5">
        {[...populated, ...empty].map((d) => (
          <DomainLegendRow
            key={d.domain}
            domain={d.domain}
            label={d.label}
            count={d.count}
          />
        ))}
      </div>
    </section>
  );
}

function BigStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div
        style={{
          fontSize: 44,
          fontWeight: 500,
          letterSpacing: '-1px',
          lineHeight: 1,
          color: 'rgb(var(--color-text-primary))',
        }}
      >
        {value.toLocaleString()}
      </div>
      <div
        className="uppercase"
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.5px',
          color: 'rgb(var(--color-text-tertiary))',
          marginTop: 6,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function BigStatFraction({
  label,
  numerator,
  denominator,
}: {
  label: string;
  numerator: number;
  denominator: number;
}) {
  return (
    <div>
      <div
        style={{
          letterSpacing: '-1px',
          lineHeight: 1,
          color: 'rgb(var(--color-text-primary))',
        }}
      >
        <span style={{ fontSize: 44, fontWeight: 500 }}>{numerator}</span>
        <span
          style={{
            fontSize: 28,
            fontWeight: 500,
            color: 'rgb(var(--color-text-quaternary))',
            marginLeft: 4,
          }}
        >
          {' / '}
          {denominator}
        </span>
      </div>
      <div
        className="uppercase"
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.5px',
          color: 'rgb(var(--color-text-tertiary))',
          marginTop: 6,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function DomainLegendRow({
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
      className="flex items-center gap-2.5 py-1"
      style={{ opacity: empty ? 0.4 : 1 }}
    >
      <span
        aria-hidden
        className="flex-shrink-0"
        style={{
          width: 8,
          height: 16,
          borderRadius: 1,
          background: empty ? 'rgb(var(--color-line))' : DOMAIN_COLOR[domain],
        }}
      />
      <span
        className="flex-1 min-w-0 truncate"
        style={{
          fontSize: 13,
          color: empty
            ? 'rgb(var(--color-text-tertiary))'
            : 'rgb(var(--color-text-primary))',
        }}
      >
        {label}
      </span>
      <span
        className="font-mono"
        style={{
          fontSize: 13,
          fontWeight: empty ? 400 : 500,
          color: empty
            ? 'rgb(var(--color-text-tertiary))'
            : 'rgb(var(--color-text-primary))',
        }}
      >
        {empty ? '—' : count}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right column — Cataloging tools + Recent activity
// ---------------------------------------------------------------------------

function RightColumn({ ledger }: { ledger: LedgerEntry[] }) {
  const authorityGroups = useMemo(
    () => detectAuthorityIssues(ledger).groups.length,
    [ledger]
  );
  const duplicateGroups = useMemo(
    () => detectDuplicates(ledger).groups.length,
    [ledger]
  );

  const recent = useMemo(() => {
    const sorted = [...ledger].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const at = a.title ?? a.titleNorm;
      const bt = b.title ?? b.titleNorm;
      return at.localeCompare(bt);
    });
    return sorted.slice(0, 5);
  }, [ledger]);

  return (
    <aside className="lg:border-l lg:border-line-light lg:pl-7">
      <div className="typo-section-label mb-2.5">Cataloging tools</div>
      <div>
        <ToolRow
          href="/collection/authority"
          title="Authority check"
          description='Inconsistent author names. "Solnit, R." vs "Solnit, Rebecca" — merge or keep separate.'
          status={
            authorityGroups === 0
              ? { text: 'All clear', tone: 'green' }
              : {
                  text: `${authorityGroups} ${authorityGroups === 1 ? 'group' : 'groups'}`,
                  tone: 'amber',
                }
          }
          isFirst
        />
        <ToolRow
          href="/collection/duplicates"
          title="Duplicates & editions"
          description="Multiple copies or editions of the same work."
          status={
            duplicateGroups === 0
              ? { text: 'All clear', tone: 'green' }
              : {
                  text: `${duplicateGroups} ${duplicateGroups === 1 ? 'group' : 'groups'}`,
                  tone: 'amber',
                }
          }
        />
      </div>

      {recent.length > 0 && (
        <div className="mt-6">
          <div className="typo-section-label mb-2.5">Recent activity</div>
          <div>
            {recent.map((e, i) => (
              <RecentActivityRow
                key={`${e.isbn || 'noisbn'}-${e.titleNorm}-${e.date}-${e.batchLabel ?? ''}`}
                entry={e}
                showBorder={i > 0}
              />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function ToolRow({
  href,
  title,
  description,
  status,
  isFirst,
}: {
  href: string;
  title: string;
  description: string;
  status: { text: string; tone: 'green' | 'amber' | 'red' };
  isFirst?: boolean;
}) {
  const toneClass =
    status.tone === 'green'
      ? 'bg-carnegie-green-soft text-carnegie-green'
      : status.tone === 'amber'
        ? 'bg-carnegie-amber-soft text-carnegie-amber'
        : 'bg-carnegie-red-soft text-carnegie-red';
  return (
    <Link
      href={href}
      className={`block py-3 -mx-1.5 px-1.5 rounded-sm hover:bg-surface-page/40 transition ${
        isFirst ? '' : 'border-t border-line-light'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[14px] font-medium text-text-primary">
          {title}
        </span>
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${toneClass}`}
        >
          {status.text}
        </span>
      </div>
      <div className="text-[12px] text-text-secondary leading-relaxed">
        {description}
      </div>
    </Link>
  );
}

function RecentActivityRow({
  entry,
  showBorder,
}: {
  entry: LedgerEntry;
  showBorder: boolean;
}) {
  const cover = entry.isbn
    ? `https://covers.openlibrary.org/b/isbn/${entry.isbn}-S.jpg?default=false`
    : '';
  return (
    <Link
      href="/review"
      className={`flex items-center gap-2.5 py-2 hover:bg-surface-page/40 transition -mx-1.5 px-1.5 rounded-sm ${
        showBorder ? 'border-t border-line-light' : ''
      }`}
    >
      <div
        className="flex-shrink-0 bg-surface-page rounded overflow-hidden"
        style={{ width: 24, height: 34 }}
      >
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
        <div
          className="text-text-primary truncate"
          style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.35 }}
        >
          {entry.title ?? entry.titleNorm}
        </div>
        <div
          className="text-text-tertiary truncate"
          style={{ fontSize: 11, lineHeight: 1.4 }}
        >
          {entry.author ?? entry.authorNorm}
          {entry.date ? ` · ${timeAgo(entry.date)}` : ''}
        </div>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Search results + empty state
// ---------------------------------------------------------------------------

function SearchResults({ hits, query }: { hits: SearchHit[]; query: string }) {
  if (hits.length === 0) {
    return (
      <div className="bg-surface-card border border-line rounded-lg p-6 text-center">
        <div className="text-text-secondary text-[14px]">
          No books match <span className="font-mono">{`"${query}"`}</span>.
        </div>
        <div className="text-text-tertiary text-[12px] mt-2">
          Try a different term, or click{' '}
          <span className="font-mono">↻ Refresh from cloud</span> if you've
          added books on another device.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="typo-section-label mb-2">
        {hits.length} {hits.length === 1 ? 'result' : 'results'}
      </div>
      {hits.map((h) => (
        <SearchResultRow
          key={`${h.entry.isbn}-${h.entry.titleNorm}`}
          entry={h.entry}
        />
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

function EmptyLibraryState() {
  return (
    <div className="max-w-xl mx-auto py-10 text-center">
      <h2 className="typo-card-title">Your collection is empty</h2>
      <p className="text-text-secondary mt-2 mb-6 leading-relaxed">
        Catalog your first shelf to get started.
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
