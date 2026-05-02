'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface PhotoUploaderProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

interface SessionThumb {
  id: number;
  url: string;
  name: string;
}

export function PhotoUploader({ onFiles, disabled }: PhotoUploaderProps) {
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

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const accepted = Array.from(files).filter((f) =>
        /^image\/(jpeg|jpg|png|heic|heif|webp)$/i.test(f.type) ||
        /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)
      );
      if (accepted.length === 0) return;
      onFiles(accepted);
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
    setShowLandscapeToast(true);
    window.setTimeout(() => setShowLandscapeToast(false), 2000);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
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
    }, 200);
  }, [revokeThumbs, stopStream]);

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
        onFiles([file]);
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
  }, [onFiles]);

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
        className={`relative rounded-[10px] border-[1.5px] border-dashed transition-all duration-200 ease-gentle px-8 py-14 text-center cursor-pointer ${
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

        <div className="text-[17px] font-medium text-text-secondary mb-1.5 inline-flex items-center gap-2">
          Drop bookshelf photos here
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label="Photography tips"
            title="Landscape orientation · fill the frame with one shelf · stand 2–3 feet away · turn flash off · avoid overhead lighting on plastic covers"
            className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full text-[11px] font-semibold text-text-quaternary hover:text-navy border border-line hover:border-navy transition"
          >
            i
          </button>
        </div>
        <div className="text-[13px] text-text-quaternary mb-5">
          JPG, PNG, HEIC up to 30 MB
        </div>
        <div className="inline-flex flex-wrap justify-center gap-2.5">
          <button
            type="button"
            className="inline-flex items-center text-[14px] font-medium px-5 py-[9px] rounded-md bg-navy text-white hover:bg-navy-deep transition disabled:opacity-50"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            Choose photos
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 text-[14px] font-medium px-5 py-[9px] rounded-md bg-surface-card text-text-secondary border border-line hover:bg-surface-page transition disabled:opacity-50"
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
            Camera
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
