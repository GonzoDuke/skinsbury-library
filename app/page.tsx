'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PhotoUploader } from '@/components/PhotoUploader';
import { ProcessingQueue } from '@/components/ProcessingQueue';
import { BatchProgress } from '@/components/BatchProgress';
import { CropModal } from '@/components/CropModal';
import { useDarkMode, useStore } from '@/lib/store';
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

  // Dark-mode toggle moved to a small text link below the queue summary.
  // Mirrors the document.documentElement class so the label stays accurate
  // after a page-load preference apply.
  const { setDark } = useDarkMode();
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  const queuedBatches = useMemo(
    () => state.batches.filter((b) => b.status === 'queued'),
    [state.batches]
  );

  const processing = state.processing;
  const isProcessing = processing?.isActive ?? false;

  // Files arriving from the camera or the gallery picker are queued for the
  // crop step rather than enrolled as batches directly. Each file gets a
  // CropModal pass — the user can frame just the shelf they care about, or
  // tap "Use full image" to pass it through unchanged. We snapshot the
  // batch label and notes at queue time so a label change between shots
  // doesn't leak into already-queued files.
  interface PendingCrop {
    id: string;
    file: File;
    batchLabel: string;
    batchNotes: string;
  }
  const [cropQueue, setCropQueue] = useState<PendingCrop[]>([]);

  function enqueueForCrop(files: File[]) {
    if (files.length === 0) return;
    const trimmedLabel = batchLabel.trim();
    const trimmedNotes = batchNotes.trim();
    const additions: PendingCrop[] = files.map((file) => ({
      id: makeId(),
      file,
      batchLabel: trimmedLabel,
      batchNotes: trimmedNotes,
    }));
    setCropQueue((prev) => [...prev, ...additions]);
  }

  /**
   * Enroll a fully-resolved source `File` as a queued batch. After this
   * call, every downstream step — Pass A detect, Pass B per-spine crops,
   * Reread, "Add missing book" — reads from `pendingFiles[id]`, which is
   * exactly the `file` argument here. When the user cropped, `file` is
   * the cropped JPEG produced by CropModal and the original is gone.
   */
  async function commitFile(
    file: File,
    savedLabel: string,
    savedNotes: string,
    croppedFrom?: string
  ) {
    const id = makeId();
    let thumbnail = '';
    let lowRes = false;
    let dims: { width: number; height: number } | undefined;
    try {
      const loaded = await loadImage(file);
      dims = { width: loaded.width, height: loaded.height };
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
      batchLabel: savedLabel || undefined,
      batchNotes: savedNotes || undefined,
      croppedFrom,
      sourceDimensions: dims,
    };
    addBatch(batch);
    if (!lowRes) setPendingFile(id, file);
  }

  function handleFiles(files: File[]) {
    enqueueForCrop(files);
  }

  // Crop confirm/skip/cancel — pop the head from cropQueue (pure state
  // update) and run side effects (commitFile) outside the updater so
  // strict-mode double-invocation can't enrol the same file twice.
  function handleCropConfirm(cropped: File) {
    const head = cropQueue[0];
    if (!head) return;
    setCropQueue((prev) => prev.slice(1));
    // The cropped JPEG REPLACES the original everywhere downstream. We
    // record the original filename on the batch (`croppedFrom`) so the UI
    // can show "Cropped from <name>" and any future debug pass can verify
    // at a glance that the pipeline is running on cropped pixels.
    void commitFile(cropped, head.batchLabel, head.batchNotes, head.file.name);
  }

  function handleCropSkip(original: File) {
    const head = cropQueue[0];
    if (!head) return;
    setCropQueue((prev) => prev.slice(1));
    void commitFile(original, head.batchLabel, head.batchNotes);
  }

  function handleCropCancel() {
    setCropQueue((prev) => prev.slice(1));
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
    <div className="space-y-4">
      <h1 className="typo-page-title">Upload</h1>

      {/* Batch inputs — v3 styling: white card, 1px line border, navy
          focus ring. Helper text directly under the field rather than
          floating in a separate row. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label htmlFor="batch-label" className="typo-label block mb-1">
            Batch label
          </label>
          <input
            id="batch-label"
            type="text"
            value={batchLabel}
            onChange={(e) => setBatchLabel(e.target.value)}
            placeholder='Shelf 3, Box 4, Upstairs hallway...'
            disabled={isProcessing}
            className="w-full bg-surface-card border border-line rounded-md px-3 py-2 text-[13px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy disabled:opacity-50 transition-colors"
          />
          <div className="text-[10px] text-text-quaternary mt-0.5">
            Groups photos by physical location
          </div>
        </div>
        <div>
          <label htmlFor="batch-notes" className="typo-label block mb-1">
            Notes
          </label>
          <input
            id="batch-notes"
            type="text"
            value={batchNotes}
            onChange={(e) => setBatchNotes(e.target.value)}
            placeholder='First editions, signed copies...'
            disabled={isProcessing}
            className="w-full bg-surface-card border border-line rounded-md px-3 py-2 text-[13px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy disabled:opacity-50 transition-colors"
          />
          <div className="text-[10px] text-text-quaternary mt-0.5">
            Free-form &rarr; LibraryThing COMMENTS
          </div>
        </div>
      </div>

      <PhotoUploader onFiles={handleFiles} disabled={isProcessing} />

      {processing && (
        <div
          className={`rounded-lg p-5 space-y-4 border ${
            isProcessing
              ? 'bg-navy-soft border-navy/30'
              : 'bg-carnegie-green-soft border-carnegie-green/30'
          }`}
        >
          <div className="flex items-center gap-3 flex-wrap">
            {isProcessing ? (
              <>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-navy opacity-50 animate-pulse-dot" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-navy" />
                </span>
                <span className="text-[14px] font-semibold text-text-primary">
                  Processing your shelf
                </span>
                <span className="text-[12px] text-text-tertiary">
                  · 30–90 seconds per photo · safe to navigate away
                </span>
              </>
            ) : (
              <>
                <span className="text-[16px] text-carnegie-green">✓</span>
                <span className="text-[14px] font-semibold text-text-primary">
                  Processing complete
                </span>
                {state.allBooks.length > 0 && (
                  <Link
                    href="/review"
                    className="ml-auto text-[13px] font-medium px-4 py-1.5 rounded-md bg-navy text-white hover:bg-navy-deep transition"
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

          <div className="bg-surface-card dark:bg-ink/40 border border-line rounded-md px-3 py-2">
            <div className="typo-label mb-0.5">
              {isProcessing ? 'Current step' : 'Last step'}
            </div>
            <div className="text-[13px] text-text-primary font-mono">
              {processing.currentLabel}
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-start pt-3 mt-2 border-t border-line dark:border-[#3A3836]">
        <div>
          <div className="text-[12px] text-text-tertiary">
            {state.batches.length} photo{state.batches.length !== 1 ? 's' : ''} ·{' '}
            {state.allBooks.length} book{state.allBooks.length !== 1 ? 's' : ''} identified
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !isDark;
              setDark(next);
              setIsDark(next);
            }}
            className="mt-1 text-[11px] text-text-quaternary hover:text-navy underline-offset-2 hover:underline transition"
            aria-label="Toggle dark mode"
          >
            {isDark ? '☀ Switch to light mode' : '☾ Switch to dark mode'}
          </button>
        </div>
        <button
          onClick={() => processQueue()}
          disabled={!canProcess}
          className="px-5 py-2 rounded-md bg-navy text-white hover:bg-navy-deep disabled:opacity-40 disabled:cursor-not-allowed transition text-[13px] font-medium"
        >
          {isProcessing
            ? 'Processing…'
            : processableQueued.length === 0
              ? 'Process all'
              : `Process all (${processableQueued.length})`}
        </button>
      </div>

      {/* Inline crop step. Renders one modal per queued file; advancing
          happens inside the confirm/skip/cancel handlers. Keyed on the
          first item's id so React tears down and rebuilds between files
          (resets pointer state, image refs, animation phase). */}
      {cropQueue.length > 0 && (
        <CropModal
          key={cropQueue[0].id}
          file={cropQueue[0].file}
          queueIndex={1}
          queueTotal={cropQueue.length}
          onConfirm={handleCropConfirm}
          onSkip={handleCropSkip}
          onCancel={handleCropCancel}
        />
      )}
    </div>
  );
}

