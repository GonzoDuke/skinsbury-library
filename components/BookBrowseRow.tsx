'use client';

import { useState } from 'react';
import type { BookRecord } from '@/lib/types';
import { Cover } from './Cover';
import { TagChip } from './TagChip';

/**
 * Read-only row for the LCSH browse surface (desktop / tablet, ≥md).
 * Cover + title/author/ISBN + static genre tags + chevron. Click expands
 * inline to show synopsis, page count, edition, and the full LCSH list
 * for the book. No edit, approve/reject, or reread — those belong on
 * the Review surface.
 */
export function BookBrowseRow({ book }: { book: BookRecord }) {
  const [open, setOpen] = useState(false);

  const safeGenre = Array.isArray(book.genreTags) ? book.genreTags : [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full grid grid-cols-[64px_1fr_auto_18px] items-center gap-4 px-[16px] py-[12px] border-b border-line-light hover:bg-navy-soft/40 transition-colors text-left cursor-pointer"
      >
        <Cover
          coverUrl={book.coverUrl}
          coverUrlFallbacks={book.coverUrlFallbacks}
          spineThumbnail={book.spineThumbnail}
          alt={book.title || 'unknown book'}
          className="w-12 h-[60px] rounded bg-surface-page border border-line-light overflow-hidden"
        />
        <div className="min-w-0">
          <div className="typo-card-title truncate">
            {book.title || (
              <span className="italic opacity-60">Untitled spine</span>
            )}
          </div>
          <div className="text-[13px] text-text-secondary mt-0.5 truncate">
            {book.author || 'Unknown author'}
            {book.isbn && (
              <>
                <span className="mx-1.5 text-text-quaternary">·</span>
                <span className="font-mono text-[12px]">{book.isbn}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-[360px]">
          {safeGenre.slice(0, 3).map((t) => {
            const tag = String(t);
            return <TagChip key={tag} tag={tag} variant="genre" size="sm" />;
          })}
          {safeGenre.length > 3 && (
            <span className="text-[12px] text-text-quaternary">
              +{safeGenre.length - 3}
            </span>
          )}
        </div>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="bg-surface-page px-[80px] py-[14px] border-b border-line space-y-3">
          {(book.pageCount || book.edition) && (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-text-secondary">
              {book.pageCount ? (
                <span>
                  <span className="typo-label mr-1">Pages</span>
                  {book.pageCount}
                </span>
              ) : null}
              {book.edition ? (
                <span>
                  <span className="typo-label mr-1">Edition</span>
                  {book.edition}
                </span>
              ) : null}
            </div>
          )}
          {book.synopsis ? (
            <div className="text-[12px] text-text-secondary leading-relaxed">
              <span className="block typo-label mb-1">Synopsis</span>
              {book.synopsis.length > 280
                ? `${book.synopsis.slice(0, 280)}…`
                : book.synopsis}
            </div>
          ) : null}
          {book.lcshSubjects && book.lcshSubjects.length > 0 ? (
            <div className="text-[12px] text-text-secondary leading-relaxed">
              <span className="block typo-label mb-1">All LCSH headings</span>
              <ul className="space-y-0.5 font-mono text-[11.5px]">
                {book.lcshSubjects.map((h, i) => (
                  <li key={`${i}-${h}`}>{h}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      className="flex-shrink-0 text-text-tertiary transition-transform"
      style={{
        display: 'inline-flex',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        fontSize: 12,
        lineHeight: 1,
      }}
    >
      ▸
    </span>
  );
}
