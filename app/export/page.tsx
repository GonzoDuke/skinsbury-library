'use client';

import Link from 'next/link';
import { useMemo, useState, useEffect } from 'react';
import { useStore } from '@/lib/store';
import { ExportPreview } from '@/components/ExportPreview';
import { exportFilename, generateCsv, type CsvOptions } from '@/lib/csv-export';
import type { BookRecord } from '@/lib/types';

const UNCATEGORIZED = '__uncategorized__';

export default function ExportPage() {
  const { state } = useStore();

  const approved = useMemo(
    () => state.allBooks.filter((b) => b.status === 'approved'),
    [state.allBooks]
  );
  const pending = state.allBooks.filter((b) => b.status === 'pending').length;
  const rejected = state.allBooks.filter((b) => b.status === 'rejected').length;

  // Group approved books by batch label.
  const batches = useMemo(() => {
    const map = new Map<string, BookRecord[]>();
    for (const b of approved) {
      const key = b.batchLabel ?? UNCATEGORIZED;
      const arr = map.get(key) ?? [];
      arr.push(b);
      map.set(key, arr);
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === UNCATEGORIZED && b !== UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED && a !== UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    });
    return keys.map((key) => ({
      key,
      label: key === UNCATEGORIZED ? 'Uncategorized' : key,
      books: map.get(key)!,
    }));
  }, [approved]);

  const hasMultipleBatches = batches.length > 1 || (batches.length === 1 && batches[0].key !== UNCATEGORIZED);
  const hasAnyBatchLabel = batches.some((b) => b.key !== UNCATEGORIZED);

  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(
    () => new Set(batches.map((b) => b.key))
  );
  const [splitByBatch, setSplitByBatch] = useState(false);
  const [collectionsFromBatch, setCollectionsFromBatch] = useState(true);
  const [tagsFromBatch, setTagsFromBatch] = useState(true);

  // Keep `selectedBatches` in sync as batches change (new uploads etc.)
  useEffect(() => {
    setSelectedBatches((prev) => {
      const next = new Set<string>();
      for (const b of batches) {
        if (prev.has(b.key) || prev.size === 0) next.add(b.key);
      }
      // If prev was empty (first render with non-empty batches), select all.
      if (prev.size === 0) {
        for (const b of batches) next.add(b.key);
      }
      return next;
    });
  }, [batches]);

  const booksToExport = useMemo(() => {
    return batches
      .filter((b) => selectedBatches.has(b.key))
      .flatMap((b) => b.books);
  }, [batches, selectedBatches]);

  const csvOptions: CsvOptions = {
    collectionsFromBatch: collectionsFromBatch && hasAnyBatchLabel,
    tagsFromBatch: tagsFromBatch && hasAnyBatchLabel,
  };

  function downloadOne(books: BookRecord[], label?: string) {
    if (books.length === 0) return;
    const csv = generateCsv(books, csvOptions);
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(books.length, new Date(), label);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    if (booksToExport.length === 0) return;
    if (splitByBatch) {
      // One file per selected batch, downloaded sequentially.
      for (const b of batches.filter((g) => selectedBatches.has(g.key))) {
        const labelForFilename = b.key === UNCATEGORIZED ? undefined : b.label;
        downloadOne(b.books, labelForFilename);
      }
    } else {
      downloadOne(booksToExport);
    }
  }

  if (state.allBooks.length === 0) {
    return (
      <div className="text-center py-16">
        <h1 className="font-serif text-3xl mb-3">Nothing to export yet</h1>
        <p className="text-sm text-ink/60 dark:text-cream-300/60 mb-6">
          Upload photos and review books before exporting.
        </p>
        <Link
          href="/"
          className="inline-block px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition"
        >
          Go to upload
        </Link>
      </div>
    );
  }

  function toggleBatch(key: string) {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-5xl mb-3 text-ink dark:text-limestone" style={{ letterSpacing: '0.5px' }}>Export to LibraryThing</h1>
        <p className="text-base text-ink/70 dark:text-cream-300/70 max-w-3xl leading-relaxed">
          Download a LibraryThing-compatible CSV. Only{' '}
          <span className="font-semibold">approved</span> books will be included.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-green-300 dark:border-green-800 rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 mb-1">
            Approved · will export
          </div>
          <div className="text-3xl font-serif text-green-700 dark:text-green-400">
            {booksToExport.length}
            {booksToExport.length !== approved.length && (
              <span className="text-base text-ink/50 dark:text-cream-300/50 font-sans">
                {' '}
                / {approved.length}
              </span>
            )}
          </div>
        </div>
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 mb-1">
            Pending · excluded
          </div>
          <div className="text-3xl font-serif text-amber-700 dark:text-amber-400">{pending}</div>
        </div>
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 mb-1">
            Rejected · excluded
          </div>
          <div className="text-3xl font-serif text-red-700 dark:text-red-400">{rejected}</div>
        </div>
      </div>

      {/* Pending warning */}
      {pending > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-lg px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-2">
          <span>⚠</span>
          <span>
            <strong>{pending}</strong> book{pending !== 1 ? 's' : ''} still pending review — only
            approved books will be exported.{' '}
            <Link href="/review" className="underline hover:text-amber-700">
              Go review →
            </Link>
          </span>
        </div>
      )}

      {/* Batch + label-routing controls */}
      {hasMultipleBatches && (
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-5 space-y-5">
          <div>
            <div className="text-xs uppercase tracking-wider font-semibold text-ink/60 dark:text-cream-300/60 mb-2">
              Batches to export
            </div>
            <div className="space-y-1.5">
              {batches.map((b) => (
                <label
                  key={b.key}
                  className="flex items-center gap-2 text-sm cursor-pointer hover:text-accent transition"
                >
                  <input
                    type="checkbox"
                    checked={selectedBatches.has(b.key)}
                    onChange={() => toggleBatch(b.key)}
                    className="accent-accent"
                  />
                  <span className="font-medium">{b.label}</span>
                  <span className="text-xs text-ink/50 dark:text-cream-300/50">
                    {b.books.length} book{b.books.length !== 1 ? 's' : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider font-semibold text-ink/60 dark:text-cream-300/60 mb-2">
              Output
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!splitByBatch}
                  onChange={() => setSplitByBatch(false)}
                  className="accent-accent"
                />
                One CSV combining all selected
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={splitByBatch}
                  onChange={() => setSplitByBatch(true)}
                  className="accent-accent"
                />
                Separate CSV per batch
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Where to put the batch label */}
      {hasAnyBatchLabel && (
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-5 space-y-3">
          <div className="text-xs uppercase tracking-wider font-semibold text-ink/60 dark:text-cream-300/60">
            Where to put the batch label in LibraryThing
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={collectionsFromBatch}
                onChange={(e) => setCollectionsFromBatch(e.target.checked)}
                className="accent-accent mt-1"
              />
              <span>
                <span className="font-medium">As a Collection</span>
                <span className="block text-[11px] text-ink/50 dark:text-cream-300/50">
                  LT&apos;s native shelf grouping. Goes in the <span className="font-mono">COLLECTIONS</span> column.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tagsFromBatch}
                onChange={(e) => setTagsFromBatch(e.target.checked)}
                className="accent-accent mt-1"
              />
              <span>
                <span className="font-medium">
                  As a tag (<span className="font-mono">location:Shelf 3</span>)
                </span>
                <span className="block text-[11px] text-ink/50 dark:text-cream-300/50">
                  Searchable in LT&apos;s tag cloud. Appended to the <span className="font-mono">TAGS</span> column.
                </span>
              </span>
            </label>
          </div>
          <div className="text-[11px] text-ink/40 dark:text-cream-300/40 italic">
            Pick neither, one, or both. Either way, books still group by batch in Review.
          </div>
        </div>
      )}

      {/* CSV preview */}
      <div>
        <h2 className="text-sm uppercase tracking-wider font-semibold text-ink/50 dark:text-cream-300/50 mb-2">
          CSV preview {splitByBatch && hasMultipleBatches ? '(first selected batch)' : ''}
        </h2>
        <ExportPreview
          books={
            splitByBatch && hasMultipleBatches
              ? batches.find((b) => selectedBatches.has(b.key))?.books ?? []
              : booksToExport
          }
          options={csvOptions}
        />
      </div>

      {/* Download */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 pt-4 border-t border-cream-300 dark:border-ink-soft">
        <div className="text-xs text-ink/60 dark:text-cream-300/60 max-w-md leading-relaxed">
          To import: log into LibraryThing, go to{' '}
          <span className="font-mono">More → Import books</span>, choose{' '}
          <span className="font-mono">CSV/text file</span>, and upload the file you download here.
        </div>
        <button
          onClick={downloadCsv}
          disabled={booksToExport.length === 0}
          className="px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
        >
          {splitByBatch && hasMultipleBatches
            ? `Download ${selectedBatches.size} CSV${selectedBatches.size !== 1 ? 's' : ''}`
            : `Download CSV (${booksToExport.length})`}
        </button>
      </div>
    </div>
  );
}
