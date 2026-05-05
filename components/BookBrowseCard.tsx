'use client';

import { useState } from 'react';
import type { BookRecord } from '@/lib/types';
import { Cover } from './Cover';
import { TagChip } from './TagChip';

/**
 * Phone version of BookBrowseRow — read-only book card for the LCSH
 * browse surface. Cover + title/author/ISBN + static genre tags +
 * chevron, expanding inline to show synopsis, page count, edition, and
 * the full LCSH list. No edit / approve / reject / reread.
 */
export function BookBrowseCard({ book }: { book: BookRecord }) {
  const [open, setOpen] = useState(false);

  const safeGenre = Array.isArray(book.genreTags) ? book.genreTags : [];

  return (
    <div className="rounded-lg border border-line overflow-hidden bg-surface-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-stretch gap-3 p-3 text-left"
      >
        <Cover
          coverUrl={book.coverUrl}
          coverUrlFallbacks={book.coverUrlFallbacks}
          spineThumbnail={book.spineThumbnail}
          alt={book.title || 'unknown book'}
          className="w-12 h-[60px] rounded bg-surface-page border border-line-light overflow-hidden flex-shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="typo-card-title leading-tight line-clamp-2">
            {book.title || (
              <span className="italic opacity-60">Untitled spine</span>
            )}
          </div>
          <div className="text-[12px] text-text-secondary mt-0.5 line-clamp-1">
            {book.author || 'Unknown author'}
          </div>
          {book.isbn && (
            <div className="text-[11px] text-text-quaternary mt-0.5 font-mono">
              {book.isbn}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            {safeGenre.slice(0, 2).map((t) => (
              <TagChip key={t} tag={String(t)} variant="genre" size="sm" />
            ))}
            {safeGenre.length > 2 && (
              <span className="text-[11px] text-text-quaternary">
                +{safeGenre.length - 2}
              </span>
            )}
          </div>
        </div>
        <span
          aria-hidden
          className="flex-shrink-0 self-center text-text-tertiary transition-transform"
          style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ▸
        </span>
      </button>
      {open && (
        <div className="border-t border-line-light bg-surface-page px-4 py-3 space-y-3">
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
    </div>
  );
}
