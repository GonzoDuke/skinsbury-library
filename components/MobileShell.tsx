'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { confirmDiscardSession } from '@/lib/session';
import {
  isNoWriteMode,
  setNoWriteMode,
  subscribeNoWriteMode,
} from '@/lib/no-write-mode';
import { fireUndo } from './UndoToast';

const NAVY = '#1B3A5C';
const GOLD = '#C4A35A';

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

  // Local-only mode: reactive so the indicator dot on the settings
  // icon and the toggle row in the menu both reflect in-tab + cross-tab flips.
  const [noWrite, setNoWrite] = useState(false);
  useEffect(() => {
    setNoWrite(isNoWriteMode());
    return subscribeNoWriteMode(() => setNoWrite(isNoWriteMode()));
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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

  // Bottom tab bar — five primary destinations. Workflow (Upload /
  // Review / Export) plus Library (Shelflist / Vocabulary). History
  // is reached via the Export page's "Past exports →" link, not the
  // tab bar. Five tabs is tight on phones but each still hits the
  // 48px iOS-minimum height; labels hide below 360px via the
  // existing max-[359px]:hidden rule.
  const tabs: TabDef[] = [
    { href: '/upload', label: 'Upload', icon: <CameraIcon /> },
    { href: '/review', label: 'Review', icon: <ReviewIcon /> },
    { href: '/export', label: 'Export', icon: <ExportIcon /> },
    { href: '/shelflist', label: 'Shelflist', icon: <ShelfIcon /> },
    { href: '/vocabulary', label: 'Vocab', icon: <VocabIcon /> },
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
          {/* Settings menu — gear icon. A small gold dot overlays the
              icon when local-only mode is on so the indicator is always
              visible from the phone chrome. */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Settings"
              aria-expanded={menuOpen}
              className="flex items-center justify-center w-9 h-9 rounded-full transition relative"
              style={{
                color: 'rgba(255,255,255,0.85)',
                background: 'rgba(255,255,255,0.08)',
              }}
            >
              <GearIcon />
              {noWrite && (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 inline-block w-2 h-2 rounded-full"
                  style={{ background: GOLD }}
                />
              )}
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-11 z-40 rounded-md shadow-xl border"
                style={{
                  width: 240,
                  background: '#1F1F1F',
                  borderColor: '#2F2F2F',
                  padding: 10,
                }}
              >
                <button
                  type="button"
                  onClick={() => setNoWriteMode(!noWrite)}
                  className="w-full flex items-center justify-between gap-2 text-left p-2 rounded hover:bg-white/5 transition"
                  aria-pressed={noWrite}
                >
                  <span
                    className="flex items-center gap-1.5 flex-1 min-w-0"
                    style={{ fontSize: 13, color: noWrite ? GOLD : '#E0E0E0', lineHeight: 1.4 }}
                  >
                    {noWrite && (
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
                      width: 28,
                      height: 16,
                      borderRadius: 999,
                      background: noWrite ? GOLD : '#2F2F2F',
                    }}
                  >
                    <span
                      className="absolute top-[2px] inline-block transition-all"
                      style={{
                        left: noWrite ? 14 : 2,
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        background: '#141414',
                      }}
                    />
                  </span>
                </button>
                <div
                  style={{
                    fontSize: 11,
                    color: '#707070',
                    padding: '0 8px 4px',
                    marginTop: 2,
                    lineHeight: 1.4,
                  }}
                >
                  {noWrite
                    ? 'Cloud sync disabled. Local cache only.'
                    : 'Disable cloud sync to iterate locally.'}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Bottom tab bar — four primary tabs evenly spaced. iOS adds a
          home-indicator inset; honor it via env(safe-area-inset-bottom)
          so the labels don't get clipped on a real device. */}
      <nav
        className="fixed bottom-0 inset-x-0 z-30 grid grid-cols-5 border-t border-line-light bg-surface-card"
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

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="18"
      height="18"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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

// Shelflist tab icon — three horizontal shelves with spine ticks on
// the top one. Reads as "library shelves in order" rather than the
// per-tag bookshelf view that VocabIcon represents.
function ShelfIcon() {
  return (
    <IconShell>
      <path d="M3 6h18" />
      <path d="M3 12h18" />
      <path d="M3 18h18" />
      <rect x="5" y="2.5" width="1.5" height="3.5" />
      <rect x="8" y="2.5" width="1.5" height="3.5" />
      <rect x="11" y="3" width="1.5" height="3" />
      <rect x="14" y="2.5" width="1.5" height="3.5" />
      <rect x="17" y="3" width="1.5" height="3" />
    </IconShell>
  );
}

// Vocabulary tab icon — book + tag glyph. Two stacked spines on the
// left, a small tag on the right for the per-tag library-management
// register.
function VocabIcon() {
  return (
    <IconShell>
      <rect x="3" y="3" width="4" height="18" rx="0.7" />
      <rect x="8.5" y="3" width="4" height="18" rx="0.7" />
      <path d="M14.5 8l5 5-3 3-5-5z" />
      <circle cx="16" cy="10" r="0.8" fill="currentColor" />
    </IconShell>
  );
}
