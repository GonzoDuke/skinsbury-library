'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Click-to-edit batch label, sized for page-header use on Review and
 * Export. Click the label text to swap to an input pre-populated with
 * the current value. Enter or blur commits, Escape cancels.
 *
 * Distinct from the field-level Editable component (used inside book
 * rows) — this one is bigger, has no surrounding label/affordance
 * scaffolding, and is meant to read as the page heading itself.
 */
export function EditableBatchLabel({
  value,
  onSave,
  size = 'md',
  placeholder,
}: {
  value: string;
  onSave: (next: string) => void;
  /** 'lg' = page-title scale. 'md' = card-title scale (Export).
   *  'sm' = inline chip scale (Review batch strip). */
  size?: 'sm' | 'md' | 'lg';
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync draft when the upstream value changes externally — but only
  // when we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function start() {
    cancelledRef.current = false;
    setDraft(value);
    setEditing(true);
    window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
  }
  function commit() {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setEditing(false);
      return;
    }
    const next = draft.trim();
    // Empty after-trim is treated as "no change" — we never persist an
    // empty label here. The user can clear out and type something else
    // before pressing Enter.
    if (next && next !== value) onSave(next);
    setEditing(false);
  }
  function cancel() {
    cancelledRef.current = true;
    setDraft(value);
    setEditing(false);
  }

  const sizeClasses =
    size === 'lg'
      ? // Matches typo-page-title for page-heading substitution.
        'typo-page-title'
      : size === 'md'
        ? // Matches typo-card-title for inline placement (Export).
          'typo-card-title'
        : // Inline chip for the Review batch strip — 13px / weight 500.
          'text-[13px] font-medium text-text-primary leading-snug';

  // Edit-mode input mirrors the display size so the swap doesn't shift
  // the layout. Width fills the available container; the parent can
  // constrain via max-w-* if needed.
  if (editing) {
    return (
      <input
        ref={inputRef}
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
        aria-label="Batch label"
        className={`${sizeClasses} w-full bg-transparent border-b-2 border-navy outline-none px-0 py-0 m-0`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      title="Click to rename this batch"
      aria-label={`Edit batch label: ${value}`}
      className={`${sizeClasses} text-left bg-transparent border-b-2 border-transparent hover:border-line cursor-text transition-colors p-0 m-0`}
    >
      {value || (
        <span className="italic text-text-tertiary">
          {placeholder ?? 'Untitled batch'}
        </span>
      )}
    </button>
  );
}
