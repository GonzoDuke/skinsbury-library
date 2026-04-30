'use client';

import { useState } from 'react';
import type { BookRecord } from '@/lib/types';
import { useStore } from '@/lib/store';
import { TagChip } from './TagChip';
import { TagPicker } from './TagPicker';
import { ConfidenceBadge } from './ConfidenceBadge';
import { toAuthorLastFirst } from '@/lib/csv-export';

interface BookCardProps {
  book: BookRecord;
}

export function BookCard({ book }: BookCardProps) {
  const { updateBook, rereadBook } = useStore();
  const [showReasoning, setShowReasoning] = useState(false);
  const [picker, setPicker] = useState<'genre' | 'form' | null>(null);
  const [rereadOpen, setRereadOpen] = useState(false);
  const [hint, setHint] = useState('');
  const [rereadError, setRereadError] = useState<string | null>(null);

  async function doReread(useHint: boolean) {
    setRereadError(null);
    const result = useHint
      ? await rereadBook(book.id, { hint: { title: hint.trim(), author: book.author } })
      : await rereadBook(book.id, {});
    if (!result.ok) {
      setRereadError(result.error ?? 'Reread failed.');
      return;
    }
    setRereadOpen(false);
    setHint('');
  }

  const borderClass =
    book.status === 'approved'
      ? 'border-green-400 dark:border-green-600 ring-1 ring-green-300/50'
      : book.status === 'rejected'
      ? 'border-red-300 dark:border-red-800 opacity-60'
      : 'border-cream-300 dark:border-ink-soft';

  function setStatus(next: 'approved' | 'rejected') {
    updateBook(book.id, { status: book.status === next ? 'pending' : next });
  }

  function addTag(variant: 'genre' | 'form', tag: string) {
    if (variant === 'genre') {
      updateBook(book.id, { genreTags: [...book.genreTags, tag] });
    } else {
      updateBook(book.id, { formTags: [...book.formTags, tag] });
    }
  }

  function removeTag(variant: 'genre' | 'form', tag: string) {
    if (variant === 'genre') {
      updateBook(book.id, { genreTags: book.genreTags.filter((t) => t !== tag) });
    } else {
      updateBook(book.id, { formTags: book.formTags.filter((t) => t !== tag) });
    }
  }

  const hasWarnings = book.warnings.length > 0;
  const lowConfidence = book.confidence === 'LOW';

  const titleModified = book.title !== book.original.title;
  const yearStr = book.publicationYear ? String(book.publicationYear) : '';
  const yearOriginalStr = book.original.publicationYear ? String(book.original.publicationYear) : '';

  return (
    <article
      className={`relative bg-cream-50 dark:bg-ink-soft/60 border ${borderClass} rounded-lg p-5 shadow-sm transition-all duration-200 ease-gentle`}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        {book.spineThumbnail && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={book.spineThumbnail}
            alt={`Spine read for ${book.title || 'unknown book'}`}
            className="w-12 h-32 object-cover rounded border border-cream-300 dark:border-ink-soft flex-shrink-0 bg-cream-100 dark:bg-ink"
            title="What the model saw on the shelf"
          />
        )}
        <div className="flex-1 min-w-0">
          <EditableTitle
            value={book.title}
            modified={titleModified}
            original={book.original.title}
            onSave={(v) => updateBook(book.id, { title: v })}
          />
          <div className="text-xs text-ink/60 dark:text-cream-300/60 mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
            <EditableField
              label="Author"
              value={book.author}
              original={book.original.author}
              modified={book.author !== book.original.author}
              onSave={(v) =>
                updateBook(book.id, {
                  author: v,
                  authorLF: toAuthorLastFirst(v),
                })
              }
              placeholder="Unknown author"
              fontFamily="sans"
            />
            <span>·</span>
            <EditableField
              label="ISBN"
              value={book.isbn}
              original={book.original.isbn}
              modified={book.isbn !== book.original.isbn}
              onSave={(v) => updateBook(book.id, { isbn: v.replace(/[^\dxX]/g, '') })}
              placeholder="No ISBN"
              fontFamily="mono"
            />
            <span>·</span>
            <EditableField
              label="Publisher"
              value={book.publisher}
              original={book.original.publisher}
              modified={book.publisher !== book.original.publisher}
              onSave={(v) => updateBook(book.id, { publisher: v })}
              placeholder="No publisher"
              fontFamily="sans"
            />
            <span>·</span>
            <EditableField
              label="Year"
              value={yearStr}
              original={yearOriginalStr}
              modified={yearStr !== yearOriginalStr}
              onSave={(v) =>
                updateBook(book.id, { publicationYear: parseInt(v, 10) || 0 })
              }
              placeholder="No year"
              fontFamily="mono"
            />
            <span>·</span>
            <EditableField
              label="LCC"
              value={book.lcc}
              original={book.original.lcc}
              modified={book.lcc !== book.original.lcc}
              onSave={(v) => updateBook(book.id, { lcc: v })}
              placeholder="No LCC"
              fontFamily="mono"
            />
            {book.lccSource === 'spine' && (
              <span
                className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-soft dark:bg-accent/30 text-accent dark:text-accent-soft font-semibold"
                title="LCC was read directly off the physical spine — authoritative for this edition"
              >
                from spine
              </span>
            )}
          </div>
        </div>
        <ConfidenceBadge level={book.confidence} />
      </div>

      {/* Warning banner */}
      {(lowConfidence || hasWarnings) && (
        <div
          className={`mt-3 px-3 py-2 rounded text-xs ${
            lowConfidence
              ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-900/40'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-900/40'
          }`}
        >
          {book.warnings.length > 0 ? (
            <ul className="list-disc list-inside space-y-0.5">
              {book.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : (
            <span>Low confidence — please verify spine read and metadata before approving.</span>
          )}
        </div>
      )}

      {/* Tags */}
      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 relative">
          {book.genreTags.map((t) => (
            <TagChip
              key={`g-${t}`}
              tag={t}
              variant="genre"
              onRemove={() => removeTag('genre', t)}
            />
          ))}
          <button
            onClick={() => setPicker(picker === 'genre' ? null : 'genre')}
            className="text-[11px] px-2 py-1 rounded-full border border-dashed border-ink/30 dark:border-cream-300/30 text-ink/60 dark:text-cream-300/60 hover:border-accent hover:text-accent transition"
          >
            + add genre
          </button>
          {picker === 'genre' && (
            <TagPicker
              variant="genre"
              existing={[...book.genreTags, ...book.formTags]}
              onAdd={(t) => addTag('genre', t)}
              onClose={() => setPicker(null)}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 relative">
          {book.formTags.map((t) => (
            <TagChip
              key={`f-${t}`}
              tag={t}
              variant="form"
              onRemove={() => removeTag('form', t)}
            />
          ))}
          <button
            onClick={() => setPicker(picker === 'form' ? null : 'form')}
            className="text-[11px] px-2 py-1 rounded-full border border-dashed border-ink/30 dark:border-cream-300/30 text-ink/60 dark:text-cream-300/60 hover:border-accent hover:text-accent transition"
          >
            + add form
          </button>
          {picker === 'form' && (
            <TagPicker
              variant="form"
              existing={[...book.genreTags, ...book.formTags]}
              onAdd={(t) => addTag('form', t)}
              onClose={() => setPicker(null)}
            />
          )}
        </div>
      </div>

      {/* Reasoning */}
      {book.reasoning && (
        <div className="mt-3">
          <button
            onClick={() => setShowReasoning((s) => !s)}
            className="text-[11px] text-ink/50 dark:text-cream-300/50 hover:text-accent transition"
          >
            {showReasoning ? '▾' : '▸'} Reasoning
          </button>
          {showReasoning && (
            <p className="mt-1 text-xs text-ink/70 dark:text-cream-300/70 italic leading-relaxed">
              {book.reasoning}
            </p>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-4 flex justify-between items-center">
        <div className="text-[10px] text-ink/40 dark:text-cream-300/40 flex items-center gap-2">
          <span>
            From <span className="font-mono">{book.sourcePhoto}</span> · spine #
            {book.spineRead.position}
          </span>
          <span aria-hidden>·</span>
          <span
            className={`px-1.5 py-0.5 rounded font-mono text-[9px] uppercase tracking-wider ${
              book.lookupSource === 'openlibrary'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : book.lookupSource === 'googlebooks'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
            }`}
            title="Where the metadata came from"
          >
            {book.lookupSource === 'openlibrary'
              ? 'Open Library'
              : book.lookupSource === 'googlebooks'
              ? 'Google Books'
              : 'No match'}
          </span>
        </div>
        <div className="flex gap-2 relative">
          <button
            onClick={() => {
              setRereadOpen((v) => !v);
              setRereadError(null);
            }}
            disabled={book.rereading}
            className="text-xs px-3 py-1.5 rounded-md border border-cream-300 dark:border-ink-soft hover:border-accent hover:text-accent disabled:opacity-50 transition"
            title="Re-run the AI on this spine"
          >
            {book.rereading ? '⟳ Rereading…' : '↻ Reread'}
          </button>
          <button
            onClick={() => setStatus('rejected')}
            disabled={book.rereading}
            className={`text-xs px-3 py-1.5 rounded-md border transition disabled:opacity-50 ${
              book.status === 'rejected'
                ? 'bg-red-100 dark:bg-red-900/40 border-red-300 dark:border-red-800 text-red-800 dark:text-red-200'
                : 'border-cream-300 dark:border-ink-soft hover:border-red-400 hover:text-red-700 dark:hover:text-red-400'
            }`}
          >
            {book.status === 'rejected' ? '✓ Rejected' : 'Reject'}
          </button>
          <button
            onClick={() => setStatus('approved')}
            disabled={book.rereading}
            className={`text-xs px-3 py-1.5 rounded-md border transition disabled:opacity-50 ${
              book.status === 'approved'
                ? 'bg-green-100 dark:bg-green-900/40 border-green-400 dark:border-green-700 text-green-800 dark:text-green-200'
                : 'border-cream-300 dark:border-ink-soft hover:border-green-500 hover:text-green-700 dark:hover:text-green-400'
            }`}
          >
            {book.status === 'approved' ? '✓ Approved' : 'Approve'}
          </button>

          {rereadOpen && !book.rereading && (
            <div className="absolute right-0 bottom-full mb-2 w-80 bg-cream-50 dark:bg-ink-soft border border-cream-300 dark:border-ink-soft rounded-lg shadow-lg p-3 z-20 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 font-semibold">
                Reread this spine
              </div>
              <button
                onClick={() => doReread(false)}
                disabled={!book.ocrImage}
                className="w-full text-left text-xs px-3 py-2 rounded border border-cream-300 dark:border-ink-soft hover:border-accent hover:text-accent disabled:opacity-50 transition"
                title={
                  book.ocrImage
                    ? 'Send the same crop to the model again. Pass B is non-deterministic — a fresh attempt often reads better.'
                    : 'The OCR-quality crop wasn’t preserved (likely from before this feature shipped). Use the typed hint instead.'
                }
              >
                <div className="font-medium">Try again with AI</div>
                <div className="text-[10px] text-ink/50 dark:text-cream-300/50 mt-0.5">
                  {book.ocrImage
                    ? 'Re-runs the read on the same crop. ~5–15 seconds.'
                    : 'Unavailable — high-res crop wasn’t preserved.'}
                </div>
              </button>
              <div className="text-[10px] text-center text-ink/40 dark:text-cream-300/40 uppercase tracking-wider">
                or
              </div>
              <div>
                <input
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder="Type the actual title…"
                  className="w-full px-2 py-1.5 text-xs bg-cream-100 dark:bg-ink rounded border border-cream-300 dark:border-ink-soft focus:outline-none focus:ring-1 focus:ring-accent"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && hint.trim()) doReread(true);
                    if (e.key === 'Escape') setRereadOpen(false);
                  }}
                />
                <button
                  onClick={() => doReread(true)}
                  disabled={!hint.trim()}
                  className="mt-2 w-full text-xs px-3 py-1.5 rounded bg-accent text-cream-50 hover:bg-accent-deep disabled:opacity-50 transition"
                >
                  Look up &amp; retag with this title
                </button>
              </div>
              {rereadError && (
                <div className="text-[11px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded px-2 py-1.5">
                  {rereadError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function ModifiedDot({ original }: { original: string }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-1 align-middle"
      title={original ? `Edited (was: ${original})` : 'Edited (was empty)'}
    />
  );
}

function EditableTitle({
  value,
  original,
  modified,
  onSave,
}: {
  value: string;
  original: string;
  modified: boolean;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const cancelRef = { current: false };

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value}
        onBlur={(e) => {
          if (!cancelRef.current) onSave(e.target.value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            cancelRef.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="font-serif text-xl font-medium w-full bg-transparent border-b border-accent focus:outline-none"
      />
    );
  }
  return (
    <h2
      className={`font-serif text-xl font-medium leading-tight cursor-text inline-flex items-center ${
        modified ? 'text-accent dark:text-accent' : ''
      }`}
      onClick={() => setEditing(true)}
      title="Click to edit title"
    >
      {value || <span className="italic opacity-60">Untitled spine</span>}
      {modified && <ModifiedDot original={original} />}
    </h2>
  );
}

function EditableField({
  label,
  value,
  original,
  modified,
  onSave,
  placeholder,
  fontFamily,
}: {
  label: string;
  value: string;
  original: string;
  modified: boolean;
  onSave: (v: string) => void;
  placeholder: string;
  fontFamily: 'sans' | 'mono';
}) {
  const [editing, setEditing] = useState(false);
  const fontClass = fontFamily === 'mono' ? 'font-mono' : 'font-sans';
  // Per-edit cancel flag — using an object to share between handlers, since
  // setEditing(false) on Escape will trigger blur which would otherwise save.
  const cancelRef = { current: false };

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value}
        onBlur={(e) => {
          if (!cancelRef.current) onSave(e.target.value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            cancelRef.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`${fontClass} bg-transparent border-b border-accent focus:outline-none px-0.5 min-w-0`}
        size={Math.max(value.length, placeholder.length, 6)}
        aria-label={label}
      />
    );
  }
  return (
    <span
      className={`${fontClass} cursor-text hover:text-accent transition inline-flex items-center ${
        !value ? 'italic opacity-60' : ''
      } ${modified ? 'text-accent dark:text-accent font-medium' : ''}`}
      onClick={() => setEditing(true)}
      title={modified ? `Edited (was: ${original || 'empty'})` : `Click to edit ${label.toLowerCase()}`}
    >
      {value || placeholder}
      {modified && <ModifiedDot original={original} />}
    </span>
  );
}
