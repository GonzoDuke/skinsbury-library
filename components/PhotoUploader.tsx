'use client';

import { useCallback, useRef, useState } from 'react';

interface PhotoUploaderProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export function PhotoUploader({ onFiles, disabled }: PhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Separate input for the rear-camera capture path. Using a distinct
  // element avoids toggling the `capture` attribute at runtime (which
  // some mobile browsers handle inconsistently) and keeps the gallery
  // picker available alongside the camera shortcut.
  const cameraRef = useRef<HTMLInputElement>(null);
  const [isDragging, setDragging] = useState(false);

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

  return (
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
      className={`bookshelf-bg relative rounded-2xl border-2 border-dashed transition-all duration-200 ease-gentle p-12 text-center cursor-pointer ${
        isDragging
          ? 'border-accent bg-accent-soft/60 dark:bg-accent/20 scale-[1.01]'
          : 'border-cream-300 dark:border-ink-soft hover:border-accent'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
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
      {/* Mobile rear-camera capture. capture="environment" opens the back
          camera directly on iOS / Android. On desktop the attribute is
          ignored and the input behaves like the regular file picker. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      <div className="mx-auto w-14 h-14 rounded-full bg-accent/10 dark:bg-accent/30 flex items-center justify-center mb-4">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-accent"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </div>

      <h2 className="font-serif text-xl mb-1">Drop bookshelf photos here</h2>
      <p className="text-[11px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 mb-5">
        Landscape · fill the frame · 2–3 feet away · flash off
      </p>
      <div className="inline-flex flex-wrap justify-center gap-2">
        <button
          type="button"
          className="inline-flex items-center text-sm px-5 py-2 rounded-md bg-accent text-limestone hover:bg-accent-deep transition disabled:opacity-50"
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
          className="inline-flex items-center gap-1.5 text-sm px-5 py-2 rounded-md border border-accent text-accent dark:text-brass dark:border-brass hover:bg-accent hover:text-limestone dark:hover:bg-brass dark:hover:text-accent-deep transition disabled:opacity-50"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            cameraRef.current?.click();
          }}
          title="Open the rear camera (mobile) or your default capture device (desktop)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          Take photo
        </button>
      </div>
    </div>
  );
}
