'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PhotoUploader } from '@/components/PhotoUploader';
import { ProcessingQueue } from '@/components/ProcessingQueue';
import { BatchProgress } from '@/components/BatchProgress';
import { useStore } from '@/lib/store';
import type { PhotoBatch } from '@/lib/types';
import {
  buildBookFromCrop,
  createThumbnail,
  cropSpine,
  dedupeBooks,
  detectSpines,
  loadImage,
  makeId,
} from '@/lib/pipeline';
import type { BookRecord } from '@/lib/types';

const MIN_IMAGE_WIDTH = 1500;

export default function UploadPage() {
  const router = useRouter();
  const { state, addBatch, updateBatch, removeBatch, addBook } = useStore();
  const [pendingFiles, setPendingFiles] = useState<Map<string, File>>(new Map());
  const [isProcessing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{
    photoDone: number;
    photoTotal: number;
    bookDone: number;
    bookTotal: number;
    currentLabel: string;
  } | null>(null);

  const queuedBatches = useMemo(
    () => state.batches.filter((b) => b.status === 'queued'),
    [state.batches]
  );

  async function handleFiles(files: File[]) {
    for (const file of files) {
      const id = makeId();
      let thumbnail = '';
      let lowRes = false;
      try {
        const loaded = await loadImage(file);
        if (loaded.width < MIN_IMAGE_WIDTH) {
          lowRes = true;
        }
        thumbnail = await createThumbnail(file);
      } catch {
        // ignore — will surface as an error in processing
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
      if (!lowRes) {
        setPendingFiles((prev) => {
          const next = new Map(prev);
          next.set(id, file);
          return next;
        });
      }
    }
  }

  async function processAll() {
    if (queuedBatches.length === 0 || isProcessing) return;
    setProcessing(true);
    const total = queuedBatches.length;
    let photoDone = 0;
    let aggregateBookTotal = 0;
    let aggregateBookDone = 0;
    setProgress({
      photoDone: 0,
      photoTotal: total,
      bookDone: 0,
      bookTotal: 0,
      currentLabel: 'Starting…',
    });

    for (const batch of queuedBatches) {
      const file = pendingFiles.get(batch.id);
      if (!file) {
        updateBatch(batch.id, { status: 'error', error: 'File not in memory' });
        photoDone += 1;
        continue;
      }

      updateBatch(batch.id, { status: 'processing' });
      setProgress({
        photoDone,
        photoTotal: total,
        bookDone: aggregateBookDone,
        bookTotal: aggregateBookTotal,
        currentLabel: `Detecting spines in ${batch.filename}…`,
      });

      try {
        // PASS A — Detection
        const detections = await detectSpines(file);
        updateBatch(batch.id, { spinesDetected: detections.length });
        aggregateBookTotal += detections.length;
        setProgress({
          photoDone,
          photoTotal: total,
          bookDone: aggregateBookDone,
          bookTotal: aggregateBookTotal,
          currentLabel: `Found ${detections.length} spines — reading them…`,
        });

        // Load full-resolution image once for client-side cropping
        const loaded = await loadImage(file);

        // PASS B + lookup + tag inference, per spine. Collect kept books and
        // dedupe at the end (Pass A occasionally splits one spine into two
        // adjacent bboxes; we collapse those before exposing them in Review).
        const keptBooks: BookRecord[] = [];

        for (let i = 0; i < detections.length; i++) {
          const det = detections[i];
          const bbox = { x: det.x, y: det.y, width: det.width, height: det.height };
          const ocrCrop = cropSpine(loaded, bbox, { paddingPct: 10, maxLongEdge: 1600 });
          const spineThumbnail = cropSpine(loaded, bbox, {
            paddingPct: 5,
            maxLongEdge: 220,
            quality: 0.8,
          });

          setProgress({
            photoDone,
            photoTotal: total,
            bookDone: aggregateBookDone,
            bookTotal: aggregateBookTotal,
            currentLabel: `Reading spine ${i + 1} of ${detections.length}…`,
          });

          const { book, kept } = await buildBookFromCrop({
            position: det.position ?? i + 1,
            bbox,
            spineThumbnail,
            ocrCrop,
            sourcePhoto: batch.filename,
          });

          aggregateBookDone += 1;
          if (kept) {
            keptBooks.push(book);
          }

          setProgress({
            photoDone,
            photoTotal: total,
            bookDone: aggregateBookDone,
            bookTotal: aggregateBookTotal,
            currentLabel: kept
              ? book.title
                ? `Identified: ${book.title}`
                : `Spine #${det.position} — verify`
              : `Skipped illegible spine #${det.position}`,
          });
        }

        const finalBooks = dedupeBooks(keptBooks);
        for (const book of finalBooks) {
          addBook(batch.id, book);
        }

        updateBatch(batch.id, { status: 'done' });
      } catch (err: any) {
        updateBatch(batch.id, {
          status: 'error',
          error: err?.message ?? 'Unknown error',
        });
      }
      photoDone += 1;
    }

    setPendingFiles(new Map());
    setProcessing(false);
    setProgress(null);
    router.push('/review');
  }

  function handleRemove(id: string) {
    removeBatch(id);
    setPendingFiles((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  const canProcess = queuedBatches.length > 0 && !isProcessing;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl mb-2">Upload bookshelf photos</h1>
        <p className="text-sm text-ink/60 dark:text-cream-300/60 max-w-2xl">
          Drop one or more photos of a bookshelf. We&apos;ll locate each spine, read it,
          look up its metadata, infer tags, and let you review every result before any
          export. Nothing leaves your machine for LibraryThing without your explicit
          approval.
        </p>
      </div>

      <PhotoUploader onFiles={handleFiles} disabled={isProcessing} />

      <ProcessingQueue batches={state.batches} onRemove={handleRemove} />

      {progress && (
        <div className="space-y-3">
          <BatchProgress
            total={progress.photoTotal}
            done={progress.photoDone}
            label="Photos processed"
          />
          {progress.bookTotal > 0 && (
            <BatchProgress
              total={progress.bookTotal}
              done={progress.bookDone}
              label="Spines read"
            />
          )}
          <div className="text-xs text-ink/60 dark:text-cream-300/60 italic">
            {progress.currentLabel}
          </div>
        </div>
      )}

      <div className="flex justify-between items-center pt-4 border-t border-cream-300 dark:border-ink-soft">
        <div className="text-xs text-ink/50 dark:text-cream-300/50">
          {state.batches.length} photo{state.batches.length !== 1 ? 's' : ''} ·{' '}
          {state.allBooks.length} book{state.allBooks.length !== 1 ? 's' : ''} identified
        </div>
        <button
          onClick={processAll}
          disabled={!canProcess}
          className="px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
        >
          {isProcessing
            ? 'Processing…'
            : queuedBatches.length === 0
              ? 'Process all'
              : `Process all (${queuedBatches.length})`}
        </button>
      </div>
    </div>
  );
}
