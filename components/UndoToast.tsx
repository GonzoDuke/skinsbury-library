'use client';

/**
 * Global undo-toast surface. Any caller fires `fireUndo(message, undo)`
 * — this component listens via a window CustomEvent so it doesn't need
 * a context / provider. Replaces any prior toast on a new fire so
 * consecutive destructive actions don't stack into a queue. The toast
 * auto-dismisses after 5s; clicking Undo runs the supplied callback
 * before dismissing.
 *
 * Mounted once in app/layout.tsx so every route inherits it.
 */

import { useEffect, useState } from 'react';

interface ToastState {
  id: number;
  message: string;
  undo: () => void;
}

export function fireUndo(message: string, undo: () => void) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('carnegie:undo', { detail: { message, undo } })
  );
}

export function UndoToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(5);

  useEffect(() => {
    let cancelTimer: number | null = null;
    let cancelTick: number | null = null;
    function onUndo(e: Event) {
      const detail = (e as CustomEvent<{ message: string; undo: () => void }>).detail;
      if (!detail) return;
      // Cancel any in-flight timer so a new toast resets the 5s window.
      if (cancelTimer !== null) {
        window.clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      if (cancelTick !== null) {
        window.clearInterval(cancelTick);
        cancelTick = null;
      }
      setToast({ id: Date.now() + Math.random(), message: detail.message, undo: detail.undo });
      setSecondsLeft(5);
      cancelTick = window.setInterval(() => {
        setSecondsLeft((s) => Math.max(0, s - 1));
      }, 1000);
      cancelTimer = window.setTimeout(() => {
        setToast(null);
        if (cancelTick !== null) {
          window.clearInterval(cancelTick);
          cancelTick = null;
        }
      }, 5000);
    }
    window.addEventListener('carnegie:undo', onUndo);
    return () => {
      window.removeEventListener('carnegie:undo', onUndo);
      if (cancelTimer !== null) window.clearTimeout(cancelTimer);
      if (cancelTick !== null) window.clearInterval(cancelTick);
    };
  }, []);

  if (!toast) return null;

  function onUndoClick() {
    if (toast) {
      try {
        toast.undo();
      } catch {
        // Best-effort — destructive action callers handle their own
        // failure modes; we just need to not crash the toast.
      }
    }
    setToast(null);
  }

  // Manual dismiss = same outcome as the timer expiring: the
  // destructive action stays committed, the toast just goes away
  // on the user's terms.
  function onDismissClick() {
    setToast(null);
  }

  return (
    <div
      role="status"
      className="fixed z-[60] pointer-events-none"
      style={{
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
      }}
    >
      <div className="pointer-events-auto bg-ink dark:bg-cream-50 text-cream-50 dark:text-ink rounded-md shadow-lg pl-4 pr-1.5 py-2.5 flex items-center gap-3 max-w-[min(94vw,520px)]">
        <span className="text-[13px] flex-1 truncate">{toast.message}</span>
        <button
          type="button"
          onClick={onUndoClick}
          className="text-[12px] font-semibold uppercase tracking-wider px-2 py-1 rounded text-brass hover:text-limestone transition flex-shrink-0"
        >
          Undo
        </button>
        <span className="text-[10px] font-mono text-cream-300 dark:text-ink-soft tabular-nums w-4 text-right flex-shrink-0">
          {secondsLeft}
        </span>
        <button
          type="button"
          onClick={onDismissClick}
          aria-label="Dismiss"
          // 32px tap target so it clears the WCAG / iOS minimum.
          // Subtle by default; brightens on hover so it reads as a
          // real control without competing with the Undo CTA.
          className="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-[16px] leading-none text-cream-300 dark:text-ink-soft hover:text-cream-50 dark:hover:text-ink hover:bg-white/10 dark:hover:bg-black/10 transition"
        >
          ×
        </button>
      </div>
    </div>
  );
}
