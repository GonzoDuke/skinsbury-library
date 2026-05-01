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
      <div className="overflow-x-auto">
        <table className="text-xs font-mono w-full">
          <thead>
            <tr className="bg-brass-soft dark:bg-ink-soft text-ink/70 dark:text-cream-300/70">
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
            {books.map((book) => {
              const row = bookToCsvRow(book, options);
              return (
                <tr
                  key={book.id}
                  className="border-b border-cream-200 dark:border-ink-soft/50 last:border-b-0"
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
