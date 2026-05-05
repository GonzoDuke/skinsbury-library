'use client';

import { useState } from 'react';
import type { BookRecord } from '@/lib/types';
import { useStore } from '@/lib/store';
import { toAuthorLastFirst } from '@/lib/csv-export';
import { TagChip } from './TagChip';
import { TagPicker } from './TagPicker';
import { Cover } from './Cover';
import { ConfidenceBadge } from './ConfidenceBadge';
import { Editable } from './Editable';
import { LcshChipLink } from './LcshChipLink';
import { fireUndo } from './UndoToast';
import { logCorrection } from '@/lib/corrections-log';

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
 * Phone Review card. Compact by default — cover on the left, title /
 * author / ISBN / year, confidence badge, tag pills, ✓ / ✕ buttons. Tap
 * the card body to expand the same inline-edit view the desktop detail
 * panel offers (re-uses Editable so the two stay in sync).
 *
 * Synced batches arrive without `ocrImage`, so Reread is naturally
 * disabled — the existing `!book.ocrImage` gate covers it without any
 * special "is this a synced row" flag.
 */
export function MobileBookCard({ book }: { book: BookRecord }) {
  const { state, updateBook, rereadBook } = useStore();
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<'genre' | 'form' | null>(null);
  const [rereading, setRereading] = useState(false);
  const [rereadErr, setRereadErr] = useState<string | null>(null);

  const safeGenre = Array.isArray(book.genreTags) ? book.genreTags : [];
  const safeForm = Array.isArray(book.formTags) ? book.formTags : [];

  // Multi-copy grouping context (mirrors BookTableRow logic).
  const workGroupId = book.work_group_id;
  let groupPosition = 0;
  let groupSize = 0;
  if (workGroupId) {
    const siblings = state.allBooks.filter(
      (b) => b.work_group_id === workGroupId
    );
    groupSize = siblings.length;
    groupPosition = siblings.findIndex((b) => b.id === book.id) + 1;
  }
  const isInGroup = groupSize >= 2;
  const isFirstInGroup = isInGroup && groupPosition === 1;
  const isLastInGroup = isInGroup && groupPosition === groupSize;

  const isApproved = book.status === 'approved';
  const isRejected = book.status === 'rejected';

  const hasWarning =
    (Array.isArray(book.warnings) && book.warnings.length > 0) ||
    !!book.previouslyExported ||
    !!(book.duplicateGroup && !book.duplicateResolved) ||
    book.confidence === 'LOW' ||
    book.domainConfidence === 'low';

  function setStatus(next: 'approved' | 'rejected') {
    const prior = book.status;
    const target = prior === next ? 'pending' : next;
    updateBook(book.id, { status: target });
    if (target === 'rejected' && prior !== 'rejected') {
      fireUndo(`Rejected "${book.title || 'untitled book'}".`, () =>
        updateBook(book.id, { status: prior })
      );
    }
  }

  // System-inferred tag set for this book — used to decide whether a
  // tag mutation is a correction to the model (worth logging) or just
  // the user editing their own additions (no-op).
  const originalGenre = Array.isArray(book.original?.genreTags)
    ? book.original.genreTags
    : [];
  const originalForm = Array.isArray(book.original?.formTags)
    ? book.original.formTags
    : [];
  const systemSuggestedSet = new Set<string>([...originalGenre, ...originalForm]);
  const systemSuggestedTags = [...originalGenre, ...originalForm];

  function addTag(variant: 'genre' | 'form', tag: string) {
    if (variant === 'genre') {
      updateBook(book.id, { genreTags: [...safeGenre, tag] });
    } else {
      updateBook(book.id, { formTags: [...safeForm, tag] });
    }
    if (!systemSuggestedSet.has(tag)) {
      logCorrection({
        title: book.title,
        author: book.author,
        lcc: book.lcc,
        systemSuggestedTags,
        addedTag: tag,
      });
    }
  }
  function removeTag(variant: 'genre' | 'form', tag: string) {
    if (variant === 'genre') {
      updateBook(book.id, { genreTags: safeGenre.filter((t) => t !== tag) });
    } else {
      updateBook(book.id, { formTags: safeForm.filter((t) => t !== tag) });
    }
    if (systemSuggestedSet.has(tag)) {
      logCorrection({
        title: book.title,
        author: book.author,
        lcc: book.lcc,
        systemSuggestedTags,
        removedTag: tag,
      });
    }
  }

  async function onReread() {
    if (rereading) return;
    setRereading(true);
    setRereadErr(null);
    // ocrImage is stripped from localStorage to stay under quota, so
    // after any reload (or any cross-device synced batch) we use the
    // current title/author for a lookup + tag-infer pass via
    // matchEdition. With an ocrImage we do the full AI retry.
    const opts = book.ocrImage
      ? {}
      : book.title
        ? { matchEdition: true as const }
        : null;
    if (!opts) {
      setRereading(false);
      setRereadErr(
        'Nothing to reread — type a title above first.'
      );
      return;
    }
    const r = await rereadBook(book.id, opts);
    setRereading(false);
    if (!r.ok) setRereadErr(r.error ?? 'Reread failed.');
  }

  const tint = isApproved
    ? 'bg-[#FAF4E5] dark:bg-[#3A2F1B]/60'
    : isRejected
      ? 'opacity-40'
      : 'bg-surface-card';

  // Multi-copy left-edge connector. 2px gold accent, with rounded
  // top-left only for the first card in the group, bottom-left only
  // for the last, square for middles. Override the default border-radius
  // so the corners read as a continuous group spine.
  const groupBorderStyle: React.CSSProperties | undefined = isInGroup
    ? {
        borderLeftColor: '#C4A35A',
        borderLeftWidth: 2,
        borderTopLeftRadius: isFirstInGroup ? undefined : 0,
        borderBottomLeftRadius: isLastInGroup ? undefined : 0,
      }
    : undefined;

  return (
    <div
      className={`rounded-lg border border-line overflow-hidden ${tint}`}
      style={groupBorderStyle}
    >
      {/* Collapsed header. Tap to expand. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-stretch gap-3 p-3 text-left"
      >
        <div className="relative flex-shrink-0">
          <Cover
            coverUrl={book.coverUrl}
            coverUrlFallbacks={book.coverUrlFallbacks}
            spineThumbnail={book.spineThumbnail}
            alt={book.title || 'unknown book'}
            className="w-16 h-24 rounded bg-surface-page border border-line-light overflow-hidden"
          />
          {book.scannedFromBarcode && (
            <span
              className="absolute -bottom-1 -right-1 text-[8px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-navy text-white shadow"
              title="Added by ISBN barcode scan"
            >
              Scanned
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 flex flex-col">
          <div className="flex items-start gap-1.5">
            {hasWarning && (
              <span
                aria-hidden
                title="Needs attention"
                className="inline-block w-[6px] h-[6px] rounded-full bg-carnegie-amber mt-1.5 flex-shrink-0"
              />
            )}
            <div className="typo-card-title leading-tight line-clamp-2">
              {book.title || (
                <span className="italic opacity-60">Untitled spine</span>
              )}
            </div>
          </div>
          {isInGroup && (
            <div
              className="inline-flex items-center self-start text-[10px] font-medium text-text-secondary mt-1 px-1.5 py-0.5 rounded bg-surface-page border border-line-light"
              title={`Copy ${groupPosition} of ${groupSize} (linked via Add Copy)`}
            >
              {groupPosition} of {groupSize}
              {book.format ? ` · ${book.format}` : ''}
            </div>
          )}
          <div className="text-[12px] text-text-tertiary mt-0.5 line-clamp-1">
            {book.author || 'Unknown author'}
          </div>
          <div className="text-[11px] text-text-quaternary mt-0.5">
            {book.isbn && <span className="font-mono mr-2">{book.isbn}</span>}
            {book.publicationYear ? <span>{book.publicationYear}</span> : null}
          </div>
          <div className="mt-auto pt-2 flex items-center gap-1.5 flex-wrap">
            <ConfidenceBadge level={book.confidence} />
            {safeGenre.slice(0, 2).map((t) => (
              <TagChip key={t} tag={String(t)} variant="genre" size="sm" />
            ))}
            {safeGenre.length + safeForm.length - Math.min(2, safeGenre.length) > 0 && (
              <span className="text-[11px] text-text-quaternary">
                +{safeGenre.length + safeForm.length - Math.min(2, safeGenre.length)}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Approve / reject row — separate from the tap-to-expand area so
          the buttons can't accidentally toggle the card. */}
      <div className="flex border-t border-line-light">
        <button
          type="button"
          onClick={() => setStatus('approved')}
          disabled={rereading}
          className={`flex-1 py-2.5 text-sm font-semibold border-r border-line-light transition ${
            isApproved
              ? 'bg-carnegie-gold text-text-primary'
              : 'text-text-tertiary hover:text-navy hover:bg-navy-soft'
          }`}
          aria-label="Approve"
        >
          ✓ Approve
        </button>
        <button
          type="button"
          onClick={() => setStatus('rejected')}
          disabled={rereading}
          className={`flex-1 py-2.5 text-sm font-semibold transition ${
            isRejected
              ? 'bg-carnegie-red-soft text-carnegie-red'
              : 'text-text-tertiary hover:text-carnegie-red hover:bg-carnegie-red-soft'
          }`}
          aria-label="Reject"
        >
          ✕ Reject
        </button>
      </div>

      {/* Expanded inline editor. Reuses Editable for parity with desktop. */}
      {open && (
        <div className="border-t border-line-light bg-surface-page px-4 py-3 space-y-2.5">
          <Editable
            label="Title"
            value={book.title}
            placeholder="Untitled spine"
            // Save the user's typed value verbatim — see BookTableRow.tsx for rationale.
            onSave={(v) => updateBook(book.id, { title: v.trim() })}
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
          <div className="grid grid-cols-2 gap-3">
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
                updateBook(book.id, { isbn: v.replace(/[^\dxX]/g, '') })
              }
            />
          </div>
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
          <Editable
            label="Notes"
            value={book.notes ?? ''}
            placeholder="Signed, dedication, condition…"
            multiline
            onSave={(v) =>
              updateBook(book.id, { notes: v.trim() || undefined })
            }
          />

          {/* Phase-3 enrichment fields — each only renders when populated.
              Old records without enrichment look exactly as before. */}
          {(book.pageCount ||
            book.edition ||
            book.binding ||
            book.series ||
            (book.allAuthors && book.allAuthors.length > 1) ||
            (book.language &&
              book.language.toLowerCase() !== 'en' &&
              book.language.toLowerCase() !== 'eng')) && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-text-secondary">
              {book.pageCount ? (
                <div>
                  <span className="text-text-quaternary uppercase tracking-wider mr-1">Pages</span>
                  {book.pageCount}
                </div>
              ) : null}
              {book.edition ? (
                <div>
                  <span className="text-text-quaternary uppercase tracking-wider mr-1">Edition</span>
                  {book.edition}
                </div>
              ) : null}
              {book.binding ? (
                <div>
                  <span className="text-text-quaternary uppercase tracking-wider mr-1">Binding</span>
                  {book.binding}
                </div>
              ) : null}
              {book.language &&
              book.language.toLowerCase() !== 'en' &&
              book.language.toLowerCase() !== 'eng' ? (
                <div>
                  <span className="text-text-quaternary uppercase tracking-wider mr-1">Lang</span>
                  {book.language}
                </div>
              ) : null}
              {book.series ? (
                <div className="col-span-2">
                  <span className="text-text-quaternary uppercase tracking-wider mr-1">Series</span>
                  {book.series}
                </div>
              ) : null}
              {book.allAuthors && book.allAuthors.length > 1 ? (
                <div className="col-span-2">
                  <span className="text-text-quaternary uppercase tracking-wider mr-1">All authors</span>
                  {book.allAuthors.join('; ')}
                </div>
              ) : null}
            </div>
          )}
          {book.synopsis ? (
            <div className="text-[11px] text-text-secondary leading-relaxed">
              <span className="block uppercase tracking-wider text-[10px] text-text-quaternary mb-1">
                Synopsis
              </span>
              {book.synopsis.length > 240
                ? `${book.synopsis.slice(0, 240)}…`
                : book.synopsis}
            </div>
          ) : null}
          {book.lcshSubjects && book.lcshSubjects.length > 0 ? (
            <div>
              <span className="block uppercase tracking-wider text-[10px] text-text-quaternary mb-1.5">
                LCSH
              </span>
              <div className="flex flex-wrap gap-1.5">
                {book.lcshSubjects.map((h, i) => (
                  <LcshChipLink key={`${i}-${h}`} heading={String(h)} />
                ))}
              </div>
            </div>
          ) : null}

          {Array.isArray(book.warnings) && book.warnings.length > 0 && (
            <ul className="text-[11px] text-carnegie-amber space-y-0.5 list-disc list-inside">
              {book.warnings.map((w, i) => (
                <li key={i}>{stringifyWarning(w)}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {safeGenre.map((t) => {
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
            {safeForm.map((t) => {
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
              className="text-[11px] px-2 py-0.5 rounded border border-dashed border-line text-text-quaternary"
            >
              + genre
            </button>
            <button
              type="button"
              onClick={() => setPicker(picker === 'form' ? null : 'form')}
              className="text-[11px] px-2 py-0.5 rounded border border-dashed border-line text-text-quaternary"
            >
              + form
            </button>
            {picker && (
              <div className="relative w-full">
                <TagPicker
                  variant={picker}
                  existing={[...safeGenre, ...safeForm]}
                  onAdd={(t) => addTag(picker, t)}
                  onClose={() => setPicker(null)}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={onReread}
              disabled={rereading || (!book.ocrImage && !book.title)}
              title={
                book.ocrImage
                  ? 'Re-run the AI on the same crop'
                  : book.title
                    ? 'Re-fetch metadata + re-infer tags using the current title/author'
                    : 'Type a title above first'
              }
              className="text-xs px-3 py-1.5 rounded border border-line text-text-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {rereading
                ? '⟳ Rereading…'
                : book.ocrImage
                  ? '↻ Reread'
                  : '↻ Refresh metadata'}
            </button>
            {rereadErr && (
              <span className="text-[11px] text-carnegie-red">{rereadErr}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
