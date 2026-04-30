'use client';

import { useCallback, useRef, useState } from 'react';

interface PhotoUploaderProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export function PhotoUploader({ onFiles, disabled }: PhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
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
          : 'border-cream-300 dark:border-ink-soft hover:border-accent/70'
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

      <h2 className="font-serif text-xl mb-2">Drop bookshelf photos here</h2>
      <p className="text-sm text-ink/60 dark:text-cream-300/60 mb-4">
        Or click to browse. JPG, PNG, HEIC. Multiple files welcome.
      </p>
      <button
        type="button"
        className="inline-flex items-center text-sm px-4 py-2 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition disabled:opacity-50"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          inputRef.current?.click();
        }}
      >
        Choose photos
      </button>

      <div className="mt-6 text-[11px] text-ink/50 dark:text-cream-300/50 max-w-md mx-auto leading-relaxed">
        <strong className="text-ink/70 dark:text-cream-300/70">Tips for accurate reads:</strong>
        <ul className="list-disc list-inside mt-1 space-y-0.5 text-left">
          <li>Shoot in landscape, fill the frame with the shelf.</li>
          <li>Get within 2–3 feet so each spine has plenty of pixel detail.</li>
          <li>Even lighting — avoid glare on glossy spines.</li>
          <li>3000 px or wider is ideal. Tiny photos will be rejected.</li>
        </ul>
      </div>
    </div>
  );
}
