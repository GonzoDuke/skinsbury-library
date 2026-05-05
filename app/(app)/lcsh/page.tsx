'use client';

/**
 * LCSH Subject Headings — browse the Library of Congress Subject
 * Headings drawn from approved books in the user's library.
 *
 * Single route /lcsh. ?h={encoded heading} flips between two views:
 *   - no ?h          → index (filterable, sortable list of headings)
 *   - ?h=<heading>   → detail (every approved book carrying that heading)
 *
 * Headings are treated as opaque atoms — "World War, 1939-1945 -- Fiction"
 * and "World War, 1939-1945" are distinct entries; we don't split on
 * subdivisions. Only approved books with at least one LCSH heading
 * contribute, since the surface is meant to be a stable browse view of
 * the cataloged collection (not a moving target reflecting in-flight
 * Review work).
 *
 * useSearchParams forces a Suspense boundary at build time per the
 * Next.js App Router contract; the inner component is wrapped below.
 */

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStore } from '@/lib/store';
import type { BookRecord } from '@/lib/types';
import { BookBrowseRow } from '@/components/BookBrowseRow';
import { BookBrowseCard } from '@/components/BookBrowseCard';

type SortMode = 'alpha' | 'count';

export default function LcshPage() {
  return (
    <Suspense fallback={null}>
      <LcshInner />
    </Suspense>
  );
}

function LcshInner() {
  const params = useSearchParams();
  const rawHeading = params.get('h');
  const heading = rawHeading ? safeDecode(rawHeading) : null;

  // Hydration gate — useStore returns the initial empty state on the
  // server pass; rendering the empty-states before localStorage hydrates
  // would flash "no books yet" on every page load.
  const { state } = useStore();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const headingsByApprovedBook = useMemo(() => {
    return buildHeadingMap(state.allBooks);
  }, [state.allBooks]);

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 bg-surface-card border border-line rounded-md animate-pulse" />
        <div className="h-10 bg-surface-card border border-line rounded-md animate-pulse" />
      </div>
    );
  }

  if (heading) {
    return <DetailView heading={heading} headingsByApprovedBook={headingsByApprovedBook} />;
  }
  return (
    <IndexView
      headingsByApprovedBook={headingsByApprovedBook}
      approvedCount={state.allBooks.filter((b) => b.status === 'approved').length}
    />
  );
}

// ---------------------------------------------------------------------------
// Index view
// ---------------------------------------------------------------------------

function IndexView({
  headingsByApprovedBook,
  approvedCount,
}: {
  headingsByApprovedBook: Map<string, BookRecord[]>;
  approvedCount: number;
}) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortMode>('alpha');

  const totalHeadings = headingsByApprovedBook.size;

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = Array.from(headingsByApprovedBook.entries()).map(
      ([h, books]) => ({ heading: h, count: books.length })
    );
    const filtered = q
      ? all.filter((r) => r.heading.toLowerCase().includes(q))
      : all;
    if (sort === 'count') {
      return filtered.sort(
        (a, b) => b.count - a.count || a.heading.localeCompare(b.heading)
      );
    }
    return filtered.sort((a, b) => a.heading.localeCompare(b.heading));
  }, [headingsByApprovedBook, filter, sort]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="typo-page-title">LCSH Subject Headings</h1>
        <p className="typo-page-desc max-w-3xl">
          Library of Congress Subject Headings drawn from cataloged metadata.
          Click any heading to see the books carrying it.
        </p>
      </div>

      {approvedCount === 0 ? (
        <EmptyState
          title="No approved books yet."
          body={
            <>
              Approve books on the{' '}
              <Link href="/review" className="text-navy underline font-medium">
                Review screen
              </Link>{' '}
              to see their subject headings here.
            </>
          }
        />
      ) : totalHeadings === 0 ? (
        <EmptyState
          title="No subject headings found."
          body="LCSH headings populate when the lookup pipeline matches a Library of Congress MARC record — coverage varies by edition."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full md:w-80 md:max-w-[320px]">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter headings…"
                className="w-full bg-surface-card border border-line rounded-md pl-9 pr-9 py-[10px] text-[14px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy"
                aria-label="Filter headings"
              />
              <span
                aria-hidden
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-quaternary text-[14px]"
              >
                ⌕
              </span>
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  aria-label="Clear filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full text-text-quaternary hover:text-navy hover:bg-surface-page transition flex items-center justify-center"
                >
                  ×
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] uppercase tracking-wider text-ink/40 dark:text-cream-300/40 font-semibold mr-1">
                Sort
              </span>
              <SortPill
                label="A → Z"
                active={sort === 'alpha'}
                onClick={() => setSort('alpha')}
              />
              <SortPill
                label="By book count"
                active={sort === 'count'}
                onClick={() => setSort('count')}
              />
            </div>
            <span className="text-[12px] text-text-tertiary ml-auto">
              {rows.length === totalHeadings
                ? `${totalHeadings.toLocaleString()} ${totalHeadings === 1 ? 'heading' : 'headings'}`
                : `${rows.length.toLocaleString()} of ${totalHeadings.toLocaleString()} headings`}
            </span>
          </div>

          <div className="bg-surface-card border border-line rounded-lg overflow-hidden">
            {rows.length === 0 ? (
              <div className="text-[13px] text-text-tertiary italic p-6 text-center">
                No headings match &ldquo;{filter}&rdquo;.
              </div>
            ) : (
              rows.map((r) => (
                <Link
                  key={r.heading}
                  href={`/lcsh?h=${encodeURIComponent(r.heading)}`}
                  className="flex items-center justify-between gap-4 px-4 py-2.5 border-b border-line-light last:border-b-0 hover:bg-navy-soft transition-colors text-text-primary cursor-pointer focus:outline-none focus:bg-navy-soft"
                >
                  <span className="text-[13px] truncate" title={r.heading}>
                    {r.heading}
                  </span>
                  <span
                    className="text-[12px] font-mono text-text-tertiary flex-shrink-0"
                    aria-label={`${r.count} ${r.count === 1 ? 'book' : 'books'}`}
                  >
                    {r.count}
                  </span>
                </Link>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function DetailView({
  heading,
  headingsByApprovedBook,
}: {
  heading: string;
  headingsByApprovedBook: Map<string, BookRecord[]>;
}) {
  const books = headingsByApprovedBook.get(heading) ?? [];
  const sorted = useMemo(() => {
    return [...books].sort((a, b) => {
      const al = lastName(a);
      const bl = lastName(b);
      const byAuthor = al.localeCompare(bl);
      if (byAuthor !== 0) return byAuthor;
      return (a.title ?? '').localeCompare(b.title ?? '');
    });
  }, [books]);

  const count = sorted.length;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/lcsh"
          className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-navy transition mb-3"
        >
          <span aria-hidden>←</span>
          <span>Back to LCSH</span>
        </Link>
        <h1 className="typo-page-title break-words">{heading}</h1>
        {count > 0 ? (
          <p className="typo-page-desc">
            {count} {count === 1 ? 'book' : 'books'} with this heading
          </p>
        ) : null}
      </div>

      {count === 0 ? (
        <EmptyState
          title={`No books found with the heading "${heading}".`}
          body={
            <>
              The heading may have been removed when a book was re-tagged.{' '}
              <Link href="/lcsh" className="text-navy underline font-medium">
                Back to LCSH
              </Link>
              .
            </>
          }
        />
      ) : (
        <>
          {/* Phone — stack of cards. */}
          <div className="md:hidden space-y-2.5">
            {sorted.map((b) => (
              <BookBrowseCard key={b.id} book={b} />
            ))}
          </div>

          {/* Desktop / tablet — table-style rows. */}
          <div className="hidden md:block bg-surface-card border border-line rounded-lg overflow-hidden">
            {sorted.map((b) => (
              <BookBrowseRow key={b.id} book={b} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHeadingMap(allBooks: BookRecord[]): Map<string, BookRecord[]> {
  const map = new Map<string, BookRecord[]>();
  for (const b of allBooks) {
    if (b.status !== 'approved') continue;
    const headings = b.lcshSubjects;
    if (!headings || headings.length === 0) continue;
    // De-dupe headings within a single book so a book carrying the same
    // heading twice doesn't double-count toward the per-heading total.
    const seen = new Set<string>();
    for (const raw of headings) {
      if (typeof raw !== 'string') continue;
      const h = raw.trim();
      if (!h || seen.has(h)) continue;
      seen.add(h);
      const list = map.get(h);
      if (list) list.push(b);
      else map.set(h, [b]);
    }
  }
  return map;
}

function lastName(b: BookRecord): string {
  // authorLF is "Last, First" when present — splitting on comma
  // collapses to "Last" cleanly. Falls back to the trailing whitespace
  // token of `author`, then to the empty string.
  if (b.authorLF) return b.authorLF.split(',')[0].trim().toLowerCase();
  if (b.author) {
    const parts = b.author.trim().split(/\s+/);
    return (parts[parts.length - 1] ?? '').toLowerCase();
  }
  return '';
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function SortPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-md transition ${
        active
          ? 'bg-accent text-cream-50'
          : 'bg-cream-100 text-ink/70 dark:text-cream-300/70 hover:bg-accent-soft dark:hover:bg-accent/20'
      }`}
    >
      {label}
    </button>
  );
}

function EmptyState({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="bg-surface-card border border-line rounded-lg p-6 text-center">
      <div className="text-[15px] font-medium text-text-primary mb-1">
        {title}
      </div>
      <div className="text-[13px] text-text-secondary leading-relaxed">
        {body}
      </div>
    </div>
  );
}
