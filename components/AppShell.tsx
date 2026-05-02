'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useDarkMode, useStore } from '@/lib/store';
import { getLedgerBatches, loadLedger } from '@/lib/export-ledger';
import { confirmDiscardSession } from '@/lib/session';

/**
 * Carnegie shell — left sidebar (200px, near-black) + scrollable content area.
 * The sidebar is a fixed-width column, the content takes the remainder.
 *
 * Inline styles are used for the few values the spec calls out by exact pixel
 * (sidebar widths, brand padding, nav item proportions). The rest leans on
 * Tailwind for color + typography utilities.
 */
const SIDEBAR_W = 260;
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
          paddingTop: 0,
          paddingBottom: 0,
        }}
      >
        {/* Brand panel — Carnegie tartan as the background, clan-color
            stripes layered horizontally + vertically to make the
            crosshatch weave. The rest of the sidebar stays solid
            #141414; the tartan only lives in this top zone. */}
        <BrandPanel />
        <div style={{ marginBottom: 16 }} />

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

        {/* Footer — pinned to the bottom with a top border. Numbers
            read from the export ledger so they reflect cumulative
            cataloging across sessions. */}
        <div
          className="mt-auto"
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
        {/* Fill the remaining width — no max-w cap. The app is designed
            for the desktop screens it runs on; cap-and-center looks like
            a mobile app stretched. */}
        <div className="w-full px-8 lg:px-12 py-10">{children}</div>
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
        padding: '10px 16px',
        color: active ? SIDE_TEXT_ACTIVE : SIDE_TEXT,
        background: active ? SIDE_ACTIVE : 'transparent',
        borderLeft: `2px solid ${active ? NAVY : 'transparent'}`,
        fontSize: 14,
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

// ---- Brand panel ----------------------------------------------------------

/**
 * Tartan brand zone at the top of the sidebar. Backed by a real
 * tartan photograph at /public/tartan.jpg, sized to cover the panel
 * and centered. A dark linear-gradient scrim is layered above the
 * photo (but below the text) to keep the wordmark legible over the
 * brightest tartan crossings; a soft text-shadow on the wordmark
 * itself is the belt-and-suspenders backup.
 *
 * Falls back to a solid navy when /tartan.jpg is missing or fails
 * to load — the backgroundColor underneath always paints first.
 */
function BrandPanel() {
  return (
    <Link
      href="/"
      className="cursor-pointer group flex items-center relative"
      style={{
        // Two background layers, top-to-bottom:
        //   1. dark scrim (sits on top of the photo)
        //   2. /tartan.jpg cover-fitted, centered
        // Plus a navy ground for the no-image fallback.
        backgroundColor: NAVY,
        backgroundImage:
          "linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.30))," +
          "url('/tartan.jpg')",
        backgroundSize: 'auto, cover',
        backgroundPosition: 'center, center',
        backgroundRepeat: 'no-repeat, no-repeat',
        padding: 24,
        gap: 14,
        minHeight: 96,
      }}
      aria-label="Carnegie — go to upload"
    >
      <SpineStackLogo />
      <span className="flex flex-col leading-none">
        <span
          style={{
            fontFamily:
              '"Arial Black", "Helvetica Neue", Arial, system-ui, sans-serif',
            fontSize: 16,
            fontWeight: 900,
            color: '#FFFFFF',
            letterSpacing: '3px',
            textTransform: 'uppercase',
            textShadow: '0 1px 2px rgba(0,0,0,0.7)',
          }}
        >
          Carnegie
        </span>
        <span
          style={{
            fontSize: 8,
            color: 'rgba(255,255,255,0.85)',
            letterSpacing: '2px',
            textTransform: 'uppercase',
            marginTop: 6,
            textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          }}
        >
          Cataloging System
        </span>
      </span>
    </Link>
  );
}

/**
 * 40×40 rounded-square tile with a stack of four colored bars
 * representing book spines on a shelf. Clean palette — no tartan
 * inside the tile so the brand mark stays legible at all scales.
 *
 *   gold   #C4A35A  tallest
 *   blue   #5B8DB8
 *   red    #B83232
 *   gray   #8A8A84  shortest
 *
 * Each bar is 5px wide with 2px gaps; total stack width = 5×4 + 2×3
 * = 26px, leaving 7px of padding on each side of the 40px tile.
 */
function SpineStackLogo() {
  const bars: { color: string; height: number }[] = [
    { color: '#C4A35A', height: 30 },
    { color: '#5B8DB8', height: 26 },
    { color: '#B83232', height: 22 },
    { color: '#8A8A84', height: 18 },
  ];
  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 8,
        background: '#141414',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        flexShrink: 0,
      }}
      aria-hidden
    >
      {bars.map((b, i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: b.height,
            background: b.color,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}
