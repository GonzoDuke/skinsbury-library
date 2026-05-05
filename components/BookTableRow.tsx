'use client';

import { useState } from 'react';
import type { BookRecord, Confidence } from '@/lib/types';
import { useStore } from '@/lib/store';
import { toAuthorLastFirst } from '@/lib/csv-export';
import { TagChip } from './TagChip';
import { TagPicker } from './TagPicker';
import { Cover } from './Cover';
import { Editable, ReadOnlyField } from './Editable';
import { LcshChipLink } from './LcshChipLink';
import { AddCopyModal } from './AddCopyModal';
import { fireUndo } from './UndoToast';
import { logCorrection } from '@/lib/corrections-log';

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
  const { state, updateBook, rereadBook, addCopy } = useStore();
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<'genre' | 'form' | null>(null);
  const [rereading, setRereading] = useState(false);
  const [rereadErr, setRereadErr] = useState<string | null>(null);
  const [addCopyOpen, setAddCopyOpen] = useState(false);

  // Multi-copy grouping context. When the book is part of a
  // work_group_id'd cluster, compute its 1-based position and the
  // group total so the row can render the "X of N" chip + left-edge
  // connector. Insertion order in state.allBooks is the stable
  // representative-position-then-siblings ordering used by the Review
  // page's sort, so we can derive position from it directly.
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

  const hasWarning =
    (Array.isArray(book.warnings) && book.warnings.length > 0) ||
    !!book.previouslyExported ||
    !!(book.duplicateGroup && !book.duplicateResolved) ||
    book.confidence === 'LOW' ||
    book.domainConfidence === 'low';

  const isApproved = book.status === 'approved';
  const isRejected = book.status === 'rejected';

  // Defensive guards: a corrupt persisted BookRecord can in principle
  // arrive with non-array tag fields. Default to empty arrays so the
  // .slice / .length math below can't throw.
  const safeGenre = Array.isArray(book.genreTags) ? book.genreTags : [];
  const safeForm = Array.isArray(book.formTags) ? book.formTags : [];
  const tagsCondensed = safeGenre.slice(0, 2);
  const tagsExtra = safeGenre.length + safeForm.length - tagsCondensed.length;

  // System-inferred tag set for this book — used to decide whether a
  // tag mutation is a correction worth logging vs the user editing
  // their own additions.
  const originalGenre = Array.isArray(book.original?.genreTags)
    ? book.original.genreTags
    : [];
  const originalForm = Array.isArray(book.original?.formTags)
    ? book.original.formTags
    : [];
  const systemSuggestedSet = new Set<string>([...originalGenre, ...originalForm]);
  const systemSuggestedTags = [...originalGenre, ...originalForm];

  function setStatus(next: 'approved' | 'rejected') {
    const prior = book.status;
    const target = prior === next ? 'pending' : next;
    updateBook(book.id, { status: target });
    // Reject is the destructive direction — surface an undo toast so a
    // mis-tap is recoverable for 5s. Approve toggles don't need it.
    if (target === 'rejected' && prior !== 'rejected') {
      fireUndo(`Rejected "${book.title || 'untitled book'}".`, () =>
        updateBook(book.id, { status: prior })
      );
    }
  }

  function addTag(variant: 'genre' | 'form', tag: string) {
    if (variant === 'genre') {
      updateBook(book.id, { genreTags: [...safeGenre, tag] });
    } else {
      updateBook(book.id, { formTags: [...safeForm, tag] });
    }
    // Only log when the system didn't suggest this tag — that's a
    // real miss for the inference pass to learn from.
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
    // Only log when the user removes a tag the system suggested —
    // removing a tag they themselves added is just an undo.
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
    // Two paths. The high-res ocrImage is stripped from localStorage
    // to stay under quota, so after any reload it's gone — but the
    // user still gets a useful Reread by re-running lookup + tag
    // inference against the current (possibly user-edited) title /
    // author / publisher / year / ISBN. matchEdition skips Pass B
    // and trusts those fields. With an ocrImage, we do the full AI
    // retry on the original crop (no hint).
    const opts = book.ocrImage
      ? {}
      : book.title
        ? { matchEdition: true as const }
        : null;
    if (!opts) {
      setRereading(false);
      setRereadErr(
        'Nothing to reread — no spine crop and no title yet. Type a title in the panel above first.'
      );
      return;
    }
    const r = await rereadBook(book.id, opts);
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

  // Multi-copy left-edge connector. Rendered as inline-style border so
  // we can vary the radius per row position (top-left rounded for the
  // first row in the group, bottom-left for the last, square for the
  // middle). 2px gold accent — the same Carnegie gold used for the
  // local-only-mode indicator and approve-pulse.
  const groupBorderStyle: React.CSSProperties | undefined = isInGroup
    ? {
        borderLeft: '2px solid #C4A35A',
        borderTopLeftRadius: isFirstInGroup ? 6 : 0,
        borderBottomLeftRadius: isLastInGroup ? 6 : 0,
      }
    : undefined;

  return (
    <>
      <div
        onClick={() => setOpen((v) => !v)}
        className={`grid grid-cols-[72px_1fr_90px_240px_120px] items-center gap-4 px-[16px] py-[14px] border-b border-line-light cursor-pointer transition-colors ${rowTint}`}
        style={groupBorderStyle}
        role="button"
        aria-expanded={open}
      >
        {/* Cover — 56×80 to read at desktop scale; Cover component
            handles the load-fail fallback chain. Scanned books wear a
            small "Scanned" badge in the bottom-right of the cover so
            the reviewer can tell at a glance which records came from
            a barcode vs. spine OCR. */}
        <div className="relative">
          <Cover
            coverUrl={book.coverUrl}
            coverUrlFallbacks={book.coverUrlFallbacks}
            spineThumbnail={book.spineThumbnail}
            alt={book.title || 'unknown book'}
            className="w-14 h-20 rounded bg-surface-page border border-line-light overflow-hidden"
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
            {isInGroup && (
              <span
                className="inline-flex items-center text-[11px] font-medium text-text-secondary mr-2 px-1.5 py-0.5 rounded bg-surface-page border border-line-light align-middle"
                title={`Copy ${groupPosition} of ${groupSize} (linked via Add Copy)`}
              >
                {groupPosition} of {groupSize}
                {book.format ? ` · ${book.format}` : ''}
              </span>
            )}
            {book.title || <span className="italic opacity-60">Untitled spine</span>}
          </div>
          <div className="text-[13px] text-text-tertiary mt-1 truncate">
            {book.author || 'Unknown author'}
            {book.isbn && (
              <>
                <span className="mx-1.5 text-text-quaternary">·</span>
                <span className="font-mono text-[12px]">{book.isbn}</span>
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
        <div className="flex items-center gap-1">
          <ConfChip level={book.confidence} />
          {book.domainConfidence === 'low' && (
            <span
              className="inline-block text-[9px] font-semibold uppercase tracking-[0.3px] px-1.5 py-0.5 rounded bg-carnegie-amber-soft text-carnegie-amber"
              title={`Low domain confidence — primary domain "${book.inferredDomains?.[0] ?? 'unknown'}" was uncertain. Review tags carefully.`}
            >
              ?domain
            </span>
          )}
        </div>

        {/* Tags (compact) */}
        <div className="flex items-center gap-1.5 overflow-hidden">
          {tagsCondensed.map((t) => {
            const tag = String(t);
            return <TagChip key={tag} tag={tag} variant="genre" size="sm" />;
          })}
          {tagsExtra > 0 && (
            <span className="text-[12px] text-text-quaternary">+{tagsExtra}</span>
          )}
        </div>

        {/* Actions — ✓ / ✕. Inline editing happens in the detail panel
            below, so no separate Edit button. */}
        <div className="flex items-center gap-1.5 justify-end" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setStatus('approved')}
            disabled={rereading}
            aria-label="Approve"
            className={`w-9 h-9 rounded text-[15px] font-semibold border transition ${
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
            className={`w-9 h-9 rounded text-[15px] font-semibold border transition ${
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
              // Save the user's typed value verbatim. Title Case still runs
              // on AI/lookup-derived titles via the pipeline; a deliberate
              // edit is the user's authoritative formatting choice.
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
            {book.ddc ? (
              <ReadOnlyField label="DDC" value={book.ddc} mono />
            ) : null}
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
            {/* Phase-3 enrichment fields. Each renders only when set,
                so old records (no enrichment) display unchanged. */}
            {book.pageCount ? (
              <ReadOnlyField label="Pages" value={String(book.pageCount)} />
            ) : null}
            {book.edition ? (
              <ReadOnlyField label="Edition" value={book.edition} />
            ) : null}
            {book.binding ? (
              <ReadOnlyField label="Binding" value={book.binding} />
            ) : null}
            {book.language && book.language.toLowerCase() !== 'en' && book.language.toLowerCase() !== 'eng' ? (
              <ReadOnlyField label="Language" value={book.language} />
            ) : null}
            {book.series ? (
              <ReadOnlyField label="Series" value={book.series} />
            ) : null}
            {book.allAuthors && book.allAuthors.length > 1 ? (
              <ReadOnlyField label="All authors" value={book.allAuthors.join('; ')} />
            ) : null}
          </div>

          {book.synopsis ? (
            <div className="mb-3 text-[11px] text-text-secondary leading-relaxed">
              <span className="block uppercase tracking-wider text-[10px] text-text-quaternary mb-1">
                Synopsis
              </span>
              <span>
                {book.synopsis.length > 280
                  ? `${book.synopsis.slice(0, 280)}…`
                  : book.synopsis}
              </span>
            </div>
          ) : null}

          {book.lcshSubjects && book.lcshSubjects.length > 0 ? (
            <div className="mb-3">
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
              disabled={rereading || (!book.ocrImage && !book.title)}
              title={
                book.ocrImage
                  ? 'Re-run the AI on the same crop'
                  : book.title
                    ? 'Re-fetch metadata + re-infer tags using the current title/author (the high-res crop wasn’t preserved across reload, so Pass B is skipped)'
                    : 'Type a title above first — there’s nothing to reread'
              }
              className="text-xs px-3 py-1.5 rounded border border-line text-text-secondary hover:border-navy hover:text-navy hover:bg-navy-soft transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {rereading
                ? '⟳ Rereading…'
                : book.ocrImage
                  ? '↻ Reread'
                  : '↻ Refresh metadata'}
            </button>
            <button
              type="button"
              onClick={() => setAddCopyOpen(true)}
              disabled={rereading}
              title="Add a separate physical copy with its own format and ISBN. The new copy renders next to this one and exports as its own row."
              className="text-xs px-3 py-1.5 rounded border border-line text-text-secondary hover:border-navy hover:text-navy hover:bg-navy-soft transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + Add copy
            </button>
            {rereadErr && (
              <span className="text-[11px] text-carnegie-red">{rereadErr}</span>
            )}
          </div>
        </div>
      )}
      {addCopyOpen && (
        <AddCopyModal
          source={book}
          onSubmit={(values) => {
            addCopy(book.id, values);
            setAddCopyOpen(false);
          }}
          onClose={() => setAddCopyOpen(false)}
        />
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

