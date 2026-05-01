'use client';

import Link from 'next/link';
import { useMemo, useState, useEffect } from 'react';
import { useStore } from '@/lib/store';
import { ExportPreview } from '@/components/ExportPreview';
import { exportFilename, generateCsv, type CsvOptions } from '@/lib/csv-export';
import { generateBackupJson } from '@/lib/json-backup';
import {
  appendToLedger,
  bookToLedgerEntry,
  pushLedgerDelta,
} from '@/lib/export-ledger';
import {
  buildChangelogEntries,
  buildUpdatedVocabularyJson,
  findProposedTagsToPromote,
} from '@/lib/vocabulary-update';
import type { BookRecord } from '@/lib/types';

const UNCATEGORIZED = '__uncategorized__';

export default function ExportPage() {
  const { state } = useStore();

  const approved = useMemo(
    () => state.allBooks.filter((b) => b.status === 'approved'),
    [state.allBooks]
  );
  const pending = state.allBooks.filter((b) => b.status === 'pending').length;
  const rejected = state.allBooks.filter((b) => b.status === 'rejected').length;

  // Group approved books by batch label.
  const batches = useMemo(() => {
    const map = new Map<string, BookRecord[]>();
    for (const b of approved) {
      const key = b.batchLabel ?? UNCATEGORIZED;
      const arr = map.get(key) ?? [];
      arr.push(b);
      map.set(key, arr);
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === UNCATEGORIZED && b !== UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED && a !== UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    });
    return keys.map((key) => ({
      key,
      label: key === UNCATEGORIZED ? 'Uncategorized' : key,
      books: map.get(key)!,
    }));
  }, [approved]);

  const hasMultipleBatches = batches.length > 1 || (batches.length === 1 && batches[0].key !== UNCATEGORIZED);
  const hasAnyBatchLabel = batches.some((b) => b.key !== UNCATEGORIZED);

  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(
    () => new Set(batches.map((b) => b.key))
  );
  const [splitByBatch, setSplitByBatch] = useState(false);
  const [collectionsFromBatch, setCollectionsFromBatch] = useState(true);
  const [tagsFromBatch, setTagsFromBatch] = useState(true);

  // Keep `selectedBatches` in sync as batches change (new uploads etc.)
  useEffect(() => {
    setSelectedBatches((prev) => {
      const next = new Set<string>();
      for (const b of batches) {
        if (prev.has(b.key) || prev.size === 0) next.add(b.key);
      }
      // If prev was empty (first render with non-empty batches), select all.
      if (prev.size === 0) {
        for (const b of batches) next.add(b.key);
      }
      return next;
    });
  }, [batches]);

  const booksToExport = useMemo(() => {
    return batches
      .filter((b) => selectedBatches.has(b.key))
      .flatMap((b) => b.books);
  }, [batches, selectedBatches]);

  const csvOptions: CsvOptions = {
    collectionsFromBatch: collectionsFromBatch && hasAnyBatchLabel,
    tagsFromBatch: tagsFromBatch && hasAnyBatchLabel,
  };

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadOne(books: BookRecord[], label?: string) {
    if (books.length === 0) return;
    // Share one timestamp between the CSV and JSON so the filename roots
    // line up exactly — important when split-by-batch writes several pairs
    // in the same second.
    const date = new Date();

    const csv = generateCsv(books, csvOptions);
    const csvName = exportFilename(books.length, date, label, 'csv');
    triggerDownload(
      new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }),
      csvName
    );

    // Companion JSON backup. Same name root, .json extension. Captures the
    // full BookRecord shape so the user has a permanent record of every
    // export, independent of localStorage.
    const jsonName = exportFilename(books.length, date, label, 'json');
    const json = generateBackupJson(books, {
      csvCompanion: csvName,
      batchLabel: label,
      date,
    });
    triggerDownload(
      new Blob([json], { type: 'application/json;charset=utf-8' }),
      jsonName
    );
  }

  function downloadCsv() {
    if (booksToExport.length === 0) return;
    if (splitByBatch) {
      // One file per selected batch, downloaded sequentially.
      for (const b of batches.filter((g) => selectedBatches.has(g.key))) {
        const labelForFilename = b.key === UNCATEGORIZED ? undefined : b.label;
        downloadOne(b.books, labelForFilename);
      }
    } else {
      downloadOne(booksToExport);
    }
    // Record everything we just shipped so future batches can flag duplicates.
    // Triggering the download triggers the ledger write — there's no separate
    // "confirm import" step, so this is the most reliable signal we have.
    appendToLedger(booksToExport);
    // Fan the same delta out to the repo so other devices see the export
    // on their next load. Fire-and-forget — the local cache is already
    // updated, so the user can keep working even if the network call is
    // slow or fails. State surfaces through ledgerSyncState below.
    setLedgerSyncState({ kind: 'pending' });
    const date = new Date();
    pushLedgerDelta({ add: booksToExport.map((b) => bookToLedgerEntry(b, date)) })
      .then((res) => {
        if (!res.available) {
          setLedgerSyncState({ kind: 'local-only' });
          return;
        }
        if (res.error) {
          setLedgerSyncState({ kind: 'error', message: res.error });
          return;
        }
        setLedgerSyncState({
          kind: 'synced',
          commitUrl: res.commit?.url,
          unchanged: !res.commit?.sha,
        });
      })
      .catch((err: unknown) =>
        setLedgerSyncState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      );
  }

  // Ledger sync state for the post-export confirmation banner.
  const [ledgerSyncState, setLedgerSyncState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'synced'; commitUrl?: string; unchanged: boolean }
    | { kind: 'local-only' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Vocabulary updates — proposed tags from this export set, ready to be
  // promoted into tag-vocabulary.json.
  const promotions = useMemo(
    () => findProposedTagsToPromote(booksToExport),
    [booksToExport]
  );

  // GitHub commit availability — checked once per page load. When the env
  // is wired with GITHUB_TOKEN, we offer a single-click "Commit to repo"
  // path and fall back to download only on failure or by user choice.
  const [commitInfo, setCommitInfo] = useState<{
    available: boolean;
    repo?: string;
    branch?: string;
  } | null>(null);
  const [commitState, setCommitState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done'; newTagCount: number; commits: Array<{ path: string; url?: string }> }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/commit-vocabulary')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        if (!cancelled) setCommitInfo(data);
      })
      .catch(() => {
        if (!cancelled) setCommitInfo({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function commitVocabularyToRepo() {
    if (promotions.length === 0) return;
    setCommitState({ kind: 'pending' });
    const date = new Date();
    try {
      const res = await fetch('/api/commit-vocabulary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vocabularyJson: buildUpdatedVocabularyJson(promotions),
          changelogEntries: buildChangelogEntries(promotions, date),
          newTagCount: promotions.length,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // 501 = token missing; surface a clear "fall back to download" hint.
        if (res.status === 501) {
          setCommitInfo({ available: false });
          setCommitState({
            kind: 'error',
            message:
              'GITHUB_TOKEN is not configured on the server. Use the download workflow instead.',
          });
          return;
        }
        throw new Error(data.details ?? data.error ?? `Commit failed (${res.status})`);
      }
      setCommitState({
        kind: 'done',
        newTagCount: data.newTagCount,
        commits: data.commits ?? [],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCommitState({ kind: 'error', message });
    }
  }

  function downloadVocabularyUpdates() {
    if (promotions.length === 0) return;
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10);

    // 1) Updated tag-vocabulary.json
    const json = buildUpdatedVocabularyJson(promotions);
    const jsonBlob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const jsonUrl = URL.createObjectURL(jsonBlob);
    const a1 = document.createElement('a');
    a1.href = jsonUrl;
    a1.download = 'tag-vocabulary.json';
    document.body.appendChild(a1);
    a1.click();
    document.body.removeChild(a1);
    URL.revokeObjectURL(jsonUrl);

    // 2) Changelog additions (appendable to vocabulary-changelog.md)
    const changelog = buildChangelogEntries(promotions, date);
    const mdBlob = new Blob([changelog], { type: 'text/markdown;charset=utf-8' });
    const mdUrl = URL.createObjectURL(mdBlob);
    const a2 = document.createElement('a');
    a2.href = mdUrl;
    a2.download = `vocabulary-changelog-additions-${dateStr}.md`;
    document.body.appendChild(a2);
    a2.click();
    document.body.removeChild(a2);
    URL.revokeObjectURL(mdUrl);
  }

  if (state.allBooks.length === 0) {
    return (
      <div className="text-center py-16">
        <h1 className="font-serif text-3xl mb-3">Nothing to export yet</h1>
        <p className="text-sm text-ink/60 dark:text-cream-300/60 mb-6">
          Upload photos and review books before exporting.
        </p>
        <Link
          href="/"
          className="inline-block px-5 py-2.5 rounded-md bg-accent text-cream-50 hover:bg-accent-deep transition"
        >
          Go to upload
        </Link>
      </div>
    );
  }

  function toggleBatch(key: string) {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="typo-page-title">Export to LibraryThing</h1>
        <p className="typo-page-desc max-w-3xl">
          Download a LibraryThing-compatible CSV. Only{' '}
          <span className="font-semibold">approved</span> books will be included.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-green-300 dark:border-green-800 rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 mb-1">
            Approved · will export
          </div>
          <div className="text-3xl font-serif text-green-700 dark:text-green-400">
            {booksToExport.length}
            {booksToExport.length !== approved.length && (
              <span className="text-base text-ink/50 dark:text-cream-300/50 font-sans">
                {' '}
                / {approved.length}
              </span>
            )}
          </div>
        </div>
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 mb-1">
            Pending · excluded
          </div>
          <div className="text-3xl font-serif text-amber-700 dark:text-amber-400">{pending}</div>
        </div>
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-wider text-ink/50 dark:text-cream-300/50 mb-1">
            Rejected · excluded
          </div>
          <div className="text-3xl font-serif text-red-700 dark:text-red-400">{rejected}</div>
        </div>
      </div>

      {/* Pending warning */}
      {pending > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-lg px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-2">
          <span>⚠</span>
          <span>
            <strong>{pending}</strong> book{pending !== 1 ? 's' : ''} still pending review — only
            approved books will be exported.{' '}
            <Link href="/review" className="underline hover:text-amber-700">
              Go review →
            </Link>
          </span>
        </div>
      )}

      {/* Batch + label-routing controls */}
      {hasMultipleBatches && (
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-5 space-y-5">
          <div>
            <div className="text-xs uppercase tracking-wider font-semibold text-ink/60 dark:text-cream-300/60 mb-2">
              Batches to export
            </div>
            <div className="space-y-1.5">
              {batches.map((b) => (
                <label
                  key={b.key}
                  className="flex items-center gap-2 text-sm cursor-pointer hover:text-accent transition"
                >
                  <input
                    type="checkbox"
                    checked={selectedBatches.has(b.key)}
                    onChange={() => toggleBatch(b.key)}
                    className="accent-accent"
                  />
                  <span className="font-medium">{b.label}</span>
                  <span className="text-xs text-ink/50 dark:text-cream-300/50">
                    {b.books.length} book{b.books.length !== 1 ? 's' : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider font-semibold text-ink/60 dark:text-cream-300/60 mb-2">
              Output
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!splitByBatch}
                  onChange={() => setSplitByBatch(false)}
                  className="accent-accent"
                />
                One CSV combining all selected
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={splitByBatch}
                  onChange={() => setSplitByBatch(true)}
                  className="accent-accent"
                />
                Separate CSV per batch
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Where to put the batch label */}
      {hasAnyBatchLabel && (
        <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-5 space-y-3">
          <div className="text-xs uppercase tracking-wider font-semibold text-ink/60 dark:text-cream-300/60">
            Where to put the batch label in LibraryThing
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={collectionsFromBatch}
                onChange={(e) => setCollectionsFromBatch(e.target.checked)}
                className="accent-accent mt-1"
              />
              <span>
                <span className="font-medium">As a Collection</span>
                <span className="block text-[11px] text-ink/50 dark:text-cream-300/50">
                  LT&apos;s native shelf grouping. Goes in the <span className="font-mono">COLLECTIONS</span> column.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tagsFromBatch}
                onChange={(e) => setTagsFromBatch(e.target.checked)}
                className="accent-accent mt-1"
              />
              <span>
                <span className="font-medium">
                  As a tag (<span className="font-mono">location:Shelf 3</span>)
                </span>
                <span className="block text-[11px] text-ink/50 dark:text-cream-300/50">
                  Searchable in LT&apos;s tag cloud. Appended to the <span className="font-mono">TAGS</span> column.
                </span>
              </span>
            </label>
          </div>
          <div className="text-[11px] text-ink/40 dark:text-cream-300/40 italic">
            Pick neither, one, or both. Either way, books still group by batch in Review.
          </div>
        </div>
      )}

      {/* CSV preview */}
      <div>
        <h2 className="text-sm uppercase tracking-wider font-semibold text-ink/50 dark:text-cream-300/50 mb-2">
          CSV preview {splitByBatch && hasMultipleBatches ? '(first selected batch)' : ''}
        </h2>
        <ExportPreview
          books={
            splitByBatch && hasMultipleBatches
              ? batches.find((b) => selectedBatches.has(b.key))?.books ?? []
              : booksToExport
          }
          options={csvOptions}
        />
      </div>

      {/* Vocabulary updates — proposed tags ready to be promoted into the
          controlled vocabulary. Only shown when the export set has any. */}
      {promotions.length > 0 && (
        <div className="bg-brass-soft/40 dark:bg-brass/10 border border-brass/40 rounded-lg p-5 space-y-3">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="text-sm uppercase tracking-[0.18em] font-semibold text-brass-deep dark:text-brass">
              Vocabulary updates
            </h2>
            <span className="text-xs text-ink/55 dark:text-cream-300/55">
              · {promotions.length} new{' '}
              {promotions.length === 1 ? 'tag' : 'tags'} ready to promote
            </span>
          </div>
          <p className="text-sm text-ink/70 dark:text-cream-300/70 leading-relaxed">
            These <span className="font-mono">[Proposed]</span> tags from the
            export set have been auto-assigned to vocabulary domains. Download
            the updated <span className="font-mono">tag-vocabulary.json</span>{' '}
            and append the changelog entries to{' '}
            <span className="font-mono">vocabulary-changelog.md</span>, then
            commit and push. Future books will get clean tags instead of
            <span className="font-mono"> [Proposed] </span>versions.
          </p>
          <ul className="text-sm space-y-1 font-mono">
            {promotions.map((p) => (
              <li
                key={p.tag}
                className="flex items-baseline gap-2 text-ink/80 dark:text-cream-300/80"
              >
                <span className="text-[10px] uppercase tracking-wider text-ink/40 dark:text-cream-300/40 w-32 flex-shrink-0 not-italic">
                  {p.domainLabel}
                </span>
                <span className="font-semibold">{p.tag}</span>
                <span className="text-xs text-ink/45 dark:text-cream-300/45 italic font-sans">
                  — first on &ldquo;{p.sourceBook.title}&rdquo;
                </span>
              </li>
            ))}
          </ul>
          {/* Action row — auto-commit when GITHUB_TOKEN is set, otherwise
              fall back to the manual download workflow. */}
          {commitInfo?.available ? (
            <div className="space-y-3">
              {commitState.kind === 'done' ? (
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-800/50 rounded-md px-4 py-3 text-sm text-green-900 dark:text-green-100 leading-relaxed">
                  Vocabulary updated — {commitState.newTagCount} new{' '}
                  {commitState.newTagCount === 1 ? 'tag' : 'tags'} committed to{' '}
                  <span className="font-mono">{commitInfo.repo}</span>
                  {commitInfo.branch ? (
                    <>
                      {' '}on <span className="font-mono">{commitInfo.branch}</span>
                    </>
                  ) : null}
                  .
                  {commitState.commits.length > 0 && (
                    <span className="block mt-1 text-xs text-green-800/80 dark:text-green-200/70">
                      {commitState.commits.map((c, i) => (
                        <span key={c.path} className="inline-block mr-3">
                          {c.url ? (
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline underline-offset-2 hover:text-green-700 dark:hover:text-green-50"
                            >
                              {c.path}
                            </a>
                          ) : (
                            <span className="font-mono">{c.path}</span>
                          )}
                          {i < commitState.commits.length - 1 ? '' : ''}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="block mt-1 text-xs italic text-green-800/70 dark:text-green-200/60">
                    Vercel auto-redeploys from the commit; the next batch will use the
                    updated vocabulary.
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={commitVocabularyToRepo}
                    disabled={commitState.kind === 'pending'}
                    className="text-sm px-4 py-2 rounded-md bg-brass text-accent-deep hover:bg-brass-deep hover:text-limestone font-medium transition disabled:opacity-60 disabled:cursor-progress"
                  >
                    {commitState.kind === 'pending'
                      ? 'Committing…'
                      : `Commit ${promotions.length} new ${promotions.length === 1 ? 'tag' : 'tags'} to repo`}
                  </button>
                  <button
                    onClick={downloadVocabularyUpdates}
                    className="text-xs px-3 py-1.5 rounded-md border border-brass/50 text-brass-deep dark:text-brass hover:bg-brass/10 font-medium transition"
                    title="Download the files manually instead of committing through the API."
                  >
                    Download files instead
                  </button>
                </div>
              )}

              {commitState.kind === 'error' && (
                <div className="bg-mahogany/10 dark:bg-tartan/30 border border-mahogany/40 dark:border-tartan/50 rounded-md px-4 py-3 text-sm text-mahogany dark:text-orange-100">
                  <div className="font-semibold mb-1">Couldn&rsquo;t commit to GitHub</div>
                  <div className="text-xs leading-relaxed font-mono break-all">
                    {commitState.message}
                  </div>
                  <button
                    onClick={downloadVocabularyUpdates}
                    className="mt-2 text-xs underline underline-offset-2 hover:text-mahogany/80"
                  >
                    Download files instead →
                  </button>
                </div>
              )}

              <div className="text-[11px] text-ink/45 dark:text-cream-300/45 italic leading-relaxed">
                Commits go to{' '}
                <span className="font-mono">{commitInfo.repo}</span>
                {commitInfo.branch ? (
                  <>
                    {' '}on <span className="font-mono">{commitInfo.branch}</span>
                  </>
                ) : null}
                : one for{' '}
                <span className="font-mono">lib/tag-vocabulary.json</span>, one for{' '}
                <span className="font-mono">lib/vocabulary-changelog.md</span>.
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={downloadVocabularyUpdates}
                className="text-sm px-4 py-2 rounded-md bg-brass text-accent-deep hover:bg-brass-deep hover:text-limestone font-medium transition"
              >
                Download vocabulary updates ({promotions.length})
              </button>
              <div className="text-[11px] text-ink/45 dark:text-cream-300/45 italic">
                Two files will download: the new{' '}
                <span className="font-mono">tag-vocabulary.json</span> (replace the
                one in <span className="font-mono">/lib</span>) and a dated{' '}
                <span className="font-mono">vocabulary-changelog-additions-*.md</span>{' '}
                (append to <span className="font-mono">vocabulary-changelog.md</span>).
                Set <span className="font-mono">GITHUB_TOKEN</span> on the server to enable
                one-click commits instead.
              </div>
            </>
          )}
        </div>
      )}

      {/* Download */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 pt-4 border-t border-cream-300 dark:border-ink-soft">
        <div className="text-xs text-ink/60 dark:text-cream-300/60 max-w-md leading-relaxed">
          To import: log into LibraryThing, go to{' '}
          <span className="font-mono">More → Import books</span>, choose{' '}
          <span className="font-mono">CSV/text file</span>, and upload the file you download here.
        </div>
        <button
          onClick={downloadCsv}
          disabled={booksToExport.length === 0}
          className="px-5 py-2.5 rounded-md bg-accent text-limestone hover:bg-accent-deep disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
        >
          {splitByBatch && hasMultipleBatches
            ? `Download ${selectedBatches.size} CSV${selectedBatches.size !== 1 ? 's' : ''}`
            : `Download CSV (${booksToExport.length})`}
        </button>
      </div>

      {/* Ledger sync state — shown after a CSV download triggers the
          repo-side write. Idle pre-export; no banner clutter. */}
      {ledgerSyncState.kind !== 'idle' && (
        <div
          className={`mt-2 px-4 py-3 rounded-md text-sm leading-relaxed ${
            ledgerSyncState.kind === 'synced'
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-800/50 text-green-900 dark:text-green-100'
              : ledgerSyncState.kind === 'error'
                ? 'bg-mahogany/10 dark:bg-tartan/30 border border-mahogany/40 dark:border-tartan/50 text-mahogany dark:text-orange-100'
                : 'bg-cream-100 dark:bg-ink/60 border border-cream-300 dark:border-brass/20 text-ink/70 dark:text-cream-300/80'
          }`}
        >
          {ledgerSyncState.kind === 'pending' && <>Syncing ledger to repo…</>}
          {ledgerSyncState.kind === 'synced' && (
            <>
              {ledgerSyncState.unchanged
                ? 'Ledger unchanged — no new entries to commit.'
                : 'Ledger synced to repo — every device will see this export on next load.'}
              {ledgerSyncState.commitUrl && (
                <>
                  {' '}
                  <a
                    href={ledgerSyncState.commitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-green-700 dark:hover:text-green-50"
                  >
                    View commit →
                  </a>
                </>
              )}
            </>
          )}
          {ledgerSyncState.kind === 'local-only' && (
            <>
              Ledger updated locally only — <span className="font-mono">GITHUB_TOKEN</span>{' '}
              isn&rsquo;t configured, so other devices won&rsquo;t see this export until the
              token is set.
            </>
          )}
          {ledgerSyncState.kind === 'error' && (
            <>
              <div className="font-semibold">Couldn&rsquo;t sync ledger to repo</div>
              <div className="text-xs font-mono break-all mt-1">
                {ledgerSyncState.message}
              </div>
              <div className="text-xs italic mt-1">
                Local cache is updated; this device will still flag duplicates correctly.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
