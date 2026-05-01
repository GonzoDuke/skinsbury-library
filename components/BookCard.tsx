'use client';

import { useState } from 'react';
import type { BookRecord } from '@/lib/types';
import { useStore } from '@/lib/store';
import { TagChip } from './TagChip';
import { TagPicker } from './TagPicker';
import { ConfidenceBadge } from './ConfidenceBadge';
import { toAuthorLastFirst, toTitleCase } from '@/lib/csv-export';

interface BookCardProps {
  book: BookRecord;
  /** When true, render a checkbox in the top-left corner. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: (id: string) => void;
}

export function BookCard({ book, selectable, selected, onToggleSelected }: BookCardProps) {
  const { updateBook, rereadBook, state, mergeDuplicates, unmergeBook, keepBothDuplicates } =
    useStore();
  const [showReasoning, setShowReasoning] = useState(false);
  const [picker, setPicker] = useState<'genre' | 'form' | null>(null);
  const [rereadOpen, setRereadOpen] = useState(false);
  const [hint, setHint] = useState('');
  const [rereadError, setRereadError] = useState<string | null>(null);

  // Duplicate group siblings — used by the duplicate-pending banner so the
  // Merge button knows which records to fold into this one.
  const dupSiblings =
    book.duplicateGroup && !book.duplicateResolved
      ? state.allBooks.filter(
          (b) => b.id !== book.id && b.duplicateGroup === book.duplicateGroup
        )
      : [];

  function onMergeHere() {
    // Merging "into" the card the user clicked: this card is the winner and
    // every sibling becomes a snapshot in mergedFrom.
    mergeDuplicates(
      book.id,
      dupSiblings.map((b) => b.id)
    );
  }
  function onKeepBoth() {
    if (book.duplicateGroup) keepBothDuplicates(book.duplicateGroup);
  }
  function onUnmerge() {
    unmergeBook(book.id);
  }

  type RereadMode = 'ai' | 'hint' | 'edition';
  async function doReread(mode: RereadMode) {
    setRereadError(null);
    const opts =
      mode === 'edition'
        ? { matchEdition: true as const }
        : mode === 'hint'
          ? { hint: { title: hint.trim(), author: book.author } }
          : {};
    const result = await rereadBook(book.id, opts);
    if (!result.ok) {
      setRereadError(result.error ?? 'Reread failed.');
      return;
    }
    setRereadOpen(false);
    setHint('');
  }

  // The "Match a specific edition" button is only meaningful when the
  // user has actually changed at least one of year/publisher/ISBN since
  // the original lookup — otherwise we'd just hit the same lookup again.
  const editionEdited =
    book.publicationYear !== book.original.publicationYear ||
    book.publisher !== book.original.publisher ||
    book.isbn !== book.original.isbn;

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

  // Filter out duplicate-related warnings: those have their own banners above
  // and shouldn't double up in the generic warning treatment.
  const nonDupWarnings = book.warnings.filter(
    (w) =>
      !w.startsWith('Possible duplicate —') &&
      !w.startsWith('Detector returned ')
  );
  const hasWarnings = nonDupWarnings.length > 0;
  const lowConfidence = book.confidence === 'LOW';

  const titleModified = book.title !== book.original.title;
  const yearStr = book.publicationYear ? String(book.publicationYear) : '';
  const yearOriginalStr = book.original.publicationYear ? String(book.original.publicationYear) : '';

  return (
    <article
      className={`relative bg-cream-50 dark:bg-ink-soft/60 border ${borderClass} rounded-lg py-5 px-6 shadow-sm transition-all duration-200 ease-gentle ${
        book.retagging ? 'ring-2 ring-brass animate-pulse-dot' : ''
      } ${selected ? 'ring-2 ring-brass' : ''}`}
    >
      {selectable && onToggleSelected && (
        <label
          className="absolute top-3 left-3 flex items-center cursor-pointer z-[1]"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelected(book.id)}
            className="accent-brass w-4 h-4 cursor-pointer"
            aria-label={`Select ${book.title || 'this book'}`}
          />
        </label>
      )}
      {/* Header */}
      <div className={`flex items-start gap-3 ${selectable ? 'pl-7' : ''}`}>
        {book.spineThumbnail && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={book.spineThumbnail}
            alt={`Spine read for ${book.title || 'unknown book'}`}
            className="w-12 h-32 object-cover rounded-md ring-1 ring-cream-300/70 dark:ring-ink-soft/70 flex-shrink-0 bg-cream-100 dark:bg-ink shadow-sm"
            title="What the model saw on the shelf"
          />
        )}
        <div className="flex-1 min-w-0">
          <EditableTitle
            value={book.title}
            modified={titleModified}
            original={book.original.title}
            onSave={(v) => updateBook(book.id, { title: toTitleCase(v) })}
          />
          <div className="typo-card-meta mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5">
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
                className="text-[9px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded bg-brass-soft dark:bg-brass/20 text-brass-deep dark:text-brass font-semibold"
                title="LCC was read directly off the physical spine — authoritative for this edition"
              >
                from spine
              </span>
            )}
            {book.lccSource === 'loc' && (
              <span
                className="text-[9px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded bg-brass-soft/70 dark:bg-brass/15 text-brass-deep dark:text-brass font-semibold"
                title="LCC came from the Library of Congress catalog — authoritative source"
              >
                from LoC
              </span>
            )}
            {book.lccSource === 'wikidata' && (
              <span
                className="text-[9px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded bg-cream-200 dark:bg-ink text-ink/65 dark:text-cream-300/65 font-semibold"
                title="LCC came from Wikidata — community-aggregated from multiple national libraries"
              >
                from Wikidata
              </span>
            )}
            {book.lccSource === 'inferred' && (
              <span
                className="text-[9px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded bg-mahogany/10 dark:bg-mahogany/25 text-mahogany dark:text-orange-200 font-semibold border border-mahogany/30"
                title="LCC was inferred by Claude — not from a real catalog. Verify before approving."
              >
                AI-inferred
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {book.ocrModel && (
            <span
              className={`text-[9px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded ${
                book.ocrModel === 'o'
                  ? 'bg-cream-200 dark:bg-ink text-ink/55 dark:text-cream-300/55'
                  : 'bg-cream-200 dark:bg-ink text-ink/45 dark:text-cream-300/45'
              }`}
              title={
                book.ocrModel === 'o'
                  ? 'Read by Opus (the heavier vision model — used for narrow spines)'
                  : 'Read by Sonnet (the cheaper model — used for clear horizontal spines)'
              }
            >
              {book.ocrModel === 'o' ? 'O' : 'S'}
            </span>
          )}
          <ConfidenceBadge level={book.confidence} />
        </div>
      </div>

      {/* Previously exported — distinct, prominent banner. Takes precedence
          over the generic warning treatment because it's actionable on its own
          (the user just needs to decide: dupe, or genuine second copy). */}
      {book.previouslyExported && (
        <div className="mt-3 px-3 py-2 rounded text-xs bg-tartan/10 dark:bg-tartan/40 text-tartan dark:text-orange-100 border border-tartan/40 dark:border-tartan/60 flex items-start gap-2">
          <span aria-hidden className="font-semibold tracking-wider uppercase text-[10px] mt-0.5">
            Duplicate
          </span>
          <span className="leading-relaxed">
            Previously exported on{' '}
            <span className="font-mono">{book.previouslyExported.date}</span>
            {book.previouslyExported.batchLabel ? (
              <>
                {' '}in batch{' '}
                <span className="font-semibold">
                  &ldquo;{book.previouslyExported.batchLabel}&rdquo;
                </span>
              </>
            ) : (
              <> in an unlabeled batch</>
            )}
            . Auto-rejected — approve to ship as a second copy.
          </span>
        </div>
      )}

      {/* Possible-duplicate banner — only while the group is unresolved.
          Lists the sibling spine numbers and offers Merge / Keep-both. We
          never silently merge: paperback + hardcover of the same title are
          legitimately two separate physical copies. */}
      {book.duplicateGroup && !book.duplicateResolved && (
        <div className="mt-3 px-3 py-2 rounded text-xs bg-brass-soft/70 dark:bg-brass/20 text-brass-deep dark:text-brass border border-brass/50 flex flex-wrap items-start gap-x-3 gap-y-2">
          <span className="font-semibold tracking-wider uppercase text-[10px] mt-0.5">
            Possible duplicate
          </span>
          <span className="leading-relaxed flex-1 min-w-[200px]">
            Same title found at spine{' '}
            <span className="font-mono">
              {(book.duplicateOf ?? []).map((p) => `#${p}`).join(' and ')}
            </span>
            . Merge or keep both?
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onMergeHere}
              disabled={dupSiblings.length === 0}
              className="px-3 py-1 rounded-md bg-brass text-accent-deep hover:bg-brass-deep hover:text-limestone text-xs font-medium transition disabled:opacity-50"
              title="Fold the other copies into this card. You can Unmerge later."
            >
              Merge into this
            </button>
            <button
              type="button"
              onClick={onKeepBoth}
              className="px-3 py-1 rounded-md border border-brass/60 text-brass-deep dark:text-brass hover:bg-brass/10 text-xs font-medium transition"
              title="They're legitimately separate copies — keep both."
            >
              Keep both
            </button>
          </div>
        </div>
      )}

      {/* Merged-state badge with Unmerge — shown after the user merged this
          card or after a legacy auto-merge run that pre-dates the flag-only
          flow (those won't have `mergedFrom`, so Unmerge is disabled). */}
      {(book.duplicateResolved === 'merged' ||
        book.warnings.some((w) => w.startsWith('Detector returned '))) && (
        <div className="mt-3 px-3 py-2 rounded text-xs bg-cream-100 dark:bg-ink/60 text-ink/70 dark:text-cream-300/80 border border-cream-300 dark:border-brass/20 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold tracking-wider uppercase text-[10px]">Merged</span>
          <span className="leading-relaxed flex-1 min-w-[160px]">
            {book.mergedFrom && book.mergedFrom.length > 0
              ? `${book.mergedFrom.length} other ${
                  book.mergedFrom.length === 1 ? 'copy was' : 'copies were'
                } folded into this card.`
              : 'Auto-merged before separate-copy support — Unmerge unavailable. Re-process the photo to recover the separate entries.'}
          </span>
          <button
            type="button"
            onClick={onUnmerge}
            disabled={!book.mergedFrom || book.mergedFrom.length === 0}
            className="px-3 py-1 rounded-md border border-brass/50 text-brass-deep dark:text-brass hover:bg-brass/10 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              book.mergedFrom && book.mergedFrom.length > 0
                ? 'Restore the merged copies as separate cards.'
                : 'No snapshot available to restore.'
            }
          >
            Unmerge
          </button>
        </div>
      )}

      {/* Kept-both note — small, persistent, non-blocking. */}
      {book.duplicateResolved === 'kept-both' && (
        <div className="mt-3 px-3 py-1.5 rounded text-[11px] bg-cream-100 dark:bg-ink/60 text-ink/55 dark:text-cream-300/60 border border-cream-300 dark:border-brass/20">
          Marked as a separate copy of a duplicate-titled book.
        </div>
      )}

      {/* Warning banner — non-duplicate warnings only; the dedup banner above
          owns its own messaging. */}
      {(lowConfidence || hasWarnings) && !book.previouslyExported && (
        <div
          className={`mt-3 px-3 py-2 rounded text-xs ${
            lowConfidence
              ? 'bg-mahogany/10 dark:bg-tartan/30 text-mahogany dark:text-orange-100 border border-mahogany/30 dark:border-tartan/50'
              : 'bg-brass-soft/60 dark:bg-brass/20 text-brass-deep dark:text-brass border border-brass/40'
          }`}
        >
          {hasWarnings ? (
            <ul className="list-disc list-inside space-y-0.5">
              {nonDupWarnings.map((w, i) => (
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

      {/* Location — editable batch label, controls grouping + LT Collections */}
      <div className="mt-3 flex items-center gap-2 text-xs">
        <span className="text-[10px] uppercase tracking-wider text-ink/45 dark:text-cream-300/45 font-semibold">
          Location
        </span>
        <EditableField
          label="Location"
          value={book.batchLabel ?? ''}
          original={book.batchLabel ?? ''}
          modified={false}
          onSave={(v) => updateBook(book.id, { batchLabel: v.trim() || undefined })}
          placeholder="Add a shelf, box, or room"
          fontFamily="sans"
        />
      </div>

      {/* Notes — per-book free-form, batch notes shown read-only above */}
      <div className="mt-4">
        {book.batchNotes && (
          <div className="mb-1.5 text-[11px] text-ink/50 dark:text-cream-300/50 italic">
            <span className="uppercase tracking-wider not-italic font-semibold mr-1">
              Batch:
            </span>
            {book.batchNotes}
          </div>
        )}
        <textarea
          value={book.notes ?? ''}
          onChange={(e) => updateBook(book.id, { notes: e.target.value })}
          placeholder="Add a note for this book (signed, dedication, condition, etc.)…"
          rows={book.notes ? 2 : 1}
          className="w-full px-2 py-1.5 text-xs bg-cream-100/50 dark:bg-ink/40 rounded border border-cream-300 dark:border-ink-soft focus:outline-none focus:ring-1 focus:ring-accent resize-y placeholder:italic placeholder:text-ink/35 dark:placeholder:text-cream-300/35"
        />
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
        <div className="text-[10px] text-ink/40 dark:text-cream-300/40 flex items-center gap-2 flex-wrap">
          <span>
            From <span className="font-mono">{book.sourcePhoto}</span>
            {!book.manuallyAdded && <> · spine #{book.spineRead.position}</>}
          </span>
          {book.manuallyAdded && (
            <span
              className="px-1.5 py-0.5 rounded font-mono text-[9px] uppercase tracking-wider bg-accent-soft dark:bg-accent/30 text-accent-deep dark:text-accent-soft font-semibold"
              title={
                !book.spineThumbnail
                  ? 'Manually entered — no spine read'
                  : 'Added by drawing on the source photo'
              }
            >
              {!book.spineThumbnail ? 'Manual entry' : 'Manually added'}
            </span>
          )}
          <span aria-hidden>·</span>
          <span
            className={`px-1.5 py-0.5 rounded font-mono text-[9px] uppercase tracking-wider ${
              book.lookupSource === 'openlibrary'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : book.lookupSource === 'googlebooks'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                : book.lookupSource === 'isbndb'
                ? 'bg-[#1E3A5F]/10 text-[#1E3A5F] dark:bg-[#1E3A5F]/40 dark:text-blue-200'
                : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
            }`}
            title="Where the metadata came from"
          >
            {book.lookupSource === 'openlibrary'
              ? 'Open Library'
              : book.lookupSource === 'googlebooks'
              ? 'Google Books'
              : book.lookupSource === 'isbndb'
              ? 'ISBNdb'
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
                ? 'bg-mahogany/15 dark:bg-tartan/40 border-mahogany/50 dark:border-tartan/70 text-mahogany dark:text-orange-100'
                : 'border-cream-300 dark:border-ink-soft hover:border-mahogany dark:hover:border-tartan hover:text-mahogany dark:hover:text-orange-200'
            }`}
          >
            {book.status === 'rejected' ? '✓ Rejected' : 'Reject'}
          </button>
          <button
            onClick={() => setStatus('approved')}
            disabled={book.rereading}
            className={`text-xs px-3 py-1.5 rounded-md border transition disabled:opacity-50 ${
              book.status === 'approved'
                ? 'bg-brass/30 dark:bg-brass/40 border-brass text-accent-deep dark:text-brass-soft font-medium'
                : 'border-cream-300 dark:border-ink-soft hover:bg-brass-soft hover:border-brass hover:text-accent-deep'
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
                onClick={() => doReread('ai')}
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

              <button
                onClick={() => doReread('edition')}
                disabled={!editionEdited}
                className="w-full text-left text-xs px-3 py-2 rounded border border-cream-300 dark:border-ink-soft hover:border-accent hover:text-accent disabled:opacity-50 transition"
                title={
                  editionEdited
                    ? 'Re-look up using the year, publisher, and ISBN currently in the form fields above. Title and author are kept as you’ve edited them.'
                    : 'Edit at least one of year, publisher, or ISBN above first — otherwise this would re-run the same lookup.'
                }
              >
                <div className="font-medium">Match a specific edition</div>
                <div className="text-[10px] text-ink/50 dark:text-cream-300/50 mt-0.5">
                  {editionEdited
                    ? 'Uses your edited year / publisher / ISBN to scope the lookup.'
                    : 'Edit year, publisher, or ISBN above to enable.'}
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
                    if (e.key === 'Enter' && hint.trim()) doReread('hint');
                    if (e.key === 'Escape') setRereadOpen(false);
                  }}
                />
                <button
                  onClick={() => doReread('hint')}
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
        className="typo-card-title w-full bg-transparent border-b border-accent focus:outline-none"
      />
    );
  }
  return (
    <h2
      className={`typo-card-title cursor-text inline-flex items-center ${
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
