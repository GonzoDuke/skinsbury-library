'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useStore } from '@/lib/store';
import { confirmDiscardSession } from '@/lib/session';
import { fireUndo } from './UndoToast';

const NAVY = '#1B3A5C';

interface TabDef {
  href: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * Phone-only chrome — a 48px top bar with the Carnegie wordmark, and a
 * 56px bottom tab bar with three primary destinations (Capture / Review /
 * Export). No children: AppShell renders the page content separately
 * inside its responsive `<main>`, with top + bottom padding reserved here.
 *
 * Vocabulary and History intentionally don't appear in the bottom bar —
 * they're library-management screens that belong on the larger desktop /
 * tablet layout.
 */
export function MobileShell() {
  const pathname = usePathname();
  const { state, clear, addBatch } = useStore();

  const sessionEmpty =
    state.allBooks.length === 0 && state.batches.length === 0;

  function onNewSession() {
    if (!confirmDiscardSession(state.allBooks)) return;
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

  // Tab order: Collection (the front door) is first; the rest of the
  // workflow follows. Vocab dropped from the bottom tab bar to keep it
  // 4-wide on phones — vocab is reachable from the Collection page
  // header links and from the desktop sidebar. Capture relabelled to
  // Upload and pointed at /upload (the legacy `/` is a redirect to
  // /collection).
  const tabs: TabDef[] = [
    { href: '/collection', label: 'Collection', icon: <CollectionIcon /> },
    { href: '/upload', label: 'Upload', icon: <CameraIcon /> },
    { href: '/review', label: 'Review', icon: <ReviewIcon /> },
    { href: '/export', label: 'Export', icon: <ExportIcon /> },
  ];

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <>
      {/* Top bar — small spine-stack mark + CARNEGIE wordmark + a
          right-aligned New-session icon button. The button mirrors the
          desktop sidebar's behavior: confirmation dialog when there's
          unprocessed/unapproved work, then clears every batch and
          resets to a fresh Capture screen. */}
      <header
        className="fixed top-0 inset-x-0 z-30 flex items-center gap-2 px-4"
        style={{ height: 48, background: NAVY }}
      >
        <MiniSpineStack />
        <span
          style={{
            fontFamily: '"Arial Black", "Helvetica Neue", Arial, system-ui, sans-serif',
            fontSize: 15,
            fontWeight: 900,
            color: '#FFFFFF',
            letterSpacing: '3px',
            textTransform: 'uppercase',
          }}
        >
          Carnegie
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href="/about"
            aria-label="About"
            className="flex items-center justify-center w-9 h-9 rounded-full transition"
            style={{
              color: 'rgba(255,255,255,0.85)',
              background: 'rgba(255,255,255,0.08)',
            }}
          >
            <InfoIcon />
          </Link>
          <button
            type="button"
            onClick={onNewSession}
            disabled={sessionEmpty}
            aria-label="New session"
            title="Discard the current batch and start fresh — exported books stay in the ledger."
            className="flex items-center justify-center w-9 h-9 rounded-full transition disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              color: 'rgba(255,255,255,0.85)',
              background: 'rgba(255,255,255,0.08)',
            }}
          >
            <NewSessionIcon />
          </button>
        </div>
      </header>

      {/* Bottom tab bar — four primary tabs evenly spaced. iOS adds a
          home-indicator inset; honor it via env(safe-area-inset-bottom)
          so the labels don't get clipped on a real device. */}
      <nav
        className="fixed bottom-0 inset-x-0 z-30 grid grid-cols-4 border-t border-line-light bg-surface-card"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
        aria-label="Primary"
      >
        {tabs.map((t) => {
          const active = isActive(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-label={t.label}
              // py-2.5 + ~22-26px icon + label keeps every tab >= 48px
              // tall on a real phone — comfortably above the 44px iOS
              // minimum. The Link itself fills its grid column so the
              // tap target spans the full quarter of the viewport.
              className="flex flex-col items-center justify-center gap-1 py-2.5 min-h-[48px] text-[12px] transition-colors"
              style={{
                color: active ? NAVY : '#707070',
                fontWeight: 500,
                background: active ? 'rgba(27,58,92,0.06)' : 'transparent',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  opacity: active ? 0.9 : 0.6,
                }}
                // Icon scales up when the label is hidden under 360px so
                // the tab still reads as a real target.
                className="w-[22px] h-[22px] max-[359px]:w-[26px] max-[359px]:h-[26px]"
              >
                {t.icon}
              </span>
              <span className="max-[359px]:hidden">{t.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function MiniSpineStack() {
  // Half-scale of the sidebar's SpineStackLogo so the wordmark dominates
  // the 48px top bar. 28px tile, 4 bars, 4px wide.
  const bars: { color: string; height: number }[] = [
    { color: '#C4A35A', height: 21 },
    { color: '#5B8DB8', height: 18 },
    { color: '#B83232', height: 15 },
    { color: '#8A8A84', height: 12 },
  ];
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 5,
        background: '#141414',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        flexShrink: 0,
      }}
      aria-hidden
    >
      {bars.map((b, i) => (
        <span
          key={i}
          style={{
            width: 3.5,
            height: b.height,
            background: b.color,
            borderRadius: 0.75,
          }}
        />
      ))}
    </div>
  );
}

function IconShell({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
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

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="18"
      height="18"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8v.01" />
    </svg>
  );
}

function NewSessionIcon() {
  // Circular-arrow refresh glyph. Reads as "start over" without the
  // destructive connotation of an X.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="18"
      height="18"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <IconShell>
      <path d="M3 8h3l2-2h8l2 2h3v11H3z" />
      <circle cx="12" cy="13" r="4" />
    </IconShell>
  );
}

function ReviewIcon() {
  return (
    <IconShell>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 8h10M7 12h10M7 16h6" />
    </IconShell>
  );
}

function ExportIcon() {
  return (
    <IconShell>
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M3 17v4h18v-4" />
    </IconShell>
  );
}

// Collection tab icon — 5 short spines, the "all of it" view.
function CollectionIcon() {
  return (
    <IconShell>
      <rect x="2" y="3" width="3" height="18" rx="0.6" />
      <rect x="6.5" y="5" width="3" height="16" rx="0.6" />
      <rect x="11" y="3" width="3" height="18" rx="0.6" />
      <rect x="15.5" y="6" width="3" height="15" rx="0.6" />
      <rect x="20" y="4" width="2.5" height="17" rx="0.6" />
    </IconShell>
  );
}
