'use client';

import type { BookRecord } from '@/lib/types';
import { CSV_HEADERS, bookToCsvRow, type CsvOptions } from '@/lib/csv-export';

export function ExportPreview({
  books,
  options,
}: {
  books: BookRecord[];
  options?: CsvOptions;
}) {
  if (books.length === 0) {
    return (
      <div className="text-sm text-ink/50 dark:text-cream-300/50 italic p-8 text-center border border-dashed border-cream-300 dark:border-ink-soft rounded-lg">
        No approved books to preview yet.
      </div>
    );
  }

  return (
    <div className="border border-cream-300 dark:border-ink-soft rounded-lg overflow-hidden bg-limestone dark:bg-ink-soft/60">
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="text-xs font-mono w-full">
          {/* Sticky header — stays visible when the user scrolls a long
              preview to see what each column actually contains. */}
          <thead className="sticky top-0 z-[1]">
            <tr className="bg-brass-soft dark:bg-ink-soft text-ink/70 dark:text-cream-300/70 shadow-[0_1px_0_0_rgba(0,0,0,0.06)]">
              {CSV_HEADERS.map((h) => (
                <th
                  key={h}
                  className="text-left font-semibold px-3 py-2 whitespace-nowrap border-b border-cream-300 dark:border-ink-soft"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {books.map((book, rowIdx) => {
              const row = bookToCsvRow(book, options);
              // Alternating row backgrounds so wide tables stay readable.
              // Page (#F6F6F4) on even rows, card (#FFFFFF) on odd matches
              // the new palette without screaming for attention.
              const zebra =
                rowIdx % 2 === 0
                  ? 'bg-marble dark:bg-ink/40'
                  : 'bg-limestone dark:bg-ink-soft/60';
              return (
                <tr
                  key={book.id}
                  className={`${zebra} border-b border-cream-200 dark:border-ink-soft/50 last:border-b-0`}
                >
                  {row.map((cell, i) => (
                    <td
                      key={i}
                      className="px-3 py-2 align-top whitespace-nowrap max-w-[260px] overflow-hidden text-ellipsis"
                      title={cell}
                    >
                      {cell || <span className="opacity-40">—</span>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
