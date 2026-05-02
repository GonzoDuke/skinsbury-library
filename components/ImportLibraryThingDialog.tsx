'use client';

/**
 * Import-from-LibraryThing dialog. Three states:
 *   1. Idle — file picker; user selects an LT export file.
 *   2. Preview — parsed counts (total / new / duplicate / skipped),
 *      Cancel and Import buttons.
 *   3. Posting — loading; followed by Success or Error.
 *
 * Heavy lifting lives in lib/librarything-import.ts. This component
 * is just the UX shell + the call to pushLedgerDelta.
 */

import { useEffect, useState } from 'react';
import {
  buildPreview,
  parseFile,
  type ImportPreview,
  type LtRecord,
} from '@/lib/librarything-import';
import { loadLedger, pushLedgerDelta } from '@/lib/export-ledger';

interface Props {
  onClose: () => void;
  /** Fired after a successful import so the parent can refresh its ledger view. */
  onImported: (count: number) => void;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'parsing' }
  | { kind: 'preview'; records: LtRecord[]; preview: ImportPreview; filename: string }
  | { kind: 'posting' }
  | { kind: 'done'; added: number }
  | { kind: 'error'; message: string };

export function ImportLibraryThingDialog({ onClose, onImported }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && stage.kind !== 'posting') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, onClose]);

  async function handleFile(f: File) {
    setStage({ kind: 'parsing' });
    try {
      const text = await f.text();
      const records = parseFile(f.name, text);
      if (records.length === 0) {
        setStage({
          kind: 'error',
          message: `Couldn't read any books from ${f.name}. Check the format — Carnegie accepts JSON, CSV, or TSV exports from librarything.com/export.php.`,
        });
        return;
      }
      const existing = loadLedger();
      const preview = buildPreview(records, existing);
      setStage({ kind: 'preview', records, preview, filename: f.name });
    } catch (err) {
      setStage({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to read file.',
      });
    }
  }

  async function commit() {
    if (stage.kind !== 'preview') return;
    const additions = stage.preview.newEntries;
    if (additions.length === 0) {
      setStage({ kind: 'done', added: 0 });
      onImported(0);
      return;
    }
    setStage({ kind: 'posting' });
    const res = await pushLedgerDelta({ add: additions });
    if (!res.available) {
      setStage({
        kind: 'error',
        message:
          'GITHUB_TOKEN is not configured on the server — imports are read-only here. Try again from a deployment with the token set.',
      });
      return;
    }
    if (res.error) {
      setStage({ kind: 'error', message: res.error });
      return;
    }
    setStage({ kind: 'done', added: additions.length });
    onImported(additions.length);
  }

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Import LibraryThing catalog"
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={() => stage.kind !== 'posting' && onClose()}
      />
      <div className="relative w-[min(94vw,560px)] max-h-[88vh] overflow-y-auto rounded-2xl bg-surface-card border border-line shadow-2xl p-5 space-y-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[20px] font-semibold text-text-primary">
            Import from LibraryThing
          </h2>
          {stage.kind !== 'posting' && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 rounded-full text-text-quaternary hover:bg-surface-page transition flex items-center justify-center text-lg"
            >
              ×
            </button>
          )}
        </div>

        {stage.kind === 'idle' && (
          <div className="space-y-3">
            <p className="text-[13px] text-text-secondary leading-relaxed">
              Upload your LibraryThing export to seed Carnegie&rsquo;s ledger
              with your existing catalog. Books in the import will flag as
              duplicates if you scan or photograph them later.
            </p>
            <p className="text-[12px] text-text-tertiary leading-relaxed">
              Get your file from{' '}
              <a
                href="https://www.librarything.com/export.php"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-navy"
              >
                librarything.com/export.php
              </a>{' '}
              — JSON, CSV, or TSV all work. The import is additive and
              re-running it is safe (duplicates are skipped automatically).
            </p>
            <label
              className="block cursor-pointer rounded-md border border-dashed border-line py-8 text-center bg-surface-page hover:border-navy hover:bg-navy-soft/50 transition"
            >
              <input
                type="file"
                accept=".json,.csv,.tsv,.tab,.txt,application/json,text/csv,text/tab-separated-values,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <div className="text-[14px] font-medium text-text-secondary">
                Choose a LibraryThing export file
              </div>
              <div className="text-[11px] text-text-quaternary mt-1">
                .json · .csv · .tsv
              </div>
            </label>
          </div>
        )}

        {stage.kind === 'parsing' && (
          <div className="text-[13px] text-text-secondary py-6 text-center">
            Parsing…
          </div>
        )}

        {stage.kind === 'preview' && (
          <div className="space-y-4">
            <div className="text-[13px] text-text-secondary leading-relaxed">
              Found <span className="font-semibold text-text-primary">{stage.preview.total}</span>{' '}
              {stage.preview.total === 1 ? 'book' : 'books'} in{' '}
              <span className="font-mono text-[12px]">{stage.filename}</span>.
            </div>
            <ul className="text-[13px] text-text-secondary space-y-1.5 bg-surface-page border border-line rounded-md p-3">
              <li>
                <span className="font-semibold text-text-primary">
                  {stage.preview.toAdd}
                </span>{' '}
                will be added to the ledger.
              </li>
              {stage.preview.existing > 0 && (
                <li>
                  <span className="font-semibold text-text-primary">
                    {stage.preview.existing}
                  </span>{' '}
                  already exist (matched by ISBN or title + author) — skipped.
                </li>
              )}
              {stage.preview.unrecoverable > 0 && (
                <li>
                  <span className="font-semibold text-text-primary">
                    {stage.preview.unrecoverable}
                  </span>{' '}
                  have no ISBN and no title — can&rsquo;t dedupe, dropped.
                </li>
              )}
            </ul>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-[13px] px-4 py-2 rounded-md border border-line text-text-secondary hover:bg-surface-page transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={stage.preview.toAdd === 0}
                className="text-[13px] font-medium px-5 py-2 rounded-md bg-navy text-white hover:bg-navy-deep disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {stage.preview.toAdd === 0
                  ? 'Nothing new to import'
                  : `Import ${stage.preview.toAdd} ${stage.preview.toAdd === 1 ? 'book' : 'books'}`}
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'posting' && (
          <div className="text-[13px] text-text-secondary py-6 text-center">
            Committing to GitHub…
          </div>
        )}

        {stage.kind === 'done' && (
          <div className="space-y-3">
            <div className="bg-carnegie-green-soft border border-carnegie-green/30 rounded-md px-3 py-2 text-[13px] text-text-primary">
              {stage.added === 0
                ? 'Already up to date — nothing new to import.'
                : `Imported ${stage.added} ${stage.added === 1 ? 'book' : 'books'} from LibraryThing. They'll flag as duplicates if scanned or photographed.`}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="text-[13px] px-4 py-2 rounded-md bg-navy text-white hover:bg-navy-deep transition"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="space-y-3">
            <div className="bg-mahogany/10 border border-mahogany/40 text-mahogany rounded-md px-3 py-2 text-[13px] leading-relaxed">
              <div className="font-semibold mb-1">Import failed</div>
              <div className="text-[12px] font-mono break-all">{stage.message}</div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStage({ kind: 'idle' })}
                className="text-[13px] px-4 py-2 rounded-md border border-line text-text-secondary hover:bg-surface-page transition"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-[13px] px-4 py-2 rounded-md bg-navy text-white hover:bg-navy-deep transition"
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
