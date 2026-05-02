'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useDarkMode, useStore } from '@/lib/store';
import { getLedgerBatches, loadLedger } from '@/lib/export-ledger';
import { TartanLogo, TartanStripe } from '@/components/Tartan';
import { confirmDiscardSession } from '@/lib/session';

/**
 * Carnegie shell — left sidebar (200px, near-black) + scrollable content area.
 * The sidebar is a fixed-width column, the content takes the remainder.
 *
 * Inline styles are used for the few values the spec calls out by exact pixel
 * (sidebar widths, brand padding, nav item proportions). The rest leans on
 * Tailwind for color + typography utilities.
 */
const SIDEBAR_W = 200;
const NAVY = '#1B3A5C';
const SIDE_BG = '#141414';
const SIDE_HOVER = '#1F1F1F';
const SIDE_ACTIVE = '#252525';
const SIDE_TEXT = '#707070';
const SIDE_TEXT_ACTIVE = '#E0E0E0';
const SIDE_FOOT_BORDER = '#222';
const SIDE_SECTION = '#444';
const GOLD = '#C4A35A';

interface NavItemDef {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Render a numeric badge (e.g. pending review count) when this is set. */
  badge?: number;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Mount the dark-mode hook for its initialization side-effect — applies
  // the stored preference on every page-load regardless of route.
  useDarkMode();

  const { state, clear } = useStore();

  function onNewSession() {
    if (!confirmDiscardSession(state.allBooks)) return;
    clear();
    // Page-local state (batch label / notes inputs on the upload page)
    // can't be reset from up here — broadcast a window event and let
    // any listening page wipe its own inputs in response. The upload
    // page is the only current listener.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('carnegie:session-cleared'));
    }
  }
  const sessionEmpty = state.allBooks.length === 0 && state.batches.length === 0;

  // Pending-review count for the badge on the Review nav item. Recomputes
  // when allBooks shifts; cheap (Array.filter + length).
  const pendingCount = useMemo(
    () => state.allBooks.filter((b) => b.status === 'pending').length,
    [state.allBooks]
  );

  // Footer stats — read once after hydration so we don't render mismatched
  // numbers on first paint. Same source as the upload-screen empty state.
  const [stats, setStats] = useState<{ books: number; batches: number } | null>(null);
  useEffect(() => {
    setStats({
      books: loadLedger().length,
      batches: getLedgerBatches().length,
    });
  }, [state.allBooks.length, state.batches.length]);

  const workflow: NavItemDef[] = [
    { href: '/', label: 'Upload', icon: <UploadIcon /> },
    { href: '/review', label: 'Review', icon: <ReviewIcon />, badge: pendingCount || undefined },
    { href: '/export', label: 'Export', icon: <ExportIcon /> },
  ];
  const library: NavItemDef[] = [
    { href: '/vocabulary', label: 'Vocabulary', icon: <BooksIcon /> },
    { href: '/history', label: 'History', icon: <ClockIcon /> },
  ];

  // The Upload route is `/` so we match it strictly; everything else uses a
  // prefix match so nested routes (e.g. /review/<id>) still highlight.
  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <div className="min-h-screen flex" style={{ fontFamily: '"Outfit", system-ui, -apple-system, sans-serif' }}>
      <aside
        className="fixed inset-y-0 left-0 flex flex-col select-none"
        style={{
          width: SIDEBAR_W,
          background: SIDE_BG,
          paddingTop: 20,
          paddingBottom: 0,
        }}
      >
        {/* Brand block — clickable, links to Upload */}
        <Link
          href="/"
          className="flex items-center gap-[10px] px-4 cursor-pointer group"
          style={{ marginBottom: 28 }}
          aria-label="Carnegie — go to upload"
        >
          <span style={{ flexShrink: 0, lineHeight: 0 }}>
            <TartanLogo size={32} />
          </span>
          <span className="flex flex-col leading-none">
            <span
              style={{
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontSize: 14,
                fontWeight: 600,
                color: SIDE_TEXT_ACTIVE,
                letterSpacing: '0.5px',
              }}
            >
              Carnegie
            </span>
            <span
              style={{
                fontSize: 9,
                color: GOLD,
                letterSpacing: '2px',
                textTransform: 'uppercase',
                marginTop: 2,
              }}
            >
              Cataloging System
            </span>
          </span>
        </Link>

        {/* New session — sits above the Workflow nav, just below the
            brand block. Disables on an empty session so the destructive
            confirm can't fire on a fresh load. Wraps to navy on hover
            (the sidebar's primary accent). */}
        <button
          type="button"
          onClick={onNewSession}
          disabled={sessionEmpty}
          title="Discard the current batch and start fresh — exported books stay in the ledger."
          style={{
            margin: '0 12px 16px',
            padding: '6px 10px',
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 6,
            border: `1px solid ${sessionEmpty ? '#2A2A2A' : '#2F2F2F'}`,
            background: 'transparent',
            color: sessionEmpty ? '#3F3F3F' : SIDE_TEXT,
            cursor: sessionEmpty ? 'not-allowed' : 'pointer',
            transition: 'all 80ms',
            textAlign: 'left',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
          }}
          onMouseEnter={(e) => {
            if (sessionEmpty) return;
            e.currentTarget.style.background = SIDE_HOVER;
            e.currentTarget.style.color = SIDE_TEXT_ACTIVE;
            e.currentTarget.style.borderColor = NAVY;
          }}
          onMouseLeave={(e) => {
            if (sessionEmpty) return;
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = SIDE_TEXT;
            e.currentTarget.style.borderColor = '#2F2F2F';
          }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            width="13"
            height="13"
            style={{ opacity: sessionEmpty ? 0.4 : 0.6 }}
            aria-hidden
          >
            <path d="M3 3h10v10H3z" />
            <path d="M8 6v4M6 8h4" />
          </svg>
          <span>New session</span>
        </button>

        <SectionLabel>Workflow</SectionLabel>
        {workflow.map((item) => (
          <NavItem key={item.href} item={item} active={isActive(item.href)} />
        ))}

        <SectionLabel topGap>Library</SectionLabel>
        {library.map((item) => (
          <NavItem key={item.href} item={item} active={isActive(item.href)} />
        ))}

        {/* Tartan accent stripe — the only decorative element in the whole
            app per spec §5b. Sits just above the footer, full sidebar width. */}
        <div className="mt-auto">
          <TartanStripe height={4} />
        </div>

        {/* Footer — border-top line plus two muted stat lines. Numbers
            read from the export ledger so they reflect cumulative
            cataloging across sessions. */}
        <div
          style={{
            padding: '12px 16px',
            borderTop: `1px solid ${SIDE_FOOT_BORDER}`,
          }}
        >
          {stats ? (
            <>
              <div style={{ fontSize: 11, color: SIDE_SECTION }}>
                {stats.books} {stats.books === 1 ? 'book' : 'books'} cataloged
              </div>
              <div style={{ fontSize: 11, color: SIDE_SECTION }}>
                {stats.batches} {stats.batches === 1 ? 'batch' : 'batches'} exported
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: SIDE_SECTION }}>—</div>
          )}
        </div>
      </aside>

      {/* Content column — takes the remaining viewport width. Independent
          scroll so the sidebar stays put as the user pages through long
          tables. Per-screen sticky page headers come in subsequent steps. */}
      <main className="flex-1 min-h-screen overflow-x-hidden" style={{ marginLeft: SIDEBAR_W }}>
        <div className="max-w-[1600px] w-full mx-auto px-8 lg:px-12 py-10">{children}</div>
      </main>
    </div>
  );
}

function SectionLabel({
  children,
  topGap,
}: {
  children: React.ReactNode;
  topGap?: boolean;
}) {
  return (
    <div
      style={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '1.5px',
        textTransform: 'uppercase',
        color: SIDE_SECTION,
        padding: '0 16px',
        marginTop: topGap ? 28 : 20,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function NavItem({ item, active }: { item: NavItemDef; active: boolean }) {
  return (
    <Link
      href={item.href}
      className="flex items-center gap-[9px] transition-colors"
      style={{
        padding: '7px 16px',
        color: active ? SIDE_TEXT_ACTIVE : SIDE_TEXT,
        background: active ? SIDE_ACTIVE : 'transparent',
        borderLeft: `2px solid ${active ? NAVY : 'transparent'}`,
        fontSize: 13,
        fontWeight: active ? 500 : 400,
      }}
      onMouseEnter={(e) => {
        if (active) return;
        e.currentTarget.style.background = SIDE_HOVER;
        e.currentTarget.style.color = SIDE_TEXT_ACTIVE;
      }}
      onMouseLeave={(e) => {
        if (active) return;
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = SIDE_TEXT;
      }}
    >
      <span
        style={{
          width: 15,
          height: 15,
          opacity: active ? 0.7 : 0.4,
          flexShrink: 0,
          display: 'inline-flex',
        }}
      >
        {item.icon}
      </span>
      <span className="flex-1">{item.label}</span>
      {typeof item.badge === 'number' && item.badge > 0 && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            background: 'rgba(196,163,90,0.18)',
            color: GOLD,
            padding: '1px 6px',
            borderRadius: 6,
          }}
        >
          {item.badge}
        </span>
      )}
    </Link>
  );
}

// ---- Icons ----------------------------------------------------------------
// Stroke-based 16×16 SVGs scaled to the 15px nav-icon footprint via CSS.
// Currently using `currentColor` so they pick up the nav text color
// automatically (active = lighter, hover = lighter, default = muted).

function IconShell({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="100%"
      height="100%"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function UploadIcon() {
  return (
    <IconShell>
      <path d="M8 10V2" />
      <path d="M5 5l3-3 3 3" />
      <path d="M2 10v3h12v-3" />
    </IconShell>
  );
}

function ReviewIcon() {
  return (
    <IconShell>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 5.5h6M5 8h6M5 10.5h3" />
    </IconShell>
  );
}

function ExportIcon() {
  return (
    <IconShell>
      <path d="M8 2v8" />
      <path d="M5 7l3 3 3-3" />
      <path d="M2 12v2h12v-2" />
    </IconShell>
  );
}

function BooksIcon() {
  return (
    <IconShell>
      <rect x="2" y="1" width="3" height="14" rx="0.5" />
      <rect x="6.5" y="2.5" width="3" height="12.5" rx="0.5" />
      <path d="M11.5 14l3-12.5" />
    </IconShell>
  );
}

function ClockIcon() {
  return (
    <IconShell>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 2" />
    </IconShell>
  );
}
