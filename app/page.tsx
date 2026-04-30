'use client';

import Link from 'next/link';
import { useMemo } from 'react';
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
      <div>
        <h1 className="font-serif text-5xl mb-3 tracking-tight">Upload bookshelf photos</h1>
        <p className="text-base text-ink/70 dark:text-cream-300/70 max-w-3xl leading-relaxed">
          Drop one or more photos of a bookshelf. We&apos;ll locate each spine, read it,
          look up its metadata, infer tags, and let you review every result before any
          export. Nothing leaves your machine for LibraryThing without your explicit
          approval.
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
                  <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-pulse-dot" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-accent" />
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
