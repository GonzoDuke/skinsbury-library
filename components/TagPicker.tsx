'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ALL_FORM_TAGS, ALL_GENRE_TAGS, VOCAB } from '@/lib/tag-domains';
import { loadLedger } from '@/lib/export-ledger';

interface TagPickerProps {
  variant: 'genre' | 'form';
  existing: string[];
  onAdd: (tag: string) => void;
  onClose: () => void;
}

export function TagPicker({ variant, existing, onAdd, onClose }: TagPickerProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const existingSet = useMemo(
    () => new Set(existing.map((t) => t.replace(/^\[Proposed\]\s*/i, '').toLowerCase())),
    [existing]
  );

  const trimmed = query.trim();
  const lowerQ = trimmed.toLowerCase();

  const filteredGenre = useMemo(() => {
    return ALL_GENRE_TAGS.filter(
      (g) =>
        !existingSet.has(g.tag.toLowerCase()) &&
        (!lowerQ || g.tag.toLowerCase().includes(lowerQ))
    );
  }, [lowerQ, existingSet]);

  const filteredForm = useMemo(() => {
    return ALL_FORM_TAGS.filter(
      (t) => !existingSet.has(t.toLowerCase()) && (!lowerQ || t.toLowerCase().includes(lowerQ))
    );
  }, [lowerQ, existingSet]);

  // Frequently-used: top 10 tags by ledger usage. Computed once on
  // mount; if the ledger is empty the section hides. Filtered against
  // the active variant + the existing-on-this-book set + the search
  // query so the section only ever shows tags the user can actually
  // add right now.
  const frequentTagSet = useMemo(() => {
    const known =
      variant === 'genre'
        ? new Set(ALL_GENRE_TAGS.map((g) => g.tag.toLowerCase()))
        : new Set(ALL_FORM_TAGS.map((t) => t.toLowerCase()));
    const counts = new Map<string, number>();
    for (const e of loadLedger()) {
      for (const t of e.tags ?? []) {
        const clean = t.replace(/^\[Proposed\]\s*/i, '').trim();
        if (!clean) continue;
        if (!known.has(clean.toLowerCase())) continue;
        counts.set(clean, (counts.get(clean) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);
  }, [variant]);

  const frequentlyUsed = useMemo(
    () =>
      frequentTagSet.filter(
        (t) =>
          !existingSet.has(t.toLowerCase()) &&
          (!lowerQ || t.toLowerCase().includes(lowerQ))
      ),
    [frequentTagSet, existingSet, lowerQ]
  );

  const exactExists =
    filteredGenre.some((g) => g.tag.toLowerCase() === lowerQ) ||
    filteredForm.some((t) => t.toLowerCase() === lowerQ);

  return (
    <div
      ref={wrapRef}
      className="absolute z-20 mt-1 w-72 max-h-80 overflow-y-auto bg-cream-50 dark:bg-ink-soft border border-cream-300 dark:border-ink-soft rounded-lg shadow-lg p-2"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={variant === 'genre' ? 'Search genre tags…' : 'Search form tags…'}
        className="w-full px-2 py-1.5 text-sm bg-cream-100 dark:bg-ink rounded border border-cream-300 dark:border-ink-soft focus:outline-none focus:ring-1 focus:ring-accent"
      />

      <div className="mt-2 space-y-3">
        {/* Frequently-used: top 10 tags by ledger usage, surfaced first
            so common adds are one tap. Hides when the ledger is empty
            or every popular tag is already on the book / filtered out. */}
        {frequentlyUsed.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/50 dark:text-cream-300/50 mb-1 px-1">
              Frequently used
            </div>
            <div className="flex flex-wrap gap-1">
              {frequentlyUsed.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    onAdd(t);
                    onClose();
                  }}
                  className="text-xs px-2 py-1 rounded-full bg-cream-100 dark:bg-ink hover:bg-accent-soft dark:hover:bg-accent/30 transition"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {variant === 'genre' &&
          (Object.keys(VOCAB.domains) as Array<keyof typeof VOCAB.domains>)
            .map((dKey) => {
              const domain = VOCAB.domains[dKey];
              const matches = filteredGenre.filter((g) => g.domain === dKey);
              const totalDomainTags = domain.tags.length;
              const isEmpty = totalDomainTags === 0;
              // When a search query is active, suppress empty / non-matching
              // domains so the picker stays tight. Empty-domain visibility
              // matters in the unfiltered "browse" state — all 21 domains
              // present, the empty ones de-emphasized — but a search for
              // "buddh" shouldn't dump 14 empty rows below the hit.
              if (matches.length === 0 && trimmed) return null;
              if (matches.length === 0 && !isEmpty) return null;
              return (
                <div key={String(dKey)} className={isEmpty ? 'opacity-50' : ''}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/50 dark:text-cream-300/50 mb-1 px-1 flex items-center gap-1.5">
                    <span>{domain.label}</span>
                    {isEmpty && (
                      <span className="text-[9px] font-mono text-ink/40 dark:text-cream-300/40 lowercase tracking-tight normal-case">
                        — 0 tags
                      </span>
                    )}
                  </div>
                  {isEmpty ? (
                    <div className="text-[11px] italic text-ink/40 dark:text-cream-300/40 px-1">
                      No tags yet — propose one with the new-tag input below.
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {matches.map((g) => (
                        <button
                          key={g.tag}
                          onClick={() => {
                            onAdd(g.tag);
                            onClose();
                          }}
                          className="text-xs px-2 py-1 rounded-full bg-cream-100 dark:bg-ink hover:bg-accent-soft dark:hover:bg-accent/30 transition"
                        >
                          {g.tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

        {variant === 'form' && filteredForm.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/50 dark:text-cream-300/50 mb-1 px-1">
              Form tags
            </div>
            <div className="flex flex-wrap gap-1">
              {filteredForm.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    onAdd(t);
                    onClose();
                  }}
                  className="text-xs px-2 py-1 rounded-full bg-cream-100 dark:bg-ink hover:bg-accent-soft dark:hover:bg-accent/30 transition"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {trimmed && !exactExists && (
          <button
            onClick={() => {
              onAdd(`[Proposed] ${trimmed}`);
              onClose();
            }}
            className="w-full text-left text-xs px-2 py-1.5 rounded border border-dashed border-accent/50 hover:bg-accent-soft dark:hover:bg-accent/30 transition"
          >
            <span className="italic opacity-60">[Proposed]</span>{' '}
            <span className="font-medium">{trimmed}</span>
          </button>
        )}
      </div>
    </div>
  );
}
