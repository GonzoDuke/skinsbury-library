'use client';

import { useEffect, useRef, useState } from 'react';
import type { BookRecord, Confidence } from '@/lib/types';
import { useStore } from '@/lib/store';
import { toAuthorLastFirst, toTitleCase } from '@/lib/csv-export';
import { TagChip } from './TagChip';
import { TagPicker } from './TagPicker';
import { Cover } from './Cover';

/**
 * Defensive stringifier for a warning entry. Any non-primitive that
 * sneaks into book.warnings (legacy localStorage state, a malformed
 * push site, etc) gets coerced to a stringified JSON dump rather than
 * being passed to React as a child — which is what triggers the
 * "Objects are not valid as a React child" #418 error in production.
 */
function stringifyWarning(w: unknown): string {
  if (typeof w === 'string') return w;
  if (w == null) return '';
  if (typeof w === 'number' || typeof w === 'boolean') return String(w);
  try {
    return JSON.stringify(w);
  } catch {
    return '[unrenderable warning]';
  }
}

/**
 * One row in the compact Review table — collapsed: cover, title + meta line,
 * confidence badge, tag pills (truncated), ✓ / ✕ buttons. Click anywhere on
 * the row to toggle the detail panel below it (publisher, LCC + provenance
 * badge, source / spine number, batch label, full tag list with add/remove,
 * Reread button).
 *
 * Per the v3 redesign §4: warnings collapse to a single inline amber dot
 * before the title; the full-width warning banners that lived on the card
 * version are gone.
 */
export function BookTableRow({ book }: { book: BookRecord }) {
  const { updateBook, rereadBook } = useStore();
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<'genre' | 'form' | null>(null);
  const [rereading, setRereading] = useState(false);
  const [rereadErr, setRereadErr] = useState<string | null>(null);

  const hasWarning =
    (Array.isArray(book.warnings) && book.warnings.length > 0) ||
    !!book.previouslyExported ||
    !!(book.duplicateGroup && !book.duplicateResolved) ||
    book.confidence === 'LOW';

  const isApproved = book.status === 'approved';
  const isRejected = book.status === 'rejected';

  // Defensive guards: a corrupt persisted BookRecord can in principle
  // arrive with non-array tag fields. Default to empty arrays so the
  // .slice / .length math below can't throw.
  const safeGenre = Array.isArray(book.genreTags) ? book.genreTags : [];
  const safeForm = Array.isArray(book.formTags) ? book.formTags : [];
  const tagsCondensed = safeGenre.slice(0, 2);
  const tagsExtra = safeGenre.length + safeForm.length - tagsCondensed.length;

  function setStatus(next: 'approved' | 'rejected') {
    updateBook(book.id, { status: book.status === next ? 'pending' : next });
  }

  function addTag(variant: 'genre' | 'form', tag: string) {
    if (variant === 'genre') {
      updateBook(book.id, { genreTags: [...safeGenre, tag] });
    } else {
      updateBook(book.id, { formTags: [...safeForm, tag] });
    }
  }
  function removeTag(variant: 'genre' | 'form', tag: string) {
    if (variant === 'genre') {
      updateBook(book.id, { genreTags: safeGenre.filter((t) => t !== tag) });
    } else {
      updateBook(book.id, { formTags: safeForm.filter((t) => t !== tag) });
    }
  }

  async function onReread() {
    if (rereading) return;
    setRereading(true);
    setRereadErr(null);
    const r = await rereadBook(book.id, {});
    setRereading(false);
    if (!r.ok) setRereadErr(r.error ?? 'Reread failed.');
  }

  // Provenance label for the LCC line in the detail panel.
  const lccProvenance =
    book.lccSource === 'spine'
      ? 'from spine'
      : book.lccSource === 'loc'
        ? 'from LoC'
        : book.lccSource === 'wikidata'
          ? 'from Wikidata'
          : book.lccSource === 'inferred'
            ? 'AI-inferred'
            : null;

  // Single-color row tint by status. Approved rows get a faint gold wash;
  // rejected rows dim. Hover only fires on pending rows so the status
  // signal isn't muddied by a hover state.
  const rowTint = isApproved
    ? 'bg-[#FAF4E5] dark:bg-[#3A2F1B]/60'
    : isRejected
      ? 'opacity-30'
      : 'hover:bg-surface-card-hover';

  return (
    <>
      <div
        onClick={() => setOpen((v) => !v)}
        className={`grid grid-cols-[52px_1fr_80px_200px_100px] items-center gap-3 px-[14px] py-[10px] border-b border-line-light cursor-pointer transition-colors ${rowTint}`}
        role="button"
        aria-expanded={open}
      >
        {/* Cover — Cover component handles the load-fail fallback chain */}
        <Cover
          coverUrl={book.coverUrl}
          spineThumbnail={book.spineThumbnail}
          alt={book.title || 'unknown book'}
          className="w-9 h-[52px] rounded bg-surface-page border border-line-light overflow-hidden"
        />

        {/* Title + metadata */}
        <div className="min-w-0 pr-2">
          <div className="typo-card-title truncate">
            {hasWarning && (
              <span
                aria-hidden
                title="This book needs attention — open to review."
                className="inline-block w-[5px] h-[5px] rounded-full bg-carnegie-amber mr-1.5 align-middle"
              />
            )}
            {book.title || <span className="italic opacity-60">Untitled spine</span>}
          </div>
          <div className="text-[11px] text-text-tertiary mt-0.5 truncate">
            {book.author || 'Unknown author'}
            {book.isbn && (
              <>
                <span className="mx-1.5 text-text-quaternary">·</span>
                <span className="font-mono text-[10px]">{book.isbn}</span>
              </>
            )}
            {book.publicationYear ? (
              <>
                <span className="mx-1.5 text-text-quaternary">·</span>
                {book.publicationYear}
              </>
            ) : null}
          </div>
        </div>

        {/* Confidence */}
        <div>
          <ConfChip level={book.confidence} />
        </div>

        {/* Tags (compact) */}
        <div className="flex items-center gap-1 overflow-hidden">
          {tagsCondensed.map((t) => {
            const tag = String(t);
            return <TagChip key={tag} tag={tag} variant="genre" size="sm" />;
          })}
          {tagsExtra > 0 && (
            <span className="text-[10px] text-text-quaternary">+{tagsExtra}</span>
          )}
        </div>

        {/* Actions — small ✓ ✕. Inline editing happens in the detail
            panel below, so no separate Edit button. */}
        <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setStatus('approved')}
            disabled={rereading}
            aria-label="Approve"
            className={`w-7 h-7 rounded text-xs font-semibold border transition ${
              isApproved
                ? 'bg-carnegie-gold border-carnegie-gold text-text-primary'
                : 'border-line text-text-tertiary hover:border-navy hover:text-navy hover:bg-navy-soft'
            }`}
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => setStatus('rejected')}
            disabled={rereading}
            aria-label="Reject"
            className={`w-7 h-7 rounded text-xs font-semibold border transition ${
              isRejected
                ? 'bg-carnegie-red-soft border-carnegie-red text-carnegie-red'
                : 'border-line text-text-tertiary hover:border-carnegie-red hover:text-carnegie-red hover:bg-carnegie-red-soft'
            }`}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Detail panel — every metadata field is click-to-edit. Click the
          value to open an inline input pre-populated with the current
          string; Enter / blur saves, Escape cancels. Tags use the
          existing pill add/remove flow below. */}
      {open && (
        <div className="bg-surface-page px-[66px] py-[14px] border-b border-line">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5 mb-3">
            <Editable
              label="Title"
              value={book.title}
              placeholder="Untitled spine"
              onSave={(v) =>
                updateBook(book.id, { title: toTitleCase(v.trim()) })
              }
            />
            <Editable
              label="Author"
              value={book.author}
              placeholder="Unknown author"
              onSave={(v) =>
                updateBook(book.id, {
                  author: v.trim(),
                  authorLF: toAuthorLastFirst(v.trim()),
                })
              }
            />
            <Editable
              label="Year"
              value={book.publicationYear ? String(book.publicationYear) : ''}
              placeholder="No year"
              mono
              onSave={(v) => {
                const n = parseInt(v.replace(/[^\d]/g, ''), 10);
                updateBook(book.id, {
                  publicationYear: Number.isFinite(n) && n > 0 ? n : 0,
                });
              }}
            />
            <Editable
              label="ISBN"
              value={book.isbn}
              placeholder="No ISBN"
              mono
              onSave={(v) =>
                updateBook(book.id, {
                  isbn: v.replace(/[^\dxX]/g, ''),
                })
              }
            />
            <Editable
              label="Publisher"
              value={book.publisher}
              placeholder="No publisher"
              onSave={(v) => updateBook(book.id, { publisher: v.trim() })}
            />
            <Editable
              label="LCC"
              value={book.lcc}
              placeholder="No LCC"
              mono
              suffix={lccProvenance}
              onSave={(v) => updateBook(book.id, { lcc: v.trim() })}
            />
            <Editable
              label="Location"
              value={book.batchLabel ?? ''}
              placeholder="Add a shelf, box, or room"
              onSave={(v) =>
                updateBook(book.id, { batchLabel: v.trim() || undefined })
              }
            />
            <ReadOnlyField
              label="Source"
              value={
                book.manuallyAdded
                  ? 'Manually added'
                  : `${
                      book.lookupSource === 'openlibrary'
                        ? 'Open Library'
                        : book.lookupSource === 'googlebooks'
                          ? 'Google Books'
                          : book.lookupSource === 'isbndb'
                            ? 'ISBNdb'
                            : 'No match'
                    } · spine #${book.spineRead.position}`
              }
            />
          </div>

          {/* Notes — full-width textarea, click-to-edit. Per-book notes
              land in the LibraryThing COMMENTS column on export. */}
          <Editable
            label="Notes"
            value={book.notes ?? ''}
            placeholder="Signed, dedication, condition, anything for the COMMENTS column…"
            multiline
            onSave={(v) =>
              updateBook(book.id, { notes: v.trim() || undefined })
            }
            className="mb-3"
          />

          {/* Inline warnings, if any. Each entry coerced to a string so a
              corrupt persisted record can't reach React as a non-primitive. */}
          {Array.isArray(book.warnings) && book.warnings.length > 0 && (
            <ul className="text-[11px] text-carnegie-amber mb-3 space-y-0.5 list-disc list-inside">
              {book.warnings.map((w, i) => (
                <li key={i}>{stringifyWarning(w)}</li>
              ))}
            </ul>
          )}

          {/* Tags — full list with add/remove. String-coerce each entry so
              a non-string tag from a corrupt persisted record can't crash
              the render. */}
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {(book.genreTags ?? []).map((t) => {
              const tag = String(t);
              return (
                <TagChip
                  key={`g-${tag}`}
                  tag={tag}
                  variant="genre"
                  onRemove={() => removeTag('genre', tag)}
                />
              );
            })}
            {(book.formTags ?? []).map((t) => {
              const tag = String(t);
              return (
                <TagChip
                  key={`f-${tag}`}
                  tag={tag}
                  variant="form"
                  onRemove={() => removeTag('form', tag)}
                />
              );
            })}
            <button
              type="button"
              onClick={() => setPicker(picker === 'genre' ? null : 'genre')}
              className="text-[10px] px-2 py-0.5 rounded border border-dashed border-line text-text-quaternary hover:border-navy hover:text-navy transition"
            >
              + add genre
            </button>
            <button
              type="button"
              onClick={() => setPicker(picker === 'form' ? null : 'form')}
              className="text-[10px] px-2 py-0.5 rounded border border-dashed border-line text-text-quaternary hover:border-navy hover:text-navy transition"
            >
              + add form
            </button>
            {picker && (
              <div className="relative w-full">
                <TagPicker
                  variant={picker}
                  existing={[...book.genreTags, ...book.formTags]}
                  onAdd={(t) => addTag(picker, t)}
                  onClose={() => setPicker(null)}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onReread}
              disabled={rereading || !book.ocrImage}
              title={
                book.ocrImage
                  ? 'Re-run the AI on the same crop'
                  : 'Reread unavailable — high-res crop wasn\'t preserved'
              }
              className="text-xs px-3 py-1.5 rounded border border-line text-text-secondary hover:border-navy hover:text-navy hover:bg-navy-soft transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {rereading ? '⟳ Rereading…' : '↻ Reread'}
            </button>
            {rereadErr && (
              <span className="text-[11px] text-carnegie-red">{rereadErr}</span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ConfChip({ level }: { level: Confidence }) {
  const cls =
    level === 'HIGH'
      ? 'bg-carnegie-green-soft text-carnegie-green'
      : level === 'MEDIUM'
        ? 'bg-carnegie-amber-soft text-carnegie-amber'
        : 'bg-carnegie-red-soft text-carnegie-red';
  const label = level === 'HIGH' ? 'High' : level === 'MEDIUM' ? 'Med' : 'Low';
  return (
    <span
      className={`inline-block text-[9px] font-semibold uppercase tracking-[0.3px] px-1.5 py-0.5 rounded ${cls}`}
    >
      {label}
    </span>
  );
}

/**
 * Click-to-edit field. Click the value text to swap to an input
 * pre-populated with the current string; Enter or blur commits, Escape
 * cancels and reverts. The save callback receives the raw input string;
 * the caller is responsible for trim / parse / case-coerce.
 */
function Editable({
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
            ref={(el) => { inputRef.current = el; }}
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
            ref={(el) => { inputRef.current = el; }}
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
        } ${
          empty
            ? 'text-text-quaternary italic'
            : 'text-text-primary'
        }`}
      >
        {empty ? placeholder ?? '—' : value}
      </button>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="typo-label">{label}</span>
      <div className="mt-0.5 text-[12px] text-text-secondary truncate">{value}</div>
    </div>
  );
}
