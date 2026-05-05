'use client';

/**
 * Shelflist — the user's library shown in LCC call-number order, as a
 * two-level collapsible accordion.
 *
 * Top level: all 21 LCC class letters always visible (open-world).
 * Empty classes render at reduced opacity with "—" and reveal an empty
 * state when expanded.
 *
 * Second level: only sub-classes with books appear (no empty rows).
 * Sub-class is the leading letter run of the LCC string ("PR6063.U7" →
 * "PR", "P327" → "P"). Sub-classes sorted alphabetically.
 *
 * Third level: books sorted by full LCC ascending, each row links to
 * /review.
 *
 * Data source: the export ledger via loadLedger(). In-flight batches
 * not yet exported are NOT shown here (they live on Review).
 *
 * Expanded state persists across in-tab navigation via sessionStorage,
 * resets to all-collapsed on reload.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { loadLedger, type LedgerEntry } from '@/lib/export-ledger';
import { subclassFor, subclassLabel } from '@/lib/lcc-subclasses';
import { VOCAB, domainForLcc, type DomainKey } from '@/lib/tag-domains';

// Domain colors mirror tailwind.config.ts. Inlined as hex because
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

// Canonical 21 LCC class letters in alphabetical order (skipping
// I/O/W/X/Y per LCC). The DomainKey lookup gives us the label and the
// stripe color — this list owns the order on the page.
const CLASS_LETTERS: { letter: string; domain: DomainKey }[] = (
  Object.keys(VOCAB.domains) as DomainKey[]
)
  .map((d) => ({ letter: VOCAB.domains[d].lcc_letter ?? '', domain: d }))
  .filter((x) => x.letter)
  .sort((a, b) => a.letter.localeCompare(b.letter));

const EXPANDED_KEY = 'carnegie:shelflist-expanded';

interface SubclassGroup {
  subclass: string;
  books: LedgerEntry[];
}

interface ClassGroup {
  letter: string;
  domain: DomainKey;
  totalBooks: number;
  subclasses: SubclassGroup[]; // populated only; empty subclasses excluded
}

interface GroupedLibrary {
  classes: ClassGroup[];
  unclassifiedCount: number; // ledger entries with no parseable LCC
}

function groupLibrary(entries: LedgerEntry[]): GroupedLibrary {
  // Bucket entries by class letter (first letter) and sub-class
  // (first letter run). Unclassified = no LCC at all OR first char not a letter.
  const byClass = new Map<string, Map<string, LedgerEntry[]>>();
  let unclassifiedCount = 0;

  for (const e of entries) {
    const sub = subclassFor(e.lcc);
    if (!sub) {
      unclassifiedCount += 1;
      continue;
    }
    const letter = sub.charAt(0);
    let subMap = byClass.get(letter);
    if (!subMap) {
      subMap = new Map();
      byClass.set(letter, subMap);
    }
    const list = subMap.get(sub) ?? [];
    list.push(e);
    subMap.set(sub, list);
  }

  const classes: ClassGroup[] = CLASS_LETTERS.map(({ letter, domain }) => {
    const subMap = byClass.get(letter);
    if (!subMap) return { letter, domain, totalBooks: 0, subclasses: [] };
    const subclasses: SubclassGroup[] = Array.from(subMap.entries())
      .map(([subclass, books]) => ({
        subclass,
        // Sort books within a sub-class by full LCC ascending so the
        // shelflist reads as a real shelf would.
        books: [...books].sort((a, b) =>
          (a.lcc ?? '').localeCompare(b.lcc ?? '')
        ),
      }))
      .sort((a, b) => a.subclass.localeCompare(b.subclass));
    const totalBooks = subclasses.reduce((s, g) => s + g.books.length, 0);
    return { letter, domain, totalBooks, subclasses };
  });

  return { classes, unclassifiedCount };
}

export default function ShelflistPage() {
  const [hydrated, setHydrated] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setLedger(loadLedger());
    try {
      const raw = sessionStorage.getItem(EXPANDED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') setExpanded(parsed);
      }
    } catch {
      // ignore — sessionStorage may be disabled / quota issues
    }
    setHydrated(true);
  }, []);

  // Persist expanded state on every change. Skipped pre-hydrate so the
  // first render doesn't blow away an in-flight session restore.
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
    } catch {
      // ignore
    }
  }, [expanded, hydrated]);

  const grouped = useMemo(() => groupLibrary(ledger), [ledger]);

  function toggle(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const totalBooks = grouped.classes.reduce((s, c) => s + c.totalBooks, 0);
  const populatedClassCount = grouped.classes.filter((c) => c.totalBooks > 0)
    .length;

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <div className="h-10 bg-surface-card border border-line rounded-md animate-pulse" />
      </div>
    );
  }

  const isEmptyLibrary = totalBooks === 0 && grouped.unclassifiedCount === 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="typo-page-title">Shelflist</h1>
        <div className="text-[13px] text-text-secondary mt-0.5">
          {totalBooks.toLocaleString()}{' '}
          {totalBooks === 1 ? 'book' : 'books'} across {populatedClassCount} of
          21 classes
        </div>
        <p className="text-[13px] text-text-tertiary mt-1.5 max-w-2xl">
          Your library in LCC order. Click a class to see its sub-classes,
          then a sub-class to see books.
        </p>
      </div>

      {isEmptyLibrary && (
        <div className="bg-navy-soft border border-navy/20 rounded-md px-4 py-2.5 text-[13px] text-navy">
          No books cataloged yet. Start with{' '}
          <Link href="/upload" className="underline font-medium">
            Upload
          </Link>{' '}
          to fill your shelves.
        </div>
      )}

      {grouped.unclassifiedCount > 0 && (
        <div className="bg-carnegie-amber-soft border border-carnegie-amber/30 rounded-md px-4 py-2.5 text-[13px] text-text-primary">
          {grouped.unclassifiedCount}{' '}
          {grouped.unclassifiedCount === 1 ? 'book' : 'books'} couldn&rsquo;t
          be classified — they&rsquo;re missing LCC data. Process again to
          retry.
        </div>
      )}

      <div className="bg-surface-card border border-line rounded-lg overflow-hidden">
        {grouped.classes.map((cls) => (
          <ClassRow
            key={cls.letter}
            cls={cls}
            isOpen={!!expanded[cls.letter]}
            isLast={cls.letter === CLASS_LETTERS[CLASS_LETTERS.length - 1].letter}
            expanded={expanded}
            onToggleClass={() => toggle(cls.letter)}
            onToggleSubclass={(sub) => toggle(`${cls.letter}:${sub}`)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level row: a class letter
// ---------------------------------------------------------------------------

function ClassRow({
  cls,
  isOpen,
  isLast,
  expanded,
  onToggleClass,
  onToggleSubclass,
}: {
  cls: ClassGroup;
  isOpen: boolean;
  isLast: boolean;
  expanded: Record<string, boolean>;
  onToggleClass: () => void;
  onToggleSubclass: (sub: string) => void;
}) {
  const empty = cls.totalBooks === 0;
  const className = VOCAB.domains[cls.domain].label;
  const stripeColor = empty ? '#D8D8D5' : DOMAIN_COLOR[cls.domain];

  return (
    <div className={isLast ? '' : 'border-b border-line-light'}>
      <button
        type="button"
        onClick={onToggleClass}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-surface-page/40 transition cursor-pointer"
        aria-expanded={isOpen}
        style={{ opacity: empty ? 0.45 : 1 }}
      >
        <Chevron open={isOpen} />
        <span
          aria-hidden
          className="flex-shrink-0 rounded-sm"
          style={{ width: 4, height: 14, background: stripeColor }}
        />
        <span
          className="font-mono"
          style={{
            fontSize: 13,
            fontWeight: 500,
            width: 28,
            color: empty ? 'rgb(var(--color-text-tertiary))' : 'rgb(var(--color-text-primary))',
          }}
        >
          {cls.letter}
        </span>
        <span
          className="flex-1 truncate"
          style={{
            fontSize: 13,
            color: empty ? 'rgb(var(--color-text-tertiary))' : 'rgb(var(--color-text-primary))',
          }}
        >
          {className}
        </span>
        <span
          className="font-mono flex-shrink-0"
          style={{
            fontSize: 12,
            color: empty
              ? 'rgb(var(--color-text-tertiary))'
              : 'rgb(var(--color-text-secondary))',
          }}
        >
          {empty ? '—' : cls.totalBooks}
        </span>
      </button>
      {isOpen && (
        <div className="bg-surface-page/40 border-t border-line-light">
          {empty ? (
            <div className="px-12 py-3 text-[12px] text-text-tertiary italic">
              No books in this class yet — they&rsquo;ll appear here as you
              catalog books with LCC starting with {cls.letter}.
            </div>
          ) : (
            cls.subclasses.map((sub) => (
              <SubclassRow
                key={sub.subclass}
                classLetter={cls.letter}
                sub={sub}
                isOpen={!!expanded[`${cls.letter}:${sub.subclass}`]}
                onToggle={() => onToggleSubclass(sub.subclass)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Second-level row: a sub-class
// ---------------------------------------------------------------------------

function SubclassRow({
  classLetter: _classLetter,
  sub,
  isOpen,
  onToggle,
}: {
  classLetter: string;
  sub: SubclassGroup;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const label = subclassLabel(sub.subclass);

  return (
    <div className="border-t border-line-light first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 py-2 pr-3 text-left hover:bg-surface-card/60 transition"
        style={{ paddingLeft: 36 }}
        aria-expanded={isOpen}
      >
        <Chevron open={isOpen} small />
        <span
          aria-hidden
          className="flex-shrink-0"
          style={{
            width: 1,
            height: 14,
            background: 'rgb(var(--color-line))',
          }}
        />
        <span
          className="font-mono"
          style={{
            fontSize: 12,
            fontWeight: 500,
            width: 32,
            color: 'rgb(var(--color-text-primary))',
          }}
        >
          {sub.subclass}
        </span>
        <span
          className="flex-1 truncate"
          style={{
            fontSize: 12,
            color: label
              ? 'rgb(var(--color-text-secondary))'
              : 'rgb(var(--color-text-tertiary))',
            fontStyle: label ? 'normal' : 'italic',
          }}
        >
          {label || '(no label)'}
        </span>
        <span
          className="font-mono flex-shrink-0"
          style={{ fontSize: 11, color: 'rgb(var(--color-text-tertiary))' }}
        >
          {sub.books.length}
        </span>
      </button>
      {isOpen && (
        <div className="border-t border-line-light bg-surface-card">
          {sub.books.map((book) => (
            <BookRow
              key={`${book.isbn || 'noisbn'}-${book.titleNorm}-${book.date}-${book.batchLabel ?? ''}`}
              book={book}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Third-level row: a book
// ---------------------------------------------------------------------------

function BookRow({ book }: { book: LedgerEntry }) {
  const cover = book.isbn
    ? `https://covers.openlibrary.org/b/isbn/${book.isbn}-S.jpg?default=false`
    : '';
  const isFiction = (book.tags ?? []).includes('Fiction');
  return (
    <Link
      href="/review"
      className="flex items-center gap-2.5 py-2 pr-3 hover:bg-surface-page/40 transition border-t border-line-light first:border-t-0"
      style={{ paddingLeft: 60 }}
    >
      <div
        className="flex-shrink-0 bg-surface-page rounded overflow-hidden"
        style={{ width: 22, height: 30 }}
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
      <span
        className="font-mono flex-shrink-0 hidden sm:block truncate"
        style={{
          fontSize: 11,
          width: 110,
          color: 'rgb(var(--color-text-tertiary))',
        }}
        title={book.lcc ?? ''}
      >
        {book.lcc ?? ''}
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="text-text-primary truncate"
          style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35 }}
        >
          {book.title ?? book.titleNorm}
        </div>
        <div
          className="text-text-secondary truncate"
          style={{ fontSize: 11, lineHeight: 1.4 }}
        >
          {book.author ?? book.authorNorm}
          {book.publicationYear ? ` · ${book.publicationYear}` : ''}
        </div>
      </div>
      {isFiction && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 bg-language_literature-bg text-language_literature-fg dark:bg-language_literature-fg/45 dark:text-language_literature-bg">
          Fiction
        </span>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Chevron — rotates 90° when open. CSS transform so the same node
// animates open/close without remounting.
// ---------------------------------------------------------------------------

function Chevron({ open, small }: { open: boolean; small?: boolean }) {
  const size = small ? 10 : 11;
  return (
    <span
      aria-hidden
      className="flex-shrink-0 transition-transform"
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        color: 'rgb(var(--color-text-tertiary))',
        fontSize: small ? 10 : 11,
        lineHeight: 1,
      }}
    >
      ▸
    </span>
  );
}
