'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Click-to-edit field. Click the value text to swap to an input
 * pre-populated with the current string; Enter or blur commits, Escape
 * cancels and reverts. The save callback receives the raw input string;
 * the caller is responsible for trim / parse / case-coerce.
 *
 * Shared between the desktop Review row's detail panel (BookTableRow) and
 * the phone Review card's expanded view (MobileBookCard).
 */
export function Editable({
  label,
  value,
  placeholder,
  onSave,
  mono,
  multiline,
  suffix,
  className,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (raw: string) => void;
  mono?: boolean;
  multiline?: boolean;
  suffix?: string | null;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Keep draft in sync whenever the upstream value changes (e.g. another
  // tab updated this book) — but only when we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function start() {
    cancelledRef.current = false;
    setDraft(value);
    setEditing(true);
    // Focus + select after the input mounts.
    window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if ('select' in el) el.select();
    }, 0);
  }
  function commit() {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setEditing(false);
      return;
    }
    if (draft !== value) onSave(draft);
    setEditing(false);
  }
  function cancel() {
    cancelledRef.current = true;
    setDraft(value);
    setEditing(false);
  }

  const inputClass = `w-full bg-surface-card border border-navy/60 rounded-md px-2 py-1 text-[12px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy ${
    mono ? 'font-mono text-[11px]' : ''
  }`;

  if (editing) {
    return (
      <div className={`min-w-0 ${className ?? ''}`}>
        <div className="flex items-center justify-between mb-0.5">
          <span className="typo-label">{label}</span>
          <span className="text-[9px] text-text-tertiary italic">
            Enter to save · Esc to cancel
          </span>
        </div>
        {multiline ? (
          <textarea
            ref={(el) => {
              inputRef.current = el;
            }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
              // Cmd/Ctrl+Enter saves a multiline; bare Enter inserts a newline.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            rows={3}
            placeholder={placeholder}
            className={`${inputClass} resize-y`}
          />
        ) : (
          <input
            ref={(el) => {
              inputRef.current = el;
            }}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            placeholder={placeholder}
            className={inputClass}
          />
        )}
      </div>
    );
  }

  const empty = !value;
  return (
    <div className={`min-w-0 group ${className ?? ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="typo-label">{label}</span>
        {suffix && (
          <span className="text-[9px] uppercase tracking-wider text-text-tertiary">
            {suffix}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={start}
        title="Click to edit"
        className={`mt-0.5 text-left w-full text-[12px] truncate cursor-text rounded px-1.5 py-1 -mx-1.5 -my-1 hover:bg-surface-card transition-colors ${
          mono ? 'font-mono text-[11px]' : ''
        } ${empty ? 'text-text-quaternary italic' : 'text-text-primary'}`}
      >
        {empty ? placeholder ?? '—' : value}
      </button>
    </div>
  );
}

export function ReadOnlyField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  /** Render the value in JetBrains Mono — useful for fixed-width data
   *  like DDC numbers, ISBNs, page counts of long classifications. */
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span className="typo-label">{label}</span>
      <div
        className={`mt-0.5 text-[12px] text-text-secondary truncate${mono ? ' font-mono' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}
