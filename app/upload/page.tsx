'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PhotoUploader } from '@/components/PhotoUploader';
import { ProcessingQueue } from '@/components/ProcessingQueue';
import { BatchProgress } from '@/components/BatchProgress';
import { CropModal } from '@/components/CropModal';
import { BarcodeScanner, type BarcodeScanPreview } from '@/components/BarcodeScanner';
import { ManualBookEntryModal, type ManualBookEntrySubmit } from '@/components/ManualBookEntryModal';
import { useDarkMode, useStore } from '@/lib/store';
import type { BookRecord, PhotoBatch } from '@/lib/types';
import { addManualBook, createThumbnail, loadImage, makeId } from '@/lib/pipeline';
import { processIsbnScan } from '@/lib/scan-pipeline';
import {
  getLedgerBatches,
  loadLedger,
  syncLedgerFromRepo,
  type LedgerBatch,
  type LedgerEntry,
} from '@/lib/export-ledger';
import { syncCorrectionsFromRepo } from '@/lib/corrections-log';
import { getDefaultBatchLabel } from '@/lib/batch-labels';
import { fireUndo } from '@/components/UndoToast';

// 1200px wide is the realistic floor we still get useful spine-detection
// out of. Phone in-app cameras frequently deliver 1280×720 streams, which
// would silently fail at the old 1500px threshold even though the model
// can read those just fine after the per-spine crop.
const MIN_IMAGE_WIDTH = 1200;

export default function UploadPage() {
  const {
    state,
    addBatch,
    addBook,
    removeBatch,
    setPendingFile,
    hasPendingFile,
    getPendingFile,
    processQueue,
  } = useStore();

  const stateRef = useRef(state);
  stateRef.current = state;

  // ---- Barcode scanning -------------------------------------------------
  // The scanner mounts on demand and survives until the user taps Done.
  // A single scan-batch is created the first time the user reads a barcode
  // in this session; subsequent scans add into that same batch so all
  // scanned books group together on Review.
  const [scannerOpen, setScannerOpen] = useState(false);
  const scanBatchIdRef = useRef<string | null>(null);
  const scanPositionRef = useRef(0);
  const scanInflightRef = useRef(0);
  const scanErrorRef = useRef<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  function ensureScanBatch(): string {
    if (scanBatchIdRef.current) return scanBatchIdRef.current;
    const id = makeId();
    const now = new Date();
    const trimmedLabel = batchLabel.trim();
    const resolvedLabel =
      trimmedLabel ||
      getDefaultBatchLabel('scan', stateRef.current.batches, loadLedger(), now);
    const batch: PhotoBatch = {
      id,
      filename: `Barcode scans · ${now.toLocaleString()}`,
      fileSize: 0,
      thumbnail: '',
      // Status='done' from the start — there's no pipeline pass to run
      // for scanned books; the lookup happens per-scan in the background.
      status: 'done',
      spinesDetected: 0,
      booksIdentified: 0,
      books: [],
      batchLabel: resolvedLabel,
      batchNotes: batchNotes.trim() || undefined,
    };
    addBatch(batch);
    scanBatchIdRef.current = id;
    scanPositionRef.current = 0;
    return id;
  }

  async function handleScan(isbn: string, preview: BarcodeScanPreview | null) {
    const batchId = ensureScanBatch();
    scanPositionRef.current += 1;
    const position = scanPositionRef.current;
    scanInflightRef.current += 1;
    try {
      const book = await processIsbnScan({
        isbn,
        position,
        batchLabel: batchLabel.trim() || undefined,
        batchNotes: batchNotes.trim() || undefined,
        previewResult: preview,
      });
      addBook(batchId, book);
    } catch (err) {
      scanErrorRef.current =
        err instanceof Error ? err.message : 'Lookup failed.';
      setScanError(scanErrorRef.current);
    } finally {
      scanInflightRef.current -= 1;
    }
  }

  function handleScannerClose() {
    setScannerOpen(false);
    // Wait briefly so any in-flight scans complete and their addBook
    // dispatches land before we evaluate the batch's final state.
    const batchId = scanBatchIdRef.current;
    scanBatchIdRef.current = null;
    if (!batchId) return;
    const flush = () => {
      if (scanInflightRef.current > 0) {
        window.setTimeout(flush, 200);
        return;
      }
      const finalized = stateRef.current.batches.find((b) => b.id === batchId);
      if (finalized && finalized.books.length === 0) {
        // Scanner closed without any successful scans — drop the empty
        // batch so it doesn't clutter the queue.
        removeBatch(batchId);
      }
    };
    flush();
  }

  // ---- Manual entry ----------------------------------------------------
  // The modal is rendered at page level and owned by the upload page.
  // A lazy "Manual entries" batch is created on first submit; subsequent
  // entries this session group together so the user can review them all
  // at once. Same lifecycle pattern as scan batches.
  const [manualOpen, setManualOpen] = useState(false);
  const manualBatchIdRef = useRef<string | null>(null);
  const manualInflightRef = useRef(0);

  function ensureManualBatch(): string {
    if (manualBatchIdRef.current) return manualBatchIdRef.current;
    const id = makeId();
    const now = new Date();
    const trimmedLabel = batchLabel.trim();
    const resolvedLabel =
      trimmedLabel ||
      getDefaultBatchLabel('manual', stateRef.current.batches, loadLedger(), now);
    const batch: PhotoBatch = {
      id,
      filename: `Manual entries · ${now.toLocaleString()}`,
      fileSize: 0,
      thumbnail: '',
      status: 'done',
      spinesDetected: 0,
      booksIdentified: 0,
      books: [],
      batchLabel: resolvedLabel,
      batchNotes: batchNotes.trim() || undefined,
    };
    addBatch(batch);
    manualBatchIdRef.current = id;
    return id;
  }

  function handleManualSubmit(values: ManualBookEntrySubmit) {
    // Close immediately — lookup is async, the user shouldn't wait. The
    // book will appear on Review whenever the lookup resolves.
    setManualOpen(false);
    const batchId = ensureManualBatch();
    manualInflightRef.current += 1;
    addManualBook({
      title: values.title,
      author: values.author,
      isbn: values.isbn || undefined,
      sourcePhoto: 'manual-entry',
      batchLabel: batchLabel.trim() || undefined,
      batchNotes: batchNotes.trim() || undefined,
    })
      .then((book) => {
        addBook(batchId, book);
      })
      .catch(() => {
        // Lookup failed entirely — surface a minimal stub so the user
        // sees their entry on Review and can fix from there.
        const stub: BookRecord = {
          id: makeId(),
          spineRead: {
            position: 9999,
            rawText: `${values.title}${values.author ? ' — ' + values.author : ''}`,
            title: values.title,
            author: values.author,
            confidence: 'LOW',
          },
          title: values.title,
          author: values.author,
          authorLF: '',
          isbn: values.isbn,
          publisher: '',
          publicationYear: 0,
          lcc: '',
          genreTags: [],
          formTags: [],
          confidence: 'LOW',
          reasoning: '',
          status: 'pending',
          warnings: ['Basic details added. Edit fields and tap Reread for richer metadata.'],
          sourcePhoto: 'manual-entry',
          batchLabel: batchLabel.trim() || undefined,
          batchNotes: batchNotes.trim() || undefined,
          lookupSource: 'none',
          lccSource: 'none',
          manuallyAdded: true,
          original: {
            title: values.title,
            author: values.author,
            isbn: values.isbn,
            publisher: '',
            publicationYear: 0,
            lcc: '',
          },
        };
        addBook(batchId, stub);
      })
      .finally(() => {
        manualInflightRef.current -= 1;
      });
  }

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  // Refresh from cloud — pulls the export ledger and corrections log.
  // Pending in-flight batches no longer sync across devices, so this
  // doesn't fan out to /api/pending-batches. Useful when another device
  // exported books and we want this device's "previously exported"
  // flagging to catch up.
  async function refreshFromCloud() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const [remoteLedger, remoteCorrections] = await Promise.all([
        syncLedgerFromRepo(),
        syncCorrectionsFromRepo(),
      ]);
      if (!remoteLedger && !remoteCorrections) {
        setRefreshMsg('Sync unavailable.');
      } else {
        setRefreshMsg('Synced.');
      }
    } catch {
      setRefreshMsg('Refresh failed.');
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(null), 3500);
    }
  }

  const [batchLabel, setBatchLabel] = useState('');
  const [batchNotes, setBatchNotes] = useState('');
  // Past labels pulled from the export ledger so the user can pick a
  // previously-used label rather than retyping. Loaded once on mount;
  // re-derived when the ledger sync completes via the same effect.
  const [pastLabels, setPastLabels] = useState<string[]>([]);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  useEffect(() => {
    const labels = getLedgerBatches()
      .map((b) => b.batchLabel)
      .filter((s): s is string => !!s && s.trim().length > 0);
    // Distinct, alphabetical so the dropdown reads like a stable list.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const l of labels) {
      if (!seen.has(l)) {
        seen.add(l);
        unique.push(l);
      }
    }
    unique.sort((a, b) => a.localeCompare(b));
    setPastLabels(unique);
  }, [state.allBooks.length]);

  // Listen for the sidebar's New session click — wipes the local
  // input state on the upload page so the user lands on a truly clean
  // page. The store-level reset is fired by AppShell.
  useEffect(() => {
    function onCleared() {
      setBatchLabel('');
      setBatchNotes('');
    }
    window.addEventListener('carnegie:session-cleared', onCleared);
    return () =>
      window.removeEventListener('carnegie:session-cleared', onCleared);
  }, []);

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

  // Post-processing summary toast. Fires once when processQueue
  // resolves (finishedAt becomes set); auto-dismisses after 5s.
  // Counts books and unreadable spines across the just-finished
  // batches: spinesDetected - booksIdentified per batch.
  const [summaryToast, setSummaryToast] = useState<string | null>(null);
  const lastFinishedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const finishedAt = processing?.finishedAt;
    if (!finishedAt || finishedAt === lastFinishedAtRef.current) return;
    lastFinishedAtRef.current = finishedAt;
    let books = 0;
    let unreadable = 0;
    for (const b of state.batches) {
      if (b.status === 'done') {
        books += b.booksIdentified;
        unreadable += Math.max(0, b.spinesDetected - b.booksIdentified);
      }
    }
    const parts: string[] = [];
    parts.push(`${books} ${books === 1 ? 'book' : 'books'} identified`);
    if (unreadable > 0) {
      parts.push(`${unreadable} ${unreadable === 1 ? 'spine' : 'spines'} unreadable`);
    }
    setSummaryToast(`${parts.join(' · ')} — see Review for details.`);
    const t = window.setTimeout(() => setSummaryToast(null), 5000);

    // Background-tab attention. Browser notification when permitted +
    // a short chime via WebAudio (no asset needed) + a vibration pulse
    // on phones that support it. All three are best-effort and silent
    // failures — none of them block the toast.
    if (typeof window !== 'undefined' && document.hidden) {
      try {
        if ('Notification' in window) {
          if (Notification.permission === 'granted') {
            new Notification('Carnegie', {
              body: `Processing complete — ${books} ${
                books === 1 ? 'book' : 'books'
              } ready for review.`,
              icon: '/icon-192.png',
            });
          } else if (Notification.permission === 'default') {
            // Permission requests in Chrome require a user gesture, but
            // the original "Process all" tap counts. Best-effort.
            Notification.requestPermission().catch(() => {});
          }
        }
      } catch {
        // ignore
      }
    }
    try {
      const Ctor =
        (window as { AudioContext?: typeof AudioContext }).AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctor) {
        const ctx = new Ctor();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        // Two-note chime: 880Hz → 1320Hz, 80ms each, soft attack so it
        // doesn't pop. Volume capped so a quiet room hears it without
        // a noisy one being annoyed.
        osc.type = 'sine';
        osc.connect(gain);
        gain.connect(ctx.destination);
        const now = ctx.currentTime;
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1320, now + 0.09);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.24);
        osc.onended = () => ctx.close().catch(() => {});
      }
    } catch {
      // ignore — no AudioContext support
    }
    try {
      navigator.vibrate?.([60, 40, 60]);
    } catch {
      // ignore
    }
    return () => window.clearTimeout(t);
  }, [processing?.finishedAt, state.batches]);

  // Rough back-of-envelope estimate: ~45s per photo end-to-end (Pass A
  // detect → Pass B per-spine reads → lookups → tag inference). Renders
  // before processing starts and updates as photos complete.
  function formatEta(seconds: number): string {
    if (seconds < 60) return `${seconds} seconds`;
    const mins = Math.round(seconds / 60);
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  }

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
    // If the user didn't type a label at queue time, auto-default
    // based on today's date and existing same-type same-day labels.
    // The default is stable per-batch — once stamped here, subsequent
    // edits flow through updateBatch on Review/Export.
    const resolvedLabel =
      savedLabel ||
      getDefaultBatchLabel(
        'photo',
        stateRef.current.batches,
        loadLedger(),
        new Date()
      );
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
      batchLabel: resolvedLabel,
      batchNotes: savedNotes || undefined,
      croppedFrom,
      sourceDimensions: dims,
    };
    addBatch(batch);
    if (!lowRes) setPendingFile(id, file);
  }

  function handleFiles(
    files: File[],
    _opts?: { source: 'gallery' | 'camera' }
  ) {
    // Both gallery and camera files go through the crop step. The camera
    // path holds shots locally during a multi-capture session and only
    // flushes them here on Done — by which time the camera modal is
    // already unmounting, so the CropModal renders on a clean stack.
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
    // Snapshot the batch + its source File so the undo handler can
    // restore both locally.
    const snapshot = stateRef.current.batches.find((b) => b.id === id);
    const file = snapshot ? getPendingFileFromMap(id) : null;
    removeBatch(id);
    if (snapshot) {
      fireUndo(`Removed "${snapshot.filename}".`, () => {
        addBatch(snapshot);
        if (file) setPendingFile(snapshot.id, file);
      });
    }
  }
  // The store's pendingFiles map is private; we proxy via getPendingFile.
  function getPendingFileFromMap(id: string): File | null {
    return getPendingFile(id);
  }

  // Only batches with a stored File handle can be processed. After a hard
  // reload File handles are gone, so even a "queued"-looking batch may be
  // unprocessable; we filter those out for the button.
  const processableQueued = queuedBatches.filter((b) => hasPendingFile(b.id));

  // ETA copy. Pre-process: based on the queue length. During-process:
  // remaining photos × 45s. Hidden when nothing is queued.
  const etaText = (() => {
    if (isProcessing && processing) {
      const remaining = Math.max(0, processing.photoTotal - processing.photoDone);
      if (remaining === 0) return null;
      return `Estimated time remaining: ~${formatEta(remaining * 45)}`;
    }
    if (processableQueued.length > 0) {
      return `Estimated time: ~${formatEta(processableQueued.length * 45)} for ${processableQueued.length} ${processableQueued.length === 1 ? 'photo' : 'photos'}`;
    }
    return null;
  })();
  const canProcess = processableQueued.length > 0 && !isProcessing;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="typo-page-title">Upload</h1>
        {/* Phone-only "Refresh from cloud" — pulls batches just-processed
            on another device (e.g. tablet) so the Review tab here picks
            them up without a hard reload. The desktop / tablet auto-syncs
            on mount and uses the Review header's button for re-pulls. */}
        <button
          type="button"
          onClick={refreshFromCloud}
          disabled={refreshing}
          className="md:hidden text-[12px] font-medium px-3 py-1.5 rounded-md border border-line text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed"
          title="Pull batches just-processed on other devices."
        >
          {refreshing ? '⟳ Refreshing…' : '↻ Refresh from cloud'}
        </button>
      </div>
      {refreshMsg && (
        <div className="md:hidden text-[12px] text-text-tertiary">
          {refreshMsg}
        </div>
      )}

      <PhotoUploader
        onFiles={handleFiles}
        onScanRequest={() => setScannerOpen(true)}
        onManualEntryRequest={() => setManualOpen(true)}
        disabled={isProcessing}
      />

      {/* Below the dropzone splits into a two-column desktop layout:
          LEFT (col-span-7) — the active workflow (batch inputs, queue,
          progress, action row). RIGHT (col-span-5, lg:block only) —
          informational sidecar (recent batches + cataloging tips).
          Mobile + tablet collapse to a single column with the right
          sidecar hidden entirely; phone users have no screen real-
          estate budget for it. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-7 space-y-4">
      {scanError && (
        <div className="bg-mahogany/10 dark:bg-tartan/30 border border-mahogany/40 dark:border-tartan/50 text-mahogany dark:text-orange-100 rounded-md px-3 py-2 text-[12px]">
          Barcode lookup failed: {scanError}
        </div>
      )}

      {/* Batch inputs — under the dropzone so the photo CTA is the
          first thing on the page, with the metadata fields available
          but de-emphasized. v3 styling: white card, 1px line border,
          navy focus ring; helper text directly under the field. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="relative">
          <label htmlFor="batch-label" className="typo-label block mb-1">
            Batch label
          </label>
          <input
            id="batch-label"
            type="text"
            value={batchLabel}
            onChange={(e) => setBatchLabel(e.target.value)}
            onFocus={() => setLabelMenuOpen(true)}
            // Tiny delay on blur so a click on a menu item lands before
            // the menu unmounts. Mousedown on the menu cancels the close.
            onBlur={() => window.setTimeout(() => setLabelMenuOpen(false), 120)}
            placeholder='Shelf 3, Box 4, Upstairs hallway...'
            disabled={isProcessing}
            autoComplete="off"
            className="w-full bg-surface-card border border-line rounded-md px-[14px] py-[10px] text-[15px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy disabled:opacity-50 transition-colors"
          />
          {labelMenuOpen && pastLabels.length > 0 && (
            <div
              className="absolute z-20 left-0 right-0 mt-1 bg-surface-card border border-line rounded-md shadow-lg max-h-52 overflow-y-auto"
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="typo-label px-3 pt-2 pb-1">Recent labels</div>
              {pastLabels
                .filter((l) =>
                  batchLabel.trim()
                    ? l.toLowerCase().includes(batchLabel.toLowerCase().trim())
                    : true
                )
                .slice(0, 12)
                .map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => {
                      setBatchLabel(l);
                      setLabelMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-[13px] text-text-secondary hover:bg-navy-soft hover:text-navy transition"
                  >
                    {l}
                  </button>
                ))}
            </div>
          )}
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
            className="w-full bg-surface-card border border-line rounded-md px-[14px] py-[10px] text-[15px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy disabled:opacity-50 transition-colors"
          />
          <div className="text-[10px] text-text-quaternary mt-0.5">
            Free-form &rarr; LibraryThing COMMENTS
          </div>
        </div>
      </div>

      {summaryToast && (
        <div
          role="status"
          className="bg-carnegie-green-soft border border-carnegie-green/30 rounded-md px-4 py-2.5 text-[13px] text-text-primary flex items-center gap-3"
        >
          <span className="text-carnegie-green text-[16px]">✓</span>
          <span className="flex-1">{summaryToast}</span>
          <button
            type="button"
            onClick={() => setSummaryToast(null)}
            aria-label="Dismiss"
            className="text-text-tertiary hover:text-text-primary text-[16px] leading-none"
          >
            ×
          </button>
        </div>
      )}

      {/* Photo queue — surface every batch the user enrolled, including
          error rows ("Image too small …") so a low-res capture doesn't
          silently vanish. The component handles its own per-row remove
          button, status pill, and thumbnail. */}
      {state.batches.length > 0 && (
        <ProcessingQueue batches={state.batches} onRemove={handleRemove} />
      )}

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

      {/* Desktop / tablet action row — counter + Process all on the right.
          The phone variant lives below as a full-width button + sticky
          bottom CTA so the action is always thumb-reachable. */}
      <div className="hidden md:flex justify-between items-start pt-3 mt-2 border-t border-line">
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
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => processQueue()}
            disabled={!canProcess}
            className="px-[20px] py-[9px] rounded-md bg-navy text-white hover:bg-navy-deep disabled:opacity-40 disabled:cursor-not-allowed transition text-[14px] font-medium"
          >
            {isProcessing
              ? 'Processing…'
              : processableQueued.length === 0
                ? 'Process all'
                : `Process all (${processableQueued.length})`}
          </button>
          {etaText && (
            <div className="text-[11px] text-text-tertiary">{etaText}</div>
          )}
        </div>
      </div>

      {/* Phone caption row — counter + dark-mode link. The Process-all
          CTA itself is the sticky button further down so it stays
          thumb-reachable above the bottom tab bar through any queue
          length. */}
      <div className="md:hidden flex items-center justify-between pt-3 mt-2 border-t border-line">
        <div className="text-[12px] text-text-tertiary">
          {state.batches.length} photo{state.batches.length !== 1 ? 's' : ''} ·{' '}
          {state.allBooks.length} book{state.allBooks.length !== 1 ? 's' : ''}
        </div>
        <button
          type="button"
          onClick={() => {
            const next = !isDark;
            setDark(next);
            setIsDark(next);
          }}
          className="text-[11px] text-text-quaternary"
          aria-label="Toggle dark mode"
        >
          {isDark ? '☀ Light' : '☾ Dark'}
        </button>
      </div>
      </div>

      {/* Right informational sidecar — desktop / large-tablet only.
          Renders independent of session state; reads from the export
          ledger directly so it shows useful content even on a fresh
          load with no in-flight batches. */}
      <aside className="hidden lg:block lg:col-span-5 space-y-4">
        <RecentBatchesPanel />
        <CatalogingTipsPanel />
      </aside>
      </div>

      {/* Sticky phone CTA — only Process-all button on phone. Pinned
          above the 56px bottom tab bar (plus iOS home-indicator inset)
          so it's always tappable. Renders only when there's actionable
          work; an "all done" state shows the Review CTA inside the
          processing block above instead. */}
      {processableQueued.length > 0 && (
        <div
          className="md:hidden fixed inset-x-0 z-20 px-4 space-y-1"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 56px)',
          }}
        >
          {etaText && (
            <div className="text-[11px] text-text-tertiary text-center">
              {etaText}
            </div>
          )}
          <button
            onClick={() => processQueue()}
            disabled={!canProcess}
            className="w-full py-3.5 rounded-md bg-navy text-white text-[16px] font-semibold shadow-lg shadow-black/20 disabled:opacity-40 disabled:cursor-not-allowed transition active:scale-[0.99]"
          >
            {isProcessing
              ? 'Processing…'
              : `Process all (${processableQueued.length})`}
          </button>
        </div>
      )}

      {/* Phone spacer so the sticky Process-all button doesn't overlap the
          last in-page row when the user scrolls to the bottom. */}
      {processableQueued.length > 0 && (
        <div className="md:hidden h-16" aria-hidden />
      )}

      {/* Barcode scanner — confirm-on-every-scan flow. The user must
          explicitly tap "Use this ISBN" before a lookup is dispatched;
          duplicates within the same batch trigger a second confirm
          step. The modal mounts only when scannerOpen is true. */}
      {scannerOpen && (
        <BarcodeScanner
          onScan={handleScan}
          isIsbnInBatch={(isbn) => {
            const id = scanBatchIdRef.current;
            if (!id) return false;
            const batch = stateRef.current.batches.find((b) => b.id === id);
            if (!batch) return false;
            const cleaned = isbn.replace(/[^\dxX]/g, '').toUpperCase();
            return batch.books.some(
              (bk) =>
                (bk.isbn || '').replace(/[^\dxX]/g, '').toUpperCase() === cleaned
            );
          }}
          onClose={handleScannerClose}
        />
      )}

      {/* Manual entry modal. Mounts on demand, batch label/notes
          inherited at submit time from the page-level inputs. */}
      {manualOpen && (
        <ManualBookEntryModal
          onSubmit={handleManualSubmit}
          onClose={() => setManualOpen(false)}
        />
      )}

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

// ---------------------------------------------------------------------------
// Right-column panels for the desktop layout. Both read directly from the
// localStorage-cached ledger — no remote calls. The panels render even on
// a fresh load with no in-flight session because their entire purpose is to
// give the user something useful to look at while their workflow is empty.
// ---------------------------------------------------------------------------

function RecentBatchesPanel() {
  const [batches, setBatches] = useState<LedgerBatch[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  useEffect(() => {
    setBatches(getLedgerBatches().slice(0, 6));
    setLedger(loadLedger());
  }, []);

  if (batches.length === 0) return null;

  return (
    <section className="bg-surface-card border border-line rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="typo-section-label">Recent batches</div>
        <Link href="/history" className="text-[12px] text-navy hover:underline">
          View all →
        </Link>
      </div>
      <ul className="space-y-2.5">
        {batches.map((b) => {
          const inBatch = ledger.filter((e) => e.batchLabel === b.batchLabel);
          const covers = inBatch
            .filter((e) => !!e.isbn)
            .slice(0, 3)
            .map((e) => e.isbn);
          return (
            <li key={(b.batchLabel ?? '__unlabeled__') + b.latestDate}>
              <Link
                href="/history"
                className="block rounded-md hover:bg-surface-page transition px-2 py-2 -mx-2"
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex -space-x-2 flex-shrink-0">
                    {covers.length > 0 ? (
                      covers.map((isbn) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={isbn}
                          src={`https://covers.openlibrary.org/b/isbn/${isbn}-S.jpg?default=false`}
                          alt=""
                          className="w-7 h-10 rounded-sm object-cover bg-surface-page border border-surface-card shadow-sm"
                          loading="lazy"
                        />
                      ))
                    ) : (
                      <div className="w-7 h-10 rounded-sm bg-surface-page border border-line" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium text-text-primary truncate">
                      {b.batchLabel ?? <em className="text-text-tertiary not-italic">Unlabeled</em>}
                    </div>
                    <div className="text-[12px] text-text-tertiary">
                      {b.bookCount} {b.bookCount === 1 ? 'book' : 'books'} · {b.latestDate}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CatalogingTipsPanel() {
  // Static copy — these don't change per session and don't need state.
  // The treatment is deliberately quiet: muted text, no CTA, just useful
  // information that earns its place in the empty real estate.
  const tips = [
    'Spine photos: keep the camera parallel to the shelf, fill the frame with one shelf at a time.',
    'Good lighting matters more than camera quality.',
    'Glossy or plastic covers may produce glare — angle slightly to avoid reflection.',
    'Books packed tightly photograph better than half-empty shelves.',
  ];
  return (
    <section className="bg-surface-card border border-line rounded-lg p-4">
      <div className="typo-section-label mb-3">Cataloging tips</div>
      <ul className="space-y-2.5 text-[13px] text-text-secondary leading-relaxed">
        {tips.map((tip, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="text-text-quaternary mt-[1px]">·</span>
            <span>{tip}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}


