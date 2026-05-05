'use client';

import { useEffect, useRef, useState } from 'react';
import type { BookRecord } from '@/lib/types';

/**
 * Six canonical formats, plus "Other" which reveals a free-text input.
 * The order is rough conventional ranking — most users hit "Hardcover"
 * or "Paperback" first.
 */
const CANONICAL_FORMATS = [
  'Hardcover',
  'Paperback',
  'Trade Paperback',
  'Mass Market Paperback',
  'Library Binding',
  'Spiral-bound',
] as const;

export interface AddCopySubmit {
  /** The chosen format string. Either a canonical option or the free-text
   *  "Other" value. Always non-empty when this fires. */
  format: string;
  /** ISBN for the new copy. Empty string means "use the parent's ISBN". */
  isbn: string;
  /** Notes for the new copy. Empty string means "no notes" (no auto-prefix). */
  notes: string;
  /** When the parent had no format and the user filled in the retroactive
   *  field, this is the format to set on the parent too. Undefined when
   *  the parent already had a format or the user left the field blank. */
  retroactiveParentFormat?: string;
}

interface Props {
  /** The book being copied — used for header context + retroactive-format gating. */
  source: BookRecord;
  onSubmit: (values: AddCopySubmit) => void;
  onClose: () => void;
}

const ISBN_PATTERN = /^[\dxX]{10}([\dxX]{3})?$/;

export function AddCopyModal({ source, onSubmit, onClose }: Props) {
  const [format, setFormat] = useState<string>('Hardcover');
  const [otherFormat, setOtherFormat] = useState('');
  const [isbn, setIsbn] = useState('');
  const [notes, setNotes] = useState('');
  const [retroactive, setRetroactive] = useState<string>('');
  const formatSelectRef = useRef<HTMLSelectElement>(null);

  // Autofocus the format dropdown on open — it's the primary decision.
  useEffect(() => {
    formatSelectRef.current?.focus();
  }, []);

  // ESC closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isOther = format === 'Other';
  const cleanIsbn = isbn.replace(/[^\dxX]/g, '');
  const isbnFilled = cleanIsbn.length > 0;
  const isbnValid = !isbnFilled || ISBN_PATTERN.test(cleanIsbn);
  const resolvedFormat = isOther ? otherFormat.trim() : format;
  const canSubmit = resolvedFormat.length > 0 && isbnValid;

  // Spec: the retroactive field only renders when the parent has no format.
  const showRetroactive = !source.format;

  function handleSubmit() {
    if (!canSubmit) return;
    const retroTrimmed = retroactive.trim();
    onSubmit({
      format: resolvedFormat,
      isbn: cleanIsbn,
      notes: notes.trim(),
      retroactiveParentFormat:
        showRetroactive && retroTrimmed ? retroTrimmed : undefined,
    });
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end md:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Add a copy of this book"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm animate-backdrop-in" />

      <div
        className={
          'relative w-full md:w-[480px] max-w-full ' +
          'bg-surface-card rounded-t-2xl md:rounded-2xl shadow-2xl ' +
          'animate-modal-in p-5 md:p-6 max-h-[92vh] overflow-y-auto'
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="typo-page-title text-[22px] md:text-[26px]">Add a copy</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-tertiary hover:text-ink dark:hover:text-cream-50 text-2xl px-2 -mt-1 -mr-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="text-[13px] text-text-secondary leading-relaxed mb-4">
          {source.title ? <>Adding a copy of <strong>{source.title}</strong>.</> : 'Adding a copy.'}{' '}
          The new copy is its own row on Review and exports as its own CSV
          line. Fields you leave blank inherit from the original.
        </p>

        {/* Format — primary decision */}
        <label className="block">
          <span className="block typo-label mb-1">Format</span>
          <select
            ref={formatSelectRef}
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="w-full px-3 py-2.5 text-[14px] bg-surface-page rounded-md border border-line focus:outline-none focus:border-navy focus:ring-1 focus:ring-navy transition"
          >
            {CANONICAL_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value="Other">Other (specify)</option>
          </select>
        </label>

        {isOther && (
          <label className="block mt-2">
            <span className="block typo-label mb-1">Specify format</span>
            <input
              type="text"
              autoComplete="off"
              value={otherFormat}
              onChange={(e) => setOtherFormat(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) handleSubmit();
              }}
              placeholder="Vellum-bound 1923 edition"
              className="w-full px-3 py-2.5 text-[14px] bg-surface-page rounded-md border border-line focus:outline-none focus:border-navy focus:ring-1 focus:ring-navy transition"
            />
          </label>
        )}

        {/* Retroactive format — only when parent has none */}
        {showRetroactive && (
          <label className="block mt-3">
            <span className="block typo-label mb-1">
              Format of the existing copy
            </span>
            <select
              value={retroactive}
              onChange={(e) => setRetroactive(e.target.value)}
              className="w-full px-3 py-2.5 text-[14px] bg-surface-page rounded-md border border-line focus:outline-none focus:border-navy focus:ring-1 focus:ring-navy transition"
            >
              <option value="">— Don&rsquo;t set —</option>
              {CANONICAL_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <span className="block text-[11px] text-text-quaternary mt-1">
              Optional. Sets the original copy&rsquo;s format too, since
              you&rsquo;re engaged with format right now.
            </span>
          </label>
        )}

        {/* ISBN */}
        <label className="block mt-3">
          <span className="block typo-label mb-1">ISBN (optional)</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={isbn}
            onChange={(e) => setIsbn(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) handleSubmit();
            }}
            placeholder={
              source.isbn
                ? `Defaults to ${source.isbn} (the original copy's ISBN)`
                : 'Leave blank if unknown'
            }
            className={
              'w-full px-3 py-2.5 text-[14px] font-mono bg-surface-page rounded-md border focus:outline-none focus:ring-1 transition ' +
              (isbnValid
                ? 'border-line focus:border-navy focus:ring-navy'
                : 'border-mahogany focus:border-mahogany focus:ring-mahogany')
            }
          />
          {!isbnValid && (
            <span className="block text-[12px] text-mahogany mt-1">
              ISBN must be 10 or 13 digits.
            </span>
          )}
        </label>

        {/* Notes */}
        <label className="block mt-3">
          <span className="block typo-label mb-1">Notes (optional)</span>
          <input
            type="text"
            autoComplete="off"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) handleSubmit();
            }}
            placeholder="Gift from Sam, 2018"
            className="w-full px-3 py-2.5 text-[14px] bg-surface-page rounded-md border border-line focus:outline-none focus:border-navy focus:ring-1 focus:ring-navy transition"
          />
        </label>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-[14px] rounded-md border border-line text-text-secondary hover:bg-surface-page transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-[14px] rounded-md bg-navy text-white font-semibold hover:bg-navy-deep disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            Add copy
          </button>
        </div>
      </div>
    </div>
  );
}
