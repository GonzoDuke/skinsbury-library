'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface PhotoUploaderProps {
  /**
   * Receives accepted images. `source: 'gallery'` files came from the
   * file picker / drag-drop and should go through the crop step. `source:
   * 'camera'` files were already framed in the in-app camera viewfinder
   * and should skip cropping (the camera modal sits on top of any
   * CropModal, so cropping mid-capture would be invisible anyway).
   */
  onFiles: (files: File[], opts: { source: 'gallery' | 'camera' }) => void;
  /** Tap "Scan barcode" — the parent owns the scanner modal mount. */
  onScanRequest?: () => void;
  /** Tap "Manual entry" — the parent owns the manual-entry modal. */
  onManualEntryRequest?: () => void;
  disabled?: boolean;
}

interface SessionThumb {
  id: number;
  url: string;
  name: string;
}

export function PhotoUploader({ onFiles, onScanRequest, onManualEntryRequest, disabled }: PhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [isDragging, setDragging] = useState(false);

  // Camera lifecycle: mounted = the modal is in the DOM; isExiting flips
  // true during the close animation so we keep the element rendered for
  // the duration of the exit keyframes before unmounting.
  const [isMounted, setIsMounted] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [shutterPulseKey, setShutterPulseKey] = useState(0);
  const captureCount = useRef(0);
  const [captureUiCount, setCaptureUiCount] = useState(0);
  const [thumbs, setThumbs] = useState<SessionThumb[]>([]);
  const [showLandscapeToast, setShowLandscapeToast] = useState(false);
  // Files captured during the active camera session. Held locally so the
  // CropModal stack doesn't fight the open camera modal — we flush them
  // to the parent on Done, by which time the camera UI is unmounting.
  const cameraPending = useRef<File[]>([]);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const accepted = Array.from(files).filter((f) =>
        /^image\/(jpeg|jpg|png|heic|heif|webp)$/i.test(f.type) ||
        /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)
      );
      if (accepted.length === 0) return;
      onFiles(accepted, { source: 'gallery' });
    },
    [onFiles]
  );

  // Stop the active camera stream and release the hardware. Safe to call
  // multiple times — already-stopped tracks are no-ops.
  const stopStream = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Free the in-memory thumbnail URLs created by URL.createObjectURL so
  // the browser can reclaim the bytes once the camera modal is closed.
  const revokeThumbs = useCallback((list: SessionThumb[]) => {
    list.forEach((t) => {
      try {
        URL.revokeObjectURL(t.url);
      } catch {
        // ignore — the URL was already revoked or never valid
      }
    });
  }, []);

  const startCapture = useCallback(async () => {
    if (disabled) return;
    captureCount.current = 0;
    setCaptureUiCount(0);
    setThumbs([]);
    setCameraError(null);
    setIsExiting(false);
    setIsMounted(true);
    cameraPending.current = [];
    setShowLandscapeToast(true);
    window.setTimeout(() => setShowLandscapeToast(false), 2000);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // Ask for the device's max — phones with 4K rear sensors only
          // deliver them when explicitly hinted. The device caps to its
          // own max if it can't satisfy the request.
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => {});
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.name === 'NotAllowedError'
            ? 'Camera permission denied. Enable it in your browser settings to take photos.'
            : err.name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : err.message
          : 'Could not access the camera.';
      setCameraError(msg);
    }
  }, [disabled]);

  // Two-phase close so the exit animation can play. We flip isExiting,
  // wait for the keyframe to finish, then unmount and free resources.
  // After the camera UI is gone, hand the captured files off to the
  // parent so they go through the crop step (instead of stacking the
  // CropModal under an open camera modal mid-capture).
  const closeCamera = useCallback(() => {
    setIsExiting(true);
    window.setTimeout(() => {
      stopStream();
      setIsMounted(false);
      setIsExiting(false);
      setCameraError(null);
      setThumbs((prev) => {
        revokeThumbs(prev);
        return [];
      });
      const pending = cameraPending.current;
      cameraPending.current = [];
      if (pending.length > 0) {
        onFiles(pending, { source: 'camera' });
      }
    }, 200);
  }, [onFiles, revokeThumbs, stopStream]);

  const takePhoto = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

    // Bump the key to retrigger the shutter-click keyframe even if it's
    // already running from a rapid double-tap.
    setShutterPulseKey((k) => k + 1);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        captureCount.current += 1;
        const n = captureCount.current;
        const file = new File(
          [blob],
          `shelf-capture-${String(n).padStart(3, '0')}.jpg`,
          { type: 'image/jpeg', lastModified: Date.now() }
        );
        // Hold locally; closeCamera flushes to the parent (which routes
        // each file through enqueueForCrop → CropModal). This keeps the
        // multi-shot flow uninterrupted by mid-capture crop dialogs.
        cameraPending.current.push(file);
        setCaptureUiCount(n);
        const url = URL.createObjectURL(blob);
        setThumbs((prev) => [...prev, { id: n, url, name: file.name }]);
        // Scroll the strip so the freshest thumb stays in view.
        window.setTimeout(() => {
          const el = stripRef.current;
          if (!el) return;
          // On wide layouts the strip is vertical, on narrow it's horizontal.
          el.scrollTo({
            top: el.scrollHeight,
            left: el.scrollWidth,
            behavior: 'smooth',
          });
        }, 30);
      },
      'image/jpeg',
      0.92
    );
  }, []);

  // Release the camera if the page hides (tab switch, screen lock) or the
  // component unmounts. Without this the camera indicator can stay lit.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && isMounted && !isExiting) {
        closeCamera();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopStream();
    };
  }, [closeCamera, isExiting, isMounted, stopStream]);

  // Allow Escape to close the camera, matching standard modal expectations.
  useEffect(() => {
    if (!isMounted || isExiting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCamera();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeCamera, isExiting, isMounted]);

  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          handleFiles(e.dataTransfer.files);
        }}
        className={`relative rounded-[10px] border-[1.5px] border-dashed transition-all duration-200 ease-gentle px-6 py-7 text-center cursor-pointer ${
          isDragging
            ? 'border-navy bg-navy-soft scale-[1.005]'
            : 'border-line hover:border-navy hover:bg-navy-soft/50'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''} bg-surface-card`}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/heic,image/heif,image/webp,.jpg,.jpeg,.png,.heic,.heif,.webp"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

        <div className="text-[16px] font-medium text-text-secondary mb-1">
          Drop bookshelf photos here
        </div>
        <div className="text-[12px] text-text-quaternary mb-3.5">
          JPG, PNG, HEIC up to 30 MB
        </div>
        {/* 2x2 entry grid. All four buttons get the same outlined
            treatment — no primary/secondary distinction. Order:
              [Take Photo]   [Scan barcode]
              [Choose photos] [Manual entry] */}
        <div className="grid grid-cols-2 gap-2.5 max-w-[400px] mx-auto">
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 text-[14px] font-medium px-4 py-[10px] rounded-md bg-surface-card text-text-secondary border border-line hover:bg-surface-page hover:border-navy transition disabled:opacity-50"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              startCapture();
            }}
            title="Open the rear camera and capture multiple shelves in sequence"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            Take Photo
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 text-[14px] font-medium px-4 py-[10px] rounded-md bg-surface-card text-text-secondary border border-line hover:bg-surface-page hover:border-navy transition disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={disabled || !onScanRequest}
            onClick={(e) => {
              e.stopPropagation();
              onScanRequest?.();
            }}
            title="Scan a book's back-cover barcode to add it without photographing the spine"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 6v12" />
              <path d="M6 6v12" />
              <path d="M10 6v12" />
              <path d="M13 6v12" />
              <path d="M17 6v12" />
              <path d="M20 6v12" />
            </svg>
            Scan barcode
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 text-[14px] font-medium px-4 py-[10px] rounded-md bg-surface-card text-text-secondary border border-line hover:bg-surface-page hover:border-navy transition disabled:opacity-50"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
            title="Pick image files from your device"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            Choose photos
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 text-[14px] font-medium px-4 py-[10px] rounded-md bg-surface-card text-text-secondary border border-line hover:bg-surface-page hover:border-navy transition disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={disabled || !onManualEntryRequest}
            onClick={(e) => {
              e.stopPropagation();
              onManualEntryRequest?.();
            }}
            title="Type a book's ISBN, title, and/or author to add it without a photo"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
            Manual entry
          </button>
        </div>
      </div>

      {showLandscapeToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] px-5 py-3 rounded-lg bg-ink dark:bg-cream-50 text-cream-50 dark:text-ink shadow-xl text-sm font-medium animate-toast pointer-events-none">
          Hold your tablet in landscape for best results
        </div>
      )}

      {/* Camera modal. The upload page stays visible behind a dimmed
          backdrop; the modal occupies ~70% of the viewport with rounded
          corners and the same limestone/ink card surface used elsewhere. */}
      {isMounted && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Take photos with the rear camera"
        >
          <div
            className={`absolute inset-0 bg-black/55 backdrop-blur-sm ${
              isExiting ? 'animate-backdrop-out' : 'animate-backdrop-in'
            }`}
          />

          <div
            className={`relative w-[min(94vw,1100px)] h-[min(78vh,820px)] rounded-2xl overflow-hidden shadow-2xl bg-cream-50 border border-cream-300 dark:border-brass/20 flex flex-col md:flex-row ${
              isExiting ? 'animate-modal-out' : 'animate-modal-in'
            }`}
          >
            {/* Live preview pane */}
            <div className="relative flex-1 min-h-0 bg-black flex flex-col">
              <video
                ref={videoRef}
                playsInline
                autoPlay
                muted
                className="absolute inset-0 w-full h-full object-contain bg-black"
              />

              {/* Subtle shutter flash — keyed so rapid taps re-fire the keyframe */}
              <div
                key={shutterPulseKey}
                className={`absolute inset-0 bg-white pointer-events-none ${
                  shutterPulseKey > 0 ? 'animate-shutter-click' : 'opacity-0'
                }`}
              />

              {/* Top bar inside preview: counter on the left. Done is its
                  own absolutely-positioned button at top-right so it sits
                  above the gradient and stays visible at high contrast
                  even when the user is mid-capture. */}
              <div className="absolute top-0 inset-x-0 px-4 py-3 bg-gradient-to-b from-black/55 to-transparent pointer-events-none">
                <span className="text-[12px] uppercase tracking-wider text-cream-200 font-medium">
                  {captureUiCount === 0
                    ? 'Aim at a shelf'
                    : `${captureUiCount} photo${captureUiCount === 1 ? '' : 's'} taken`}
                </span>
              </div>
              <button
                type="button"
                onClick={closeCamera}
                className="absolute top-3 right-3 z-10 px-5 py-2 rounded-full bg-white text-ink text-base font-semibold shadow-lg ring-1 ring-black/10 hover:bg-cream-100 active:scale-95 transition"
              >
                Done
              </button>

              {/* Camera-error overlay */}
              {cameraError && (
                <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/60">
                  <div className="max-w-sm text-center bg-cream-50 dark:bg-ink text-ink dark:text-cream-50 rounded-lg p-5 shadow-xl">
                    <p className="text-sm mb-4">{cameraError}</p>
                    <button
                      type="button"
                      onClick={closeCamera}
                      className="text-sm text-brass hover:underline underline-offset-4"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}

              {/* Right-side shutter: brass-outlined, vertically centered.
                  Landscape grip places the user's right thumb naturally
                  here. A faint gradient anchors it to the right edge so
                  it reads against bright shelf scenes. */}
              {!cameraError && (
                <>
                  <div className="absolute inset-y-0 right-0 w-24 pointer-events-none bg-gradient-to-l from-black/45 to-transparent" />
                  <button
                    type="button"
                    onClick={takePhoto}
                    aria-label="Take photo"
                    className="group absolute right-5 top-1/2 -translate-y-1/2 w-16 h-16 rounded-full border-2 border-brass/80 hover:border-brass active:scale-95 transition-transform flex items-center justify-center bg-black/20"
                  >
                    <span className="w-11 h-11 rounded-full bg-brass/90 group-hover:bg-brass transition-colors" />
                  </button>
                </>
              )}
            </div>

            {/* Thumbnail strip — vertical on wide layouts, horizontal below */}
            <div className="md:w-44 md:border-l md:border-t-0 border-t border-cream-300 dark:border-brass/20 bg-cream-100 dark:bg-ink/60 flex flex-col">
              <div className="hidden md:flex items-center justify-between px-3 py-2 border-b border-cream-300 dark:border-brass/20">
                <span className="text-[10px] uppercase tracking-wider text-ink/60 dark:text-cream-300/70 font-medium">
                  Captured
                </span>
                <span className="text-[10px] text-ink/50 dark:text-cream-300/50">
                  {captureUiCount}
                </span>
              </div>

              <div
                ref={stripRef}
                className="flex-1 min-h-0 px-2 py-2 overflow-auto flex md:flex-col gap-2"
              >
                {thumbs.length === 0 ? (
                  <div className="m-auto text-[11px] text-ink/45 dark:text-cream-300/45 text-center px-2 leading-snug">
                    Photos you take will appear here.
                  </div>
                ) : (
                  thumbs.map((t) => (
                    <div
                      key={t.id}
                      className="relative shrink-0 animate-thumb-in rounded-md overflow-hidden border border-cream-300 dark:border-brass/30 shadow-sm w-20 h-20 md:w-full md:h-auto md:aspect-square bg-black"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={t.url}
                        alt={t.name}
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute bottom-0 right-0 text-[9px] font-mono px-1 py-0.5 bg-black/55 text-cream-100 rounded-tl-sm">
                        {String(t.id).padStart(3, '0')}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
