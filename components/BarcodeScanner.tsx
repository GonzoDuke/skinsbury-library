'use client';

/**
 * Barcode scanner — confirm-on-every-scan flow.
 *
 * State machine:
 *   scanning      camera live, detection loop running
 *   confirm       barcode detected; video paused, ISBN shown,
 *                 user taps "Use this ISBN" or "Rescan"
 *   dup-confirm   the ISBN the user is about to confirm is already
 *                 in the active batch; user must explicitly opt in
 *                 to "Add another copy" (default = No)
 *   between       previous scan committed; "Scan another?" Yes / Done
 *   error         camera permission denied or no detector available
 *
 * The scanner NEVER fires onScan(isbn) without an explicit user tap.
 * Cameras pick up barcodes instantly and repeatedly — auto-confirm
 * would create dozens of duplicate records on every shutter.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Snapshot of the preview-card data the scanner already fetched while
 * the user was deciding whether to commit the ISBN. Passed forward to
 * the parent on `onScan` so the rebuild path can seed the BookRecord's
 * cover from the preview hit instead of re-deriving it (the preview's
 * coverUrl was confirmed to load by the user's eyes; the rebuild path
 * may pick a different URL or come up empty). Null when the preview
 * hadn't resolved yet (user tapped through fast) or no match.
 */
export interface BarcodeScanPreview {
  title: string;
  author: string;
  coverUrl: string;
  source: 'isbndb' | 'openlibrary';
}

interface BarcodeScannerProps {
  /** Fired only when the user taps "Use this ISBN" (and confirms a
   *  duplicate-in-batch warning if the ISBN is already in the batch).
   *  `preview` is the resolved preview payload when one was rendered
   *  on the confirm card; null if the preview was still loading,
   *  timed out, or returned no match. */
  onScan: (isbn: string, preview: BarcodeScanPreview | null) => void;
  /** Synchronous predicate: does this ISBN already exist in the active
   *  batch? Used to gate the Use-this-ISBN tap behind a duplicate
   *  confirmation step. */
  isIsbnInBatch: (isbn: string) => boolean;
  /** User tapped Done. Parent unmounts the modal. */
  onClose: () => void;
}

interface DetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string; format: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (init?: { formats?: string[] }): DetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

type Stage =
  | { kind: 'scanning' }
  | { kind: 'confirm'; isbn: string }
  | { kind: 'dup-confirm'; isbn: string }
  | { kind: 'between' }
  | { kind: 'error'; message: string };

type PreviewState =
  | { kind: 'loading' }
  | {
      kind: 'loaded';
      title: string;
      author: string;
      coverUrl: string;
      source: 'isbndb' | 'openlibrary';
    }
  // Both APIs returned no match (or one of: invalid ISBN, network
  // error). Confirm card shows the ISBN with a "no match" note —
  // the user can still commit and have the book added with ISBN
  // only for manual lookup later.
  | { kind: 'no-match' }
  // 3s client-side budget exceeded. Confirm card falls back to
  // the original ISBN-only display so the flow doesn't stall.
  | { kind: 'timeout' };

export function BarcodeScanner({ onScan, isIsbnInBatch, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<DetectorLike | null>(null);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const detectingRef = useRef(false);

  const [stage, setStage] = useState<Stage>({ kind: 'scanning' });
  const [scanCount, setScanCount] = useState(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Cover image error state — flips when the <img> onError fires so the
  // card can swap to a neutral placeholder without leaving a broken
  // image icon behind.
  const [coverFailed, setCoverFailed] = useState(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    detectingRef.current = false;
  }, []);

  const close = useCallback(() => {
    setIsExiting(true);
    window.setTimeout(() => {
      stopStream();
      onClose();
    }, 200);
  }, [onClose, stopStream]);

  // Initialize the detector. Native first; ZXing dynamic-import
  // fallback when the platform doesn't expose BarcodeDetector.
  useEffect(() => {
    let cancelled = false;
    async function setupDetector() {
      try {
        if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
          detectorRef.current = new window.BarcodeDetector!({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'],
          });
          return;
        }
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const reader = new BrowserMultiFormatReader();
        detectorRef.current = {
          async detect(video: HTMLVideoElement) {
            try {
              const result = await reader.decodeOnceFromVideoElement(video);
              return [{ rawValue: result.getText(), format: 'ean_13' }];
            } catch {
              return [];
            }
          },
        };
      } catch {
        if (!cancelled) {
          setCameraError(
            'No barcode-detection support on this browser. Try Chrome on Android, Edge, or Safari 16+.'
          );
        }
      }
    }
    void setupDetector();
    return () => {
      cancelled = true;
    };
  }, []);

  // Open the rear camera at high resolution.
  useEffect(() => {
    let cancelled = false;
    async function openCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
        }
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        const msg =
          e?.name === 'NotAllowedError'
            ? 'Camera permission denied. Enable it in your browser settings to scan barcodes.'
            : e?.name === 'NotFoundError'
              ? 'No camera was found on this device.'
              : e?.message ?? 'Could not access the camera.';
        if (!cancelled) setCameraError(msg);
      }
    }
    void openCamera();
    return () => {
      cancelled = true;
    };
  }, []);

  // Detection loop. Active ONLY while stage.kind === 'scanning'. The
  // moment a valid ISBN is read, we stop the loop and pause the video
  // so the user sees a frozen frame with the detected ISBN overlaid.
  useEffect(() => {
    mountedRef.current = true;
    if (stage.kind !== 'scanning') return;

    let cancelled = false;
    function tick() {
      if (cancelled || !mountedRef.current) return;
      const detector = detectorRef.current;
      const video = videoRef.current;
      if (!detector || !video || video.readyState < 2 || video.paused) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (detectingRef.current) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      detectingRef.current = true;
      detector
        .detect(video)
        .then((results) => {
          detectingRef.current = false;
          if (cancelled || !mountedRef.current) return;
          const isbnHit = results.find(
            (r) =>
              r.format === 'ean_13' &&
              /^(?:978|979)\d{10}$/.test(r.rawValue.replace(/[^\d]/g, ''))
          );
          if (isbnHit) {
            const isbn = isbnHit.rawValue.replace(/[^\d]/g, '');
            // Stop scanning + freeze frame.
            const v = videoRef.current;
            if (v) v.pause();
            // Tactile lock-on confirmation. Short single pulse so the
            // user knows the scan registered without lifting their eye
            // from the camera. Best-effort — silent on platforms with
            // no Vibration API.
            try {
              navigator.vibrate?.(100);
            } catch {
              // ignore
            }
            setStage({ kind: 'confirm', isbn });
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
        })
        .catch(() => {
          detectingRef.current = false;
          if (!cancelled && mountedRef.current) {
            rafRef.current = requestAnimationFrame(tick);
          }
        });
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [stage.kind]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopStream();
    };
  }, [stopStream]);

  // Preview lookup. Fires only when the scanner enters the `confirm`
  // stage (a fresh ISBN was just detected and the camera frame is
  // frozen). Calls /api/preview-isbn — server-side ISBNdb-first +
  // Open Library fallback — with a HARD 3-second client timeout so a
  // slow upstream can't stall the user. On timeout we transition the
  // preview to {kind: 'timeout'} which renders the original
  // ISBN-only card and lets the user proceed.
  useEffect(() => {
    if (stage.kind !== 'confirm') {
      setPreview(null);
      setCoverFailed(false);
      return;
    }
    const isbn = stage.isbn;
    setPreview({ kind: 'loading' });
    setCoverFailed(false);
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      ctrl.abort();
      setPreview({ kind: 'timeout' });
    }, 3000);
    fetch(`/api/preview-isbn?isbn=${encodeURIComponent(isbn)}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { title?: string; author?: string; coverUrl?: string; source?: string } | null) => {
        if (cancelled) return;
        cancelled = true;
        window.clearTimeout(timer);
        if (
          !data ||
          data.source === 'none' ||
          !data.title ||
          (data.source !== 'isbndb' && data.source !== 'openlibrary')
        ) {
          setPreview({ kind: 'no-match' });
          return;
        }
        setPreview({
          kind: 'loaded',
          title: data.title,
          author: data.author ?? '',
          coverUrl: data.coverUrl ?? '',
          source: data.source,
        });
      })
      .catch(() => {
        if (cancelled) return;
        cancelled = true;
        window.clearTimeout(timer);
        // AbortError from our own timeout is already handled above;
        // any other error just falls through to no-match.
        setPreview((prev) => (prev?.kind === 'timeout' ? prev : { kind: 'no-match' }));
      });
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [stage]);

  // Allow Escape to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Restart the live preview after a Rescan or Yes-scan-another tap.
  function resumeScanning() {
    const v = videoRef.current;
    if (v) {
      v.play().catch(() => {});
    }
    setStage({ kind: 'scanning' });
  }

  function onUseIsbn(isbn: string) {
    if (isIsbnInBatch(isbn)) {
      setStage({ kind: 'dup-confirm', isbn });
      return;
    }
    commit(isbn);
  }

  function commit(isbn: string) {
    // Snapshot the preview state at commit time so the parent can seed
    // the BookRecord's cover from the URL the user actually saw load.
    const snap: BarcodeScanPreview | null =
      preview?.kind === 'loaded'
        ? {
            title: preview.title,
            author: preview.author,
            coverUrl: preview.coverUrl,
            source: preview.source,
          }
        : null;
    onScan(isbn, snap);
    setScanCount((n) => n + 1);
    setStage({ kind: 'between' });
  }

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Scan a book barcode"
    >
      <div
        className={`absolute inset-0 bg-black/55 backdrop-blur-sm ${
          isExiting ? 'animate-backdrop-out' : 'animate-backdrop-in'
        }`}
      />

      <div
        className={`relative w-[min(94vw,900px)] h-[min(78vh,720px)] rounded-2xl overflow-hidden shadow-2xl bg-black flex flex-col ${
          isExiting ? 'animate-modal-out' : 'animate-modal-in'
        }`}
      >
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* Targeting rectangle — only while actively scanning. Hidden
            once we've frozen the frame so it doesn't fight the
            confirm-overlay copy. */}
        {!cameraError && stage.kind === 'scanning' && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div
              className="relative"
              style={{ width: '70%', height: 130 }}
            >
              <div className="absolute inset-0 border-2 border-brass/80 rounded-md" />
              <div
                className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px"
                style={{ background: 'rgba(196,163,90,0.7)' }}
              />
            </div>
          </div>
        )}

        {/* Top bar: counter on the left, Done pill on the right. */}
        <div className="absolute top-0 inset-x-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/55 to-transparent pointer-events-none">
          <span className="text-[12px] uppercase tracking-wider text-cream-200 font-medium">
            {scanCount === 0
              ? stage.kind === 'scanning'
                ? 'Aim at the barcode'
                : 'Scan barcode'
              : `${scanCount} scanned this session`}
          </span>
        </div>
        {stage.kind !== 'confirm' && stage.kind !== 'dup-confirm' && (
          <button
            type="button"
            onClick={close}
            className="absolute top-3 right-3 z-10 px-5 py-2 rounded-full bg-white text-ink text-base font-semibold shadow-lg ring-1 ring-black/10 active:scale-95 transition"
          >
            Done
          </button>
        )}

        {/* Confirm overlay — shown when a barcode has been detected.
            Frozen camera frame underneath; centered card on top with
            the preview (cover + title + author + ISBN) when the
            quick lookup succeeded, or the original ISBN-only fallback
            on timeout / no-match / loading. The Use-this-ISBN and
            Rescan buttons stay below in every variant. */}
        {stage.kind === 'confirm' && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/55">
            <div className="w-full max-w-sm bg-cream-50 dark:bg-ink text-ink dark:text-cream-50 rounded-xl p-5 shadow-2xl space-y-3">
              {preview?.kind === 'loaded' ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    {preview.coverUrl && !coverFailed ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={preview.coverUrl}
                        alt=""
                        loading="lazy"
                        onError={() => setCoverFailed(true)}
                        className="w-[60px] h-[90px] object-cover rounded ring-1 ring-line bg-cream-100 dark:bg-ink-soft flex-shrink-0"
                      />
                    ) : (
                      <div
                        className="w-[60px] h-[90px] rounded ring-1 ring-line bg-cream-100 dark:bg-ink-soft flex-shrink-0 flex items-center justify-center text-text-quaternary text-[10px]"
                        aria-hidden
                      >
                        📖
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-semibold leading-snug break-words">
                        {preview.title}
                      </div>
                      {preview.author && (
                        <div className="text-[13px] text-text-secondary mt-1 break-words">
                          {preview.author}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-[12px] font-mono text-text-tertiary tracking-tight">
                    {stage.isbn}
                  </div>
                </div>
              ) : preview?.kind === 'no-match' ? (
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-wider text-text-tertiary">
                    Detected ISBN
                  </div>
                  <div className="text-[22px] font-mono font-semibold tracking-tight">
                    {stage.isbn}
                  </div>
                  <div className="text-[12px] text-text-tertiary leading-relaxed">
                    No match found — book will be added with ISBN only for manual lookup.
                  </div>
                </div>
              ) : preview?.kind === 'loading' ? (
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-wider text-text-tertiary">
                    ⟳ Looking up…
                  </div>
                  <div className="text-[22px] font-mono font-semibold tracking-tight">
                    {stage.isbn}
                  </div>
                </div>
              ) : (
                // timeout — or null/initial — fall back to the original
                // ISBN-only display so the flow doesn't stall on a slow
                // upstream.
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-wider text-text-tertiary">
                    Detected ISBN
                  </div>
                  <div className="text-[22px] font-mono font-semibold tracking-tight">
                    {stage.isbn}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onUseIsbn(stage.isbn)}
                  className="flex-1 py-2.5 rounded-md bg-navy text-white text-[14px] font-semibold active:scale-[0.99] transition"
                >
                  Use this ISBN
                </button>
                <button
                  type="button"
                  onClick={resumeScanning}
                  className="flex-1 py-2.5 rounded-md border border-line text-text-secondary text-[14px] font-medium transition"
                >
                  Rescan
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Duplicate-in-batch confirm. Same frozen frame; different
            copy. Default action is "No, don't add" — the user has to
            explicitly opt in to a duplicate copy. */}
        {stage.kind === 'dup-confirm' && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/55">
            <div className="w-full max-w-sm bg-cream-50 dark:bg-ink text-ink dark:text-cream-50 rounded-xl p-5 shadow-2xl space-y-3">
              <div className="text-[14px] font-semibold">
                ISBN already in this batch
              </div>
              <div className="text-[13px] text-text-secondary leading-relaxed">
                <span className="font-mono">{stage.isbn}</span> is already
                attached to a book you&rsquo;ve scanned in this session. Add
                another copy?
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={resumeScanning}
                  className="flex-1 py-2.5 rounded-md bg-navy text-white text-[14px] font-semibold active:scale-[0.99] transition"
                  autoFocus
                >
                  No, keep scanning
                </button>
                <button
                  type="button"
                  onClick={() => commit(stage.isbn)}
                  className="flex-1 py-2.5 rounded-md border border-line text-text-secondary text-[14px] font-medium transition"
                >
                  Yes, add copy
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Between-scans prompt — fired after a successful Use this
            ISBN. Camera stays paused; the user explicitly says Yes
            to scan another or Done to close the modal. */}
        {stage.kind === 'between' && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/55">
            <div className="w-full max-w-sm bg-cream-50 dark:bg-ink text-ink dark:text-cream-50 rounded-xl p-5 shadow-2xl space-y-3">
              <div className="text-[14px] font-semibold">Scan another?</div>
              <div className="text-[13px] text-text-secondary">
                The lookup for that ISBN is running in the background. Books
                appear on the Review tab as soon as their metadata resolves.
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={resumeScanning}
                  className="flex-1 py-2.5 rounded-md bg-navy text-white text-[14px] font-semibold active:scale-[0.99] transition"
                  autoFocus
                >
                  Yes, scan another
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="flex-1 py-2.5 rounded-md border border-line text-text-secondary text-[14px] font-medium transition"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {cameraError && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/60">
            <div className="max-w-sm text-center bg-cream-50 dark:bg-ink text-ink dark:text-cream-50 rounded-lg p-5 shadow-xl">
              <p className="text-sm mb-4">{cameraError}</p>
              <button
                type="button"
                onClick={close}
                className="text-sm text-brass hover:underline underline-offset-4"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
