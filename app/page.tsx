'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PhotoUploader } from '@/components/PhotoUploader';
import { ProcessingQueue } from '@/components/ProcessingQueue';
import { BatchProgress } from '@/components/BatchProgress';
import { useStore } from '@/lib/store';
import type { PhotoBatch } from '@/lib/types';
import { createThumbnail, loadImage, makeId } from '@/lib/pipeline';

const MIN_IMAGE_WIDTH = 1500;

export default function UploadPage() {
  const {
    state,
    addBatch,
    removeBatch,
    setPendingFile,
    hasPendingFile,
    processQueue,
  } = useStore();

  const [batchLabel, setBatchLabel] = useState('');
  const [batchNotes, setBatchNotes] = useState('');

  const queuedBatches = useMemo(
    () => state.batches.filter((b) => b.status === 'queued'),
    [state.batches]
  );

  const processing = state.processing;
  const isProcessing = processing?.isActive ?? false;

  async function handleFiles(files: File[]) {
    for (const file of files) {
      const id = makeId();
      let thumbnail = '';
      let lowRes = false;
      try {
        const loaded = await loadImage(file);
        if (loaded.width < MIN_IMAGE_WIDTH) lowRes = true;
        thumbnail = await createThumbnail(file);
      } catch {
        // Surface as an error in the batch
      }
      const trimmedLabel = batchLabel.trim();
      const trimmedNotes = batchNotes.trim();
      const batch: PhotoBatch = {
        id,
        filename: file.name,
        fileSize: file.size,
        thumbnail,
        status: lowRes ? 'error' : 'queued',
        error: lowRes
          ? `Image too small (< ${MIN_IMAGE_WIDTH}px wide). Please re-shoot at higher resolution.`
          : undefined,
        spinesDetected: 0,
        booksIdentified: 0,
        books: [],
        batchLabel: trimmedLabel || undefined,
        batchNotes: trimmedNotes || undefined,
      };
      addBatch(batch);
      if (!lowRes) setPendingFile(id, file);
    }
  }

  function handleRemove(id: string) {
    removeBatch(id);
  }

  // Only batches with a stored File handle can be processed. After a hard
  // reload File handles are gone, so even a "queued"-looking batch may be
  // unprocessable; we filter those out for the button.
  const processableQueued = queuedBatches.filter((b) => hasPendingFile(b.id));
  const canProcess = processableQueued.length > 0 && !isProcessing;

  return (
    <div className="space-y-8">
      <div className="text-center py-4">
        <h1 className="font-display text-4xl md:text-5xl text-ink dark:text-limestone" style={{ letterSpacing: '0.5px' }}>
          Photograph your shelves. We&apos;ll handle the rest.
        </h1>
      </div>

      {/* Batch inputs — grid layout with fixed row heights so the labels,
          fields, and helper paragraphs all share baselines across columns. */}
      <div
        className="bg-cream-50 dark:bg-ink-soft/60 rounded-lg p-5 grid grid-cols-1 md:grid-cols-2 gap-x-6"
        style={{ gridTemplateRows: 'auto auto auto' }}
      >
        {/* Row 1 — labels */}
        <label
          htmlFor="batch-label"
          className="block text-[11px] uppercase tracking-[0.18em] font-semibold text-ink/55 dark:text-cream-300/55 mb-2"
        >
          Batch label <span className="text-ink/35 dark:text-cream-300/35 normal-case font-normal tracking-normal">— optional</span>
        </label>
        <label
          htmlFor="batch-notes"
          className="block text-[11px] uppercase tracking-[0.18em] font-semibold text-ink/55 dark:text-cream-300/55 mb-2"
        >
          Batch notes <span className="text-ink/35 dark:text-cream-300/35 normal-case font-normal tracking-normal">— optional</span>
        </label>

        {/* Row 2 — fields, both forced to the same height */}
        <input
          id="batch-label"
          type="text"
          value={batchLabel}
          onChange={(e) => setBatchLabel(e.target.value)}
          placeholder='e.g. "Shelf 3", "Box 4", "Upstairs hallway"'
          disabled={isProcessing}
          className="w-full h-12 px-1 text-base bg-transparent border-0 border-b-2 border-brass/50 focus:outline-none focus:border-brass disabled:opacity-50 transition"
        />
        <input
          id="batch-notes"
          type="text"
          value={batchNotes}
          onChange={(e) => setBatchNotes(e.target.value)}
          placeholder='e.g. "All first editions, signed by author"'
          disabled={isProcessing}
          className="w-full h-12 px-1 text-base bg-transparent border-0 border-b-2 border-brass/50 focus:outline-none focus:border-brass disabled:opacity-50 transition"
        />

        {/* Row 3 — helper text */}
        <p className="mt-2 text-xs text-ink/50 dark:text-cream-300/50 leading-relaxed">
          Group photos by physical location. Choose how the label rides into
          LibraryThing on the Export screen.
        </p>
        <p className="mt-2 text-xs text-ink/50 dark:text-cream-300/50 leading-relaxed">
          Free-form notes applied to every book in this batch. Lands in
          LibraryThing&apos;s <span className="font-mono">COMMENTS</span> column.
        </p>
      </div>

      <PhotoUploader onFiles={handleFiles} disabled={isProcessing} />

      <ProcessingQueue batches={state.batches} onRemove={handleRemove} />

      {processing && (
        <div
          className={`rounded-2xl p-6 lg:p-8 space-y-5 shadow-sm border ${
            isProcessing
              ? 'bg-accent-soft/40 dark:bg-accent/10 border-accent/30 dark:border-accent/40'
              : 'bg-green-50/60 dark:bg-green-900/10 border-green-300 dark:border-green-800'
          }`}
        >
          <div className="flex items-center gap-3 flex-wrap">
            {isProcessing ? (
              <>
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-brass opacity-60 animate-pulse-dot" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-brass" />
                </span>
                <h2 className="font-serif text-2xl text-ink dark:text-cream-100">
                  Processing your shelf
                </h2>
                <span className="text-sm text-ink/60 dark:text-cream-300/60">
                  · this can take 30–90 seconds per photo · safe to navigate away
                </span>
              </>
            ) : (
              <>
                <span className="text-2xl text-green-700 dark:text-green-400">✓</span>
                <h2 className="font-serif text-2xl text-ink dark:text-cream-100">
                  Processing complete
                </h2>
                {state.allBooks.length > 0 && (
                  <Link
                    href="/review"
                    className="ml-auto text-sm px-4 py-2 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition"
                  >
                    Review {state.allBooks.length}{' '}
                    {state.allBooks.length === 1 ? 'book' : 'books'} →
                  </Link>
                )}
              </>
            )}
          </div>

          <BatchProgress
            total={processing.photoTotal}
            done={processing.photoDone}
            label="Photos"
            active={isProcessing}
          />
          {processing.bookTotal > 0 && (
            <BatchProgress
              total={processing.bookTotal}
              done={processing.bookDone}
              label="Spines read"
              active={isProcessing}
            />
          )}

          <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg px-4 py-3">
            <div className="text-xs uppercase tracking-wider text-ink/50 dark:text-cream-300/50 font-semibold mb-1">
              {isProcessing ? 'Current step' : 'Last step'}
            </div>
            <div className="text-base text-ink/85 dark:text-cream-200/85 font-mono">
              {processing.currentLabel}
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center pt-4 border-t border-cream-300 dark:border-ink-soft">
        <div className="text-sm text-ink/50 dark:text-cream-300/50">
          {state.batches.length} photo{state.batches.length !== 1 ? 's' : ''} ·{' '}
          {state.allBooks.length} book{state.allBooks.length !== 1 ? 's' : ''} identified
        </div>
        <button
          onClick={() => processQueue()}
          disabled={!canProcess}
          className="px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
        >
          {isProcessing
            ? 'Processing…'
            : processableQueued.length === 0
              ? 'Process all'
              : `Process all (${processableQueued.length})`}
        </button>
      </div>
    </div>
  );
}
