'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useDarkMode, useStore } from '@/lib/store';
import { getLedgerBatches, loadLedger } from '@/lib/export-ledger';
import { confirmDiscardSession } from '@/lib/session';
import {
  isNoWriteMode,
  setNoWriteMode,
  subscribeNoWriteMode,
} from '@/lib/no-write-mode';
import { MobileShell } from './MobileShell';
import { fireUndo } from './UndoToast';

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

  const { state, clear, addBatch } = useStore();

  function onNewSession() {
    if (!confirmDiscardSession(state.allBooks)) return;
    // Snapshot every batch before the wipe. The undo handler restores
    // them via ADD_BATCH (which re-unions embedded books into allBooks).
    // Pending File handles can't be reconstructed — that's by design;
    // the user must re-upload to re-process.
    const snapshot = state.batches;
    const batchCount = snapshot.length;
    clear();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('carnegie:session-cleared'));
    }
    if (batchCount > 0) {
      fireUndo(
        `Cleared session (${batchCount} ${batchCount === 1 ? 'batch' : 'batches'}).`,
        () => {
          for (const b of snapshot) addBatch(b);
        }
      );
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

  // Local-only-mode reactive state. Hydrate from localStorage post-mount
  // and subscribe to in-tab + cross-tab flips so the indicator + toggle
  // stay in sync everywhere it's rendered.
  const [noWrite, setNoWrite] = useState(false);
  useEffect(() => {
    setNoWrite(isNoWriteMode());
    return subscribeNoWriteMode(() => setNoWrite(isNoWriteMode()));
  }, []);

  const workflow: NavItemDef[] = [
    { href: '/upload', label: 'Upload', icon: <UploadIcon /> },
    { href: '/review', label: 'Review', icon: <ReviewIcon />, badge: pendingCount || undefined },
    { href: '/export', label: 'Export', icon: <ExportIcon /> },
  ];
  // Library section — Shelflist + Vocabulary. Both are library-scoped
  // surfaces (browse + per-tag), distinct from the Workflow flow.
  const library: NavItemDef[] = [
    { href: '/shelflist', label: 'Shelflist', icon: <ShelfIcon /> },
    { href: '/vocabulary', label: 'Vocabulary', icon: <BooksIcon /> },
  ];

  // Strict match for the root path (legacy bookmarks redirect to
  // /upload server-side); every other route uses a prefix match so
  // nested routes still highlight.
  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <div className="min-h-screen flex" style={{ fontFamily: '"Outfit", system-ui, -apple-system, sans-serif' }}>
      {/* Phone chrome — top bar + bottom tab bar. Hidden at md+ where
          the sidebar takes over. Renders no children itself; the page
          content lives in <main> below with responsive padding so the
          fixed bars don't overlap it. */}
      <div className="md:hidden">
        <MobileShell />
      </div>

      <aside
        className="fixed inset-y-0 left-0 hidden md:flex flex-col select-none"
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
            padding: '8px 12px',
            fontSize: 13,
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
            gap: 8,
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

        {/* About — standalone item, no section header. Sits just above
            the stats footer; the wrapper below uses mt-auto so the
            About + stats block hugs the bottom of the rail. */}
        <div className="mt-auto">
          <NavItem
            item={{ href: '/about', label: 'About', icon: <InfoIcon /> }}
            active={isActive('/about')}
          />

          {/* Footer — pinned under About with a top border. Numbers
              read from the export ledger so they reflect cumulative
              cataloging across sessions. */}
          <div
            style={{
              padding: '12px 16px',
              borderTop: `1px solid ${SIDE_FOOT_BORDER}`,
            }}
          >
            {stats ? (
              <div className="animate-stats-fade">
                <div style={{ fontSize: 12, color: SIDE_SECTION, lineHeight: 1.5 }}>
                  {stats.books} {stats.books === 1 ? 'book' : 'books'} cataloged
                </div>
                <div style={{ fontSize: 12, color: SIDE_SECTION, lineHeight: 1.5 }}>
                  {stats.batches} {stats.batches === 1 ? 'batch' : 'batches'} exported
                </div>
              </div>
            ) : (
              // Skeleton placeholders while the ledger sync completes.
              // Two stub bars (books / batches) at the same heights as
              // the real lines, with a subtle shimmer so it reads as
              // "loading" rather than "empty".
              <div aria-hidden className="space-y-1.5">
                <div
                  className="h-[12px] rounded animate-stats-shimmer"
                  style={{
                    width: 120,
                    background: 'linear-gradient(90deg, #1F1F1F 0%, #2A2A2A 50%, #1F1F1F 100%)',
                    backgroundSize: '200% 100%',
                  }}
                />
                <div
                  className="h-[12px] rounded animate-stats-shimmer"
                  style={{
                    width: 96,
                    background: 'linear-gradient(90deg, #1F1F1F 0%, #2A2A2A 50%, #1F1F1F 100%)',
                    backgroundSize: '200% 100%',
                  }}
                />
              </div>
            )}

            {/* Local-only mode toggle — small dev affordance below the
                lifetime stats. Tapping the row flips the flag; the
                state is reactive across both this surface and the
                mobile menu via subscribeNoWriteMode. */}
            <SidebarLocalOnlyToggle
              on={noWrite}
              onToggle={() => setNoWriteMode(!noWrite)}
            />
          </div>
        </div>
      </aside>

      {/* Content column — takes the remaining viewport width. Independent
          scroll so the sidebar stays put as the user pages through long
          tables. On phone the sidebar is gone and the mobile chrome
          (48px top bar + ~56px bottom tab bar) sits above; the responsive
          padding below clears them so the page doesn't tuck under. */}
      {/* Local-only mode indicator — a thin gold bar fixed to the very
          top of the viewport. Always visible regardless of scroll
          position, sidebar/mobile-chrome state, or which page is
          rendered. z-50 puts it above the mobile top bar (z-30) and
          the sidebar (no positioned ancestor). */}
      {noWrite && (
        <div
          aria-hidden
          className="fixed top-0 inset-x-0 z-50 pointer-events-none"
          style={{ height: 2, background: GOLD }}
        />
      )}

      <main
        className="flex-1 min-h-screen overflow-x-hidden md:!ml-[260px] pt-12 md:pt-0 pb-16 md:pb-0"
      >
        {/* Fill the remaining width — no max-w cap. The app is designed
            for the desktop screens it runs on; cap-and-center looks like
            a mobile app stretched. Phone gets tighter padding. */}
        <div className="w-full px-4 md:px-8 lg:px-12 py-4 md:py-10">{children}</div>
      </main>
    </div>
  );
}

function SidebarLocalOnlyToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="mt-3 pt-3"
      style={{ borderTop: `1px solid ${SIDE_FOOT_BORDER}` }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-pressed={on}
        aria-label={`Local-only mode (${on ? 'on' : 'off'})`}
      >
        <span
          className="flex items-center gap-1.5 flex-1 min-w-0"
          style={{ fontSize: 12, color: on ? GOLD : SIDE_TEXT, lineHeight: 1.4 }}
        >
          {on && (
            <span
              aria-hidden
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: GOLD }}
            />
          )}
          Local-only mode
        </span>
        <span
          aria-hidden
          className="flex-shrink-0 relative inline-block transition-colors"
          style={{
            width: 26,
            height: 14,
            borderRadius: 999,
            background: on ? GOLD : '#2F2F2F',
          }}
        >
          <span
            className="absolute top-[2px] inline-block transition-all"
            style={{
              left: on ? 14 : 2,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#141414',
            }}
          />
        </span>
      </button>
      <div
        style={{
          fontSize: 10,
          color: SIDE_SECTION,
          marginTop: 3,
          lineHeight: 1.4,
        }}
      >
        {on ? 'Cloud sync disabled. Local cache only.' : 'Disable cloud sync to iterate locally.'}
      </div>
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
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '1.5px',
        textTransform: 'uppercase',
        color: SIDE_SECTION,
        padding: '0 16px',
        marginTop: topGap ? 28 : 20,
        marginBottom: 8,
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
      className="flex items-center gap-[10px] transition-colors"
      style={{
        padding: '11px 16px',
        color: active ? SIDE_TEXT_ACTIVE : SIDE_TEXT,
        background: active ? SIDE_ACTIVE : 'transparent',
        borderLeft: `2px solid ${active ? NAVY : 'transparent'}`,
        fontSize: 16,
        fontWeight: 500,
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
          width: 16,
          height: 16,
          opacity: active ? 0.75 : 0.45,
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
            fontSize: 11,
            fontWeight: 500,
            background: 'rgba(196,163,90,0.18)',
            color: GOLD,
            padding: '2px 7px',
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

// Shelflist icon — three horizontal "shelves" with a faint line of
// spines on the top shelf. Reads as "library shelves in order" rather
// than the per-tag bookshelf view that BooksIcon represents.
function ShelfIcon() {
  return (
    <IconShell>
      <path d="M2 4h12" />
      <path d="M2 8.5h12" />
      <path d="M2 13h12" />
      <rect x="3" y="1.5" width="1" height="2.5" />
      <rect x="5" y="1.5" width="1" height="2.5" />
      <rect x="7" y="2" width="1" height="2" />
      <rect x="9" y="1.5" width="1" height="2.5" />
      <rect x="11" y="2" width="1" height="2" />
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

function InfoIcon() {
  return (
    <IconShell>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4" />
      <path d="M8 5v.01" />
    </IconShell>
  );
}

// ---- Brand panel ----------------------------------------------------------

/**
 * Tartan brand zone at the top of the sidebar. Two CSS
 * repeating-linear-gradients (180deg warp, 90deg weft) layer over a
 * navy ground to create the cross-hatch weave; the SpineStackLogo +
 * wordmark sit on top. The gradients are sized to a 64px tile so the
 * pattern repeats cleanly across the 260px-wide sidebar.
 */
function BrandPanel() {
  // Clan colors with per-stripe alpha. Two passes produce the plaid:
  // a warp (vertical bands) layered over a weft (horizontal bands).
  // A radial-gradient vignette sits on top of those two but still in
  // the background layer (so the text in foreground wins paint
  // order). The vignette is centered at 50%×45% — matching where
  // the content block lives — so it darkens just the area behind
  // the wordmark without a hard-edged box.
  const tartanLayers = [
    'radial-gradient(ellipse at center 45%,' +
      'rgba(0,0,0,0.45) 0%,' +
      'transparent 70%)',
    'repeating-linear-gradient(180deg,' +
      'rgba(196,163,90,0.55) 0px 4px,' +
      'transparent 4px 14px,' +
      'rgba(45,90,58,0.50) 14px 20px,' +
      'transparent 20px 26px,' +
      'rgba(20,20,20,0.55) 26px 36px,' +
      'transparent 36px 42px,' +
      'rgba(184,50,50,0.55) 42px 48px,' +
      'transparent 48px 54px,' +
      'rgba(196,163,90,0.55) 54px 58px,' +
      'transparent 58px 64px)',
    'repeating-linear-gradient(90deg,' +
      'rgba(196,163,90,0.40) 0px 4px,' +
      'transparent 4px 18px,' +
      'rgba(45,90,58,0.40) 18px 24px,' +
      'transparent 24px 30px,' +
      'rgba(20,20,20,0.45) 30px 40px,' +
      'transparent 40px 46px,' +
      'rgba(184,50,50,0.40) 46px 52px,' +
      'transparent 52px 58px,' +
      'rgba(196,163,90,0.40) 58px 62px,' +
      'transparent 62px 64px)',
  ].join(',');

  return (
    <Link
      href="/upload"
      className="cursor-pointer group block relative"
      style={{
        // True square — width matches sidebar (260), height equals
        // width so the panel is a perfect 260×260 tile.
        width: SIDEBAR_W,
        height: SIDEBAR_W,
        backgroundColor: NAVY,
        backgroundImage: tartanLayers,
      }}
      aria-label="Carnegie — go to Upload"
    >
      {/* Inner block positioned at 45% from top (slightly above true
          center) and horizontally centered. Translate keeps the
          block centered around its midpoint regardless of how the
          wordmark wraps. */}
      <div
        className="flex flex-col items-center"
        style={{
          position: 'absolute',
          top: '45%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          gap: 18,
          width: '100%',
          padding: '0 24px',
          textAlign: 'center',
        }}
      >
        <SpineStackLogo />
        <span className="flex flex-col items-center leading-none">
          <span
            style={{
              fontFamily:
                '"Arial Black", "Helvetica Neue", Arial, system-ui, sans-serif',
              fontSize: 22,
              fontWeight: 900,
              color: '#FFFFFF',
              letterSpacing: '4px',
              textTransform: 'uppercase',
            }}
          >
            Carnegie
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.75)',
              letterSpacing: '2.5px',
              textTransform: 'uppercase',
              marginTop: 8,
            }}
          >
            Cataloging System
          </span>
        </span>
      </div>
    </Link>
  );
}

/**
 * 56×56 rounded-square tile with a stack of four colored bars
 * representing book spines on a shelf. Clean palette — no tartan
 * inside the tile so the brand mark stays legible at all scales.
 *
 *   gold   #C4A35A  tallest
 *   blue   #5B8DB8
 *   red    #B83232
 *   gray   #8A8A84  shortest
 *
 * Bars are 7px wide with 3px gaps; total stack width = 7×4 + 3×3
 * = 37px, leaving ~9px padding on each side of the 56px tile. The
 * 56-from-40 bump keeps everything in the same visual proportions
 * the smaller version had — bar widths and gaps both scale 1.4×,
 * heights scale 1.4× (rounded to integer pixels).
 */
function SpineStackLogo() {
  const bars: { color: string; height: number }[] = [
    { color: '#C4A35A', height: 42 },
    { color: '#5B8DB8', height: 36 },
    { color: '#B83232', height: 30 },
    { color: '#8A8A84', height: 24 },
  ];
  return (
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: 11,
        background: '#141414',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        flexShrink: 0,
      }}
      aria-hidden
    >
      {bars.map((b, i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: b.height,
            background: b.color,
            borderRadius: 1.5,
          }}
        />
      ))}
    </div>
  );
}
