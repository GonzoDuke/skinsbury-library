'use client';

/**
 * Vocabulary screen — manage the controlled tag vocabulary.
 *
 * Two-column layout per spec §6:
 *   left rail (180px)   — domains list with per-domain tag counts and an
 *                         "All" entry at the top, navy left-border on the
 *                         active row to match the sidebar nav rail
 *   right pane          — add-tag bar (name input + domain select +
 *                         navy "Add" button), tag table (name / domain /
 *                         usage / delete), collapsible changelog at foot
 *
 * Vocabulary edits flow through /api/commit-vocabulary (the same route
 * the Export screen's auto-promote uses). Adds and deletes are
 * optimistic — the local state updates immediately and the GitHub
 * commit happens in the background; on failure we revert.
 *
 * Usage counts come from two sources combined: every export-ledger entry
 * with this tag (durable, survives session resets) plus every book in
 * the current session that carries it (catches in-flight work that
 * hasn't been exported yet).
 */
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { VOCAB, type DomainKey } from '@/lib/tag-domains';
import { loadLedger, pushLedgerDelta, syncLedgerFromRepo } from '@/lib/export-ledger';
import { isNoWriteMode, logSkippedWrite } from '@/lib/no-write-mode';
import vocabSeed from '@/lib/tag-vocabulary.json';

interface VocabShape {
  domains: Record<
    DomainKey,
    { label: string; lcc_letter: string; description?: string; tags: string[] }
  >;
  form_tags: { content_forms: string[]; series: string[]; collectible: string[] };
  updated?: string;
}

type Selection = 'all' | DomainKey;

interface ChangelogEntry {
  date: string;
  tag: string;
  domain: string;
  source?: string;
}

const DOMAIN_KEYS: DomainKey[] = Object.keys(VOCAB.domains) as DomainKey[];

/**
 * Order DOMAIN_KEYS by the human-readable label of each domain. The
 * raw key order from tag-vocabulary.json reflects how the file was
 * authored — not alphabetical. Sort wherever a user-facing list of
 * domains is rendered (left rail, "all" row groupings, the new-tag
 * dropdown).
 */
function sortDomainKeysByLabel(
  keys: DomainKey[],
  domains: VocabShape['domains']
): DomainKey[] {
  return [...keys].sort((a, b) =>
    (domains[a]?.label ?? a).localeCompare(domains[b]?.label ?? b)
  );
}

export default function VocabularyPage() {
  const { state } = useStore();

  // Local copy of the vocabulary — mutated optimistically on add/delete.
  // Seeded from the bundled JSON so any prior repo write that shipped in
  // a fresh deploy is reflected without a roundtrip.
  const [vocab, setVocab] = useState<VocabShape>(() =>
    JSON.parse(JSON.stringify(vocabSeed)) as VocabShape
  );
  const [selection, setSelection] = useState<Selection>('all');
  const [newTagName, setNewTagName] = useState('');
  // Domain keys ordered alphabetically by label. Recomputed when vocab
  // shifts so a freshly-added domain (none currently, but future-proof)
  // would slot in alphabetically too.
  const sortedDomainKeys = useMemo(
    () => sortDomainKeysByLabel(DOMAIN_KEYS, vocab.domains),
    [vocab]
  );
  const [newTagDomain, setNewTagDomain] = useState<DomainKey>(
    () => sortDomainKeysByLabel(DOMAIN_KEYS, vocabSeed.domains)[0]
  );
  const [busy, setBusy] = useState<{ kind: 'add' | 'delete' | 'rename'; tag: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ tag: string; domain: DomainKey } | null>(
    null
  );
  // Active rename: tag row currently in inline-edit mode + the draft.
  const [renaming, setRenaming] = useState<{
    domain: DomainKey;
    from: string;
    draft: string;
  } | null>(null);

  // Changelog view + ledger usage map. Both fetched once on mount.
  const [changelogText, setChangelogText] = useState<string>('');
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [, forceLedgerRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/changelog')
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => {
        if (!cancelled) setChangelogText(t);
      })
      .catch(() => {
        /* leave empty */
      });
    syncLedgerFromRepo()
      .catch(() => null)
      .finally(() => {
        if (!cancelled) forceLedgerRefresh((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build a tag → usage-count map. Includes ledger entries that recorded
  // their tags AND books from the current session (covers in-flight work).
  const usageByTag = useMemo(() => {
    const counts = new Map<string, number>();
    const bump = (rawTag: string) => {
      const t = rawTag.replace(/^\[Proposed\]\s*/i, '').trim();
      if (!t) return;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    };
    for (const e of loadLedger()) (e.tags ?? []).forEach(bump);
    for (const b of state.allBooks) {
      [...b.genreTags, ...b.formTags].forEach(bump);
    }
    return counts;
    // Recompute when the session books shift OR when we just synced the
    // ledger from the repo (the dummy state bump triggers it). Note we
    // intentionally don't depend on `vocab` here — the count is
    // tag-string driven, vocabulary changes don't move counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.allBooks]);

  /**
   * Flat list of every tag in the current vocab, with its domain.
   * Ordered: domain alphabetical (by label), then tag alphabetical
   * within each domain. The "All" view consumes this list as-is so it
   * displays domains in alphabetical order with tags grouped under
   * each. Single-domain selections filter this list, which preserves
   * the intra-domain alphabetical order.
   */
  const allRows = useMemo(() => {
    const rows: { tag: string; domain: DomainKey; domainLabel: string }[] = [];
    for (const key of sortedDomainKeys) {
      const def = vocab.domains[key];
      if (!def) continue;
      const tagsAlpha = [...def.tags].sort((a, b) => a.localeCompare(b));
      for (const tag of tagsAlpha) {
        rows.push({ tag, domain: key, domainLabel: def.label });
      }
    }
    return rows;
  }, [vocab, sortedDomainKeys]);

  const [search, setSearch] = useState('');
  const filteredRows = useMemo(() => {
    const byDomain =
      selection === 'all' ? allRows : allRows.filter((r) => r.domain === selection);
    const q = search.trim().toLowerCase();
    if (!q) return byDomain;
    return byDomain.filter((r) => r.tag.toLowerCase().includes(q));
  }, [allRows, selection, search]);

  /** Push the current `vocab` state to the GitHub Contents API. */
  async function commitVocab(
    nextVocab: VocabShape,
    changelogLine: string,
    commitMessage: string
  ): Promise<boolean> {
    setError(null);
    // Local-only mode early-return — pretend the commit succeeded. The
    // caller treats `true` as "vocabulary update accepted", which
    // matches what we want: in-memory and localStorage state already
    // reflect the change; we just don't persist to the repo.
    if (isNoWriteMode()) {
      logSkippedWrite('vocabulary commit (POST /api/commit-vocabulary)', {
        commitMessage,
      });
      return true;
    }
    try {
      const json = JSON.stringify(nextVocab, null, 2) + '\n';
      const dateStr = new Date().toISOString().slice(0, 10);
      const entries = `## ${dateStr}\n\n- ${changelogLine}\n`;
      const res = await fetch('/api/commit-vocabulary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vocabularyJson: json,
          changelogEntries: entries,
          newTagCount: 1,
          commitMessage,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 501) {
        setError(
          'GITHUB_TOKEN is not configured on the server — vocabulary edits are read-only here.'
        );
        return false;
      }
      if (!res.ok || !data.ok) {
        setError(data.details ?? data.error ?? `Commit failed (${res.status})`);
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function onAddTag() {
    const name = newTagName.trim();
    if (!name) return;
    const domainKey = newTagDomain;
    const domain = vocab.domains[domainKey];
    if (!domain) return;
    if (
      domain.tags.some((t) => t.toLowerCase() === name.toLowerCase())
    ) {
      setError(`"${name}" already exists in ${domain.label}.`);
      return;
    }
    setBusy({ kind: 'add', tag: name });
    const next: VocabShape = JSON.parse(JSON.stringify(vocab));
    next.domains[domainKey].tags = [...next.domains[domainKey].tags, name].sort(
      (a, b) => a.localeCompare(b)
    );
    next.updated = new Date().toISOString().slice(0, 10);
    const optimistic = vocab;
    setVocab(next);
    const ok = await commitVocab(
      next,
      `Added \`${name}\` to **${domain.label}** (manual)`,
      `Vocabulary: add "${name}" to ${domain.label}`
    );
    setBusy(null);
    if (!ok) {
      // Revert.
      setVocab(optimistic);
      return;
    }
    setNewTagName('');
  }

  async function onDeleteTag(tag: string, domainKey: DomainKey) {
    const domain = vocab.domains[domainKey];
    if (!domain) return;
    setBusy({ kind: 'delete', tag });
    setConfirm(null);
    const next: VocabShape = JSON.parse(JSON.stringify(vocab));
    next.domains[domainKey].tags = next.domains[domainKey].tags.filter(
      (t) => t !== tag
    );
    next.updated = new Date().toISOString().slice(0, 10);
    const optimistic = vocab;
    setVocab(next);
    const ok = await commitVocab(
      next,
      `Removed \`${tag}\` from **${domain.label}**`,
      `Vocabulary: remove "${tag}" from ${domain.label}`
    );
    setBusy(null);
    if (!ok) setVocab(optimistic);
  }

  async function onRenameTag(
    fromTag: string,
    toTag: string,
    domainKey: DomainKey
  ) {
    const trimmed = toTag.trim();
    if (!trimmed || trimmed === fromTag) {
      setRenaming(null);
      return;
    }
    const domain = vocab.domains[domainKey];
    if (!domain) return;
    if (
      domain.tags.some(
        (t) => t.toLowerCase() === trimmed.toLowerCase() && t !== fromTag
      )
    ) {
      setError(`"${trimmed}" already exists in ${domain.label}.`);
      return;
    }
    const usage = usageByTag.get(fromTag) ?? 0;
    const ok = window.confirm(
      `Rename "${fromTag}" to "${trimmed}"?\n\n` +
        `${
          usage === 0
            ? 'This tag is not used on any books yet.'
            : `This will update ${usage} ${usage === 1 ? 'book' : 'books'} in the ledger.`
        }`
    );
    if (!ok) return;

    setBusy({ kind: 'rename', tag: fromTag });
    setError(null);
    const optimistic = vocab;
    const next: VocabShape = JSON.parse(JSON.stringify(vocab));
    next.domains[domainKey].tags = next.domains[domainKey].tags
      .map((t) => (t === fromTag ? trimmed : t))
      .sort((a, b) => a.localeCompare(b));
    next.updated = new Date().toISOString().slice(0, 10);
    setVocab(next);
    setRenaming(null);
    const vocabOk = await commitVocab(
      next,
      `Renamed \`${fromTag}\` to \`${trimmed}\` in **${domain.label}**`,
      `Vocabulary: rename "${fromTag}" → "${trimmed}" in ${domain.label}`
    );
    if (!vocabOk) {
      setVocab(optimistic);
      setBusy(null);
      return;
    }
    // Propagate to the export ledger so historical tags flip too.
    try {
      await pushLedgerDelta({ renameTag: { from: fromTag, to: trimmed } });
    } catch (err) {
      // Ledger push failure is non-fatal — the vocabulary already
      // updated. Surface the error so the user knows historical
      // entries didn't propagate.
      setError(
        err instanceof Error
          ? `Vocabulary updated, but ledger rename failed: ${err.message}`
          : 'Vocabulary updated, but ledger rename failed.'
      );
    }
    setBusy(null);
  }

  const parsedChangelog = useMemo(
    () => parseChangelog(changelogText),
    [changelogText]
  );

  // Stacked phone view shares every piece of state and handler with the
  // desktop layout below. `md:hidden` gates this block; the desktop grid
  // is `hidden md:grid` so a single render path covers both viewports.
  const phoneView = (
    <div className="md:hidden flex flex-col">
      {/* Horizontal scrollable domain pills. "All" first so it's the
          default selection. -mx-4 + px-4 lets the row bleed past the
          page padding so the first/last pill can sit flush at the
          edges instead of in a centered column. */}
      <div className="-mx-4 px-4 overflow-x-auto pb-2 mb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-1.5 w-max">
          <DomainPill
            label="All"
            count={allRows.length}
            active={selection === 'all'}
            onClick={() => setSelection('all')}
          />
          {sortedDomainKeys.map((k) => {
            const def = vocab.domains[k];
            if (!def) return null;
            return (
              <DomainPill
                key={k}
                label={def.label}
                count={def.tags.length}
                active={selection === k}
                onClick={() => setSelection(k)}
              />
            );
          })}
        </div>
      </div>

      {error && (
        <div className="bg-carnegie-red-soft border border-carnegie-red/40 text-carnegie-red rounded-md px-3 py-2 text-[12px] mb-2">
          {error}
        </div>
      )}

      {/* Tag search (phone) — same filter source as the desktop view. */}
      <div className="relative mb-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tags…"
          className="w-full bg-surface-card border border-line rounded-md pl-8 pr-8 py-2 text-[14px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy"
        />
        <span
          aria-hidden
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-quaternary text-[14px]"
        >
          ⌕
        </span>
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full text-text-quaternary"
          >
            ×
          </button>
        )}
      </div>

      {/* Single-column tag stack. Each row: tag name, domain label,
          usage count, delete button. */}
      <div className="bg-surface-card border border-line rounded-lg overflow-hidden mb-3">
        {filteredRows.length === 0 ? (
          <div className="text-[13px] text-text-tertiary italic p-6 text-center">
            No tags in this domain yet.
          </div>
        ) : (
          filteredRows.map((row) => {
            const usage = usageByTag.get(row.tag) ?? 0;
            return (
              <div
                key={`${row.domain}:${row.tag}`}
                className="flex items-center gap-3 px-3 py-3 border-b border-line-light last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-text-primary truncate">
                    {row.tag}
                  </div>
                  <div className="text-[11px] text-text-tertiary truncate">
                    {row.domainLabel}
                    <span className="mx-1.5 text-text-quaternary">·</span>
                    <span
                      className={`font-mono ${
                        usage === 0 ? 'text-text-quaternary' : 'text-text-secondary'
                      }`}
                    >
                      {usage} {usage === 1 ? 'use' : 'uses'}
                    </span>
                  </div>
                </div>
                {/* Delete is desktop/tablet only — phone gets a read +
                    add-only experience. The destructive action (and
                    its confirm flow) lives in the desktop layout below. */}
              </div>
            );
          })
        )}
      </div>

      {/* Collapsible changelog — same as desktop, just inline rather
          than in the right pane. Lives ABOVE the sticky add-tag bar
          so it scrolls with the rest of the content. */}
      <div className="bg-surface-card border border-line rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setChangelogOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-[13px] font-medium text-text-secondary"
          aria-expanded={changelogOpen}
        >
          <span className="flex items-center gap-2">
            <span className="typo-label">Changelog</span>
            {parsedChangelog.length > 0 && (
              <span className="text-[11px] text-text-tertiary">
                {parsedChangelog.length}{' '}
                {parsedChangelog.length === 1 ? 'entry' : 'entries'}
              </span>
            )}
          </span>
          <span className="text-text-tertiary">{changelogOpen ? '▾' : '▸'}</span>
        </button>
        {changelogOpen && (
          <div className="border-t border-line-light px-3 py-2.5 space-y-1.5 max-h-[280px] overflow-y-auto">
            {parsedChangelog.length === 0 ? (
              <div className="text-[12px] text-text-tertiary italic">
                No changelog entries found.
              </div>
            ) : (
              parsedChangelog.map((e, i) => (
                <div key={i} className="text-[12px] leading-snug">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[11px] text-text-tertiary flex-shrink-0">
                      {e.date}
                    </span>
                    <span className="text-text-primary font-medium truncate">
                      {e.tag}
                    </span>
                  </div>
                  <div className="typo-label mt-0.5">
                    {e.domain}
                    {e.source && (
                      <span className="text-[11px] text-text-tertiary italic ml-1.5 normal-case tracking-normal">
                        — {e.source}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Spacer so the last content row isn't covered by the sticky
          add-tag bar. The bar is ~158px tall (input + select + button +
          padding) above the 56px tab bar. */}
      <div aria-hidden className="h-[180px]" />

      {/* Sticky add-tag panel — pinned just above the bottom tab bar.
          Stacked: name input, domain select, full-width Add button. */}
      <div
        className="fixed inset-x-0 z-20 bg-surface-card border-t border-line px-3 pt-2 pb-2 space-y-2 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]"
        style={{
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 56px)',
        }}
      >
        <input
          type="text"
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newTagName.trim() && !busy) onAddTag();
          }}
          placeholder="New tag name"
          className="w-full bg-surface-card border border-line rounded-md px-3 py-2 text-[14px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy"
        />
        <select
          value={newTagDomain}
          onChange={(e) => setNewTagDomain(e.target.value as DomainKey)}
          className="w-full bg-surface-card border border-line rounded-md px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:border-navy"
          aria-label="Domain"
        >
          {sortedDomainKeys.map((k) => (
            <option key={k} value={k}>
              {vocab.domains[k]?.label ?? k}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onAddTag}
          disabled={!newTagName.trim() || !!busy}
          className="w-full py-2.5 rounded-md bg-navy text-white text-[14px] font-semibold disabled:opacity-50 transition"
        >
          {busy?.kind === 'add' ? 'Adding…' : 'Add tag'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <h1 className="typo-page-title">Vocabulary</h1>

      {phoneView}

      <div className="hidden md:grid grid-cols-[180px_1fr] gap-6">
        {/* LEFT — domain rail */}
        <aside className="bg-surface-card border border-line rounded-lg overflow-hidden h-max">
          <DomainRow
            label="All"
            count={allRows.length}
            active={selection === 'all'}
            onClick={() => setSelection('all')}
          />
          <div className="border-t border-line-light" />
          {sortedDomainKeys.map((k) => {
            const def = vocab.domains[k];
            if (!def) return null;
            return (
              <DomainRow
                key={k}
                label={def.label}
                count={def.tags.length}
                active={selection === k}
                onClick={() => setSelection(k)}
              />
            );
          })}
        </aside>

        {/* RIGHT — add bar + tag table + changelog */}
        <section className="space-y-4">
          {/* Add tag bar */}
          <div className="bg-surface-card border border-line rounded-lg p-3 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]">
              <label className="typo-label block mb-1">New tag name</label>
              <input
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTagName.trim() && !busy) onAddTag();
                }}
                placeholder="e.g. Profanity studies"
                className="w-full bg-surface-card border border-line rounded-md px-[14px] py-[10px] text-[15px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy"
              />
            </div>
            <div className="min-w-[160px]">
              <label className="typo-label block mb-1">Domain</label>
              <select
                value={newTagDomain}
                onChange={(e) => setNewTagDomain(e.target.value as DomainKey)}
                className="w-full bg-surface-card border border-line rounded-md px-[14px] py-[10px] text-[15px] text-text-primary focus:outline-none focus:border-navy"
              >
                {sortedDomainKeys.map((k) => (
                  <option key={k} value={k}>
                    {vocab.domains[k]?.label ?? k}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={onAddTag}
              disabled={!newTagName.trim() || !!busy}
              className="text-[14px] font-medium px-5 py-[9px] rounded-md bg-navy text-white hover:bg-navy-deep disabled:opacity-50 transition"
            >
              {busy?.kind === 'add' ? 'Adding…' : 'Add'}
            </button>
          </div>

          {error && (
            <div className="bg-carnegie-red-soft border border-carnegie-red/40 text-carnegie-red rounded-md px-3 py-2 text-[12px]">
              {error}
            </div>
          )}

          {/* Tag search — filters live across every domain. The
              left-rail domain selection still applies, so an active
              search inside a single domain narrows further. */}
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags…"
              className="w-full bg-surface-card border border-line rounded-md pl-9 pr-9 py-[10px] text-[14px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy"
            />
            <span
              aria-hidden
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-quaternary text-[14px]"
            >
              ⌕
            </span>
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full text-text-quaternary hover:text-navy hover:bg-surface-page transition flex items-center justify-center"
              >
                ×
              </button>
            )}
          </div>

          {/* Tag table */}
          <div className="bg-surface-card border border-line rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_180px_80px_60px] items-center gap-3 px-[14px] py-[7px] bg-surface-page border-b border-line">
              <span className="typo-label">Tag</span>
              <span className="typo-label">Domain</span>
              <span className="typo-label">Usage</span>
              <span className="typo-label text-right">Delete</span>
            </div>
            {filteredRows.length === 0 ? (
              <div className="text-[12px] text-text-tertiary italic p-6 text-center">
                No tags in this domain yet.
              </div>
            ) : (
              filteredRows.map((row) => {
                const usage = usageByTag.get(row.tag) ?? 0;
                const canDelete = usage === 0 && !busy;
                const isConfirming =
                  confirm?.tag === row.tag && confirm.domain === row.domain;
                const isRenaming =
                  renaming?.from === row.tag && renaming.domain === row.domain;
                return (
                  <div
                    key={`${row.domain}:${row.tag}`}
                    className="group grid grid-cols-[1fr_180px_80px_60px] items-center gap-3 px-[14px] py-[8px] border-b border-line-light last:border-b-0 text-[13px]"
                  >
                    {isRenaming ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={renaming.draft}
                          autoFocus
                          onChange={(e) =>
                            setRenaming({ ...renaming, draft: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              onRenameTag(row.tag, renaming.draft, row.domain);
                            } else if (e.key === 'Escape') {
                              setRenaming(null);
                            }
                          }}
                          className="flex-1 min-w-0 bg-surface-card border border-navy/60 rounded px-2 py-1 text-[13px] text-text-primary focus:outline-none focus:border-navy"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            onRenameTag(row.tag, renaming.draft, row.domain)
                          }
                          disabled={!!busy}
                          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-navy text-white"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenaming(null)}
                          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-line text-text-tertiary"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-text-primary truncate">
                          {row.tag}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setRenaming({
                              domain: row.domain,
                              from: row.tag,
                              draft: row.tag,
                            })
                          }
                          aria-label={`Rename ${row.tag}`}
                          title="Rename"
                          className="opacity-0 group-hover:opacity-100 text-[11px] text-text-quaternary hover:text-navy transition px-1"
                        >
                          ✎
                        </button>
                      </div>
                    )}
                    <span className="text-[12px] text-text-tertiary truncate">
                      {row.domainLabel}
                    </span>
                    <span
                      className={`text-[12px] font-mono ${
                        usage === 0 ? 'text-text-quaternary' : 'text-text-secondary'
                      }`}
                    >
                      {usage}
                    </span>
                    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      {isConfirming ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onDeleteTag(row.tag, row.domain)}
                            className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-carnegie-red text-carnegie-red hover:bg-carnegie-red-soft transition"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirm(null)}
                            className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-line text-text-tertiary hover:bg-surface-page transition"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            canDelete && setConfirm({ tag: row.tag, domain: row.domain })
                          }
                          disabled={!canDelete}
                          aria-label={`Delete ${row.tag}`}
                          title={
                            usage > 0
                              ? `Used by ${usage} ${
                                  usage === 1 ? 'book' : 'books'
                                } — delete blocked.`
                              : 'Remove from vocabulary'
                          }
                          className="w-6 h-6 rounded text-[12px] font-semibold border border-line text-text-quaternary hover:border-carnegie-red hover:text-carnegie-red disabled:opacity-30 disabled:hover:border-line disabled:hover:text-text-quaternary disabled:cursor-not-allowed transition"
                        >
                          {busy?.kind === 'delete' && busy.tag === row.tag ? '…' : '✕'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Changelog (collapsible) */}
          <div className="bg-surface-card border border-line rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setChangelogOpen((v) => !v)}
              className="w-full flex items-center justify-between px-[14px] py-[10px] text-[13px] font-medium text-text-secondary hover:bg-surface-card-hover transition"
              aria-expanded={changelogOpen}
            >
              <span className="flex items-center gap-2">
                <span className="typo-label">Changelog</span>
                {parsedChangelog.length > 0 && (
                  <span className="text-[11px] text-text-tertiary">
                    {parsedChangelog.length}{' '}
                    {parsedChangelog.length === 1 ? 'entry' : 'entries'}
                  </span>
                )}
              </span>
              <span className="text-text-tertiary">{changelogOpen ? '▾' : '▸'}</span>
            </button>
            {changelogOpen && (
              <div className="border-t border-line-light px-[14px] py-[10px] space-y-1.5 max-h-[420px] overflow-y-auto">
                {parsedChangelog.length === 0 ? (
                  <div className="text-[12px] text-text-tertiary italic">
                    No changelog entries found.
                  </div>
                ) : (
                  parsedChangelog.map((e, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-baseline gap-2 text-[12px]"
                    >
                      <span className="font-mono text-[11px] text-text-tertiary w-[88px] flex-shrink-0">
                        {e.date}
                      </span>
                      <span className="text-text-primary font-medium">{e.tag}</span>
                      <span className="typo-label">{e.domain}</span>
                      {e.source && (
                        <span className="text-[11px] text-text-tertiary italic">
                          — {e.source}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function DomainPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  // Empty domains are de-emphasized but never hidden — the user must
  // always see the full 21-class taxonomy, not just the subset their
  // collection happens to fill. Lower opacity + smaller text + a
  // sentinel "—" count when zero.
  const isEmpty = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] transition border ${
        active
          ? 'bg-navy text-white border-navy font-medium'
          : `bg-surface-card text-text-secondary border-line ${isEmpty ? 'opacity-55' : ''}`
      }`}
    >
      <span className={isEmpty && !active ? 'text-[11px]' : ''}>{label}</span>
      <span
        className={`text-[10px] font-mono ${
          active ? 'text-white/75' : 'text-text-quaternary'
        }`}
      >
        {isEmpty ? '—' : count}
      </span>
    </button>
  );
}

function DomainRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  // Empty domains stay visible — clickable, with a "—" sentinel and
  // softened color treatment — so the user always sees the full
  // 21-class taxonomy. Clicking an empty domain reveals an empty
  // state on the right pane (rendered by the body, not here).
  const isEmpty = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between text-left px-3 py-[7px] text-[13px] transition ${
        active
          ? 'bg-navy-soft text-navy font-medium border-l-2 border-l-navy'
          : `text-text-secondary hover:bg-surface-card-hover border-l-2 border-l-transparent ${isEmpty ? 'opacity-55' : ''}`
      }`}
    >
      <span>{label}</span>
      <span
        className={`text-[11px] font-mono ${
          active ? 'text-navy' : 'text-text-quaternary'
        }`}
      >
        {isEmpty ? '—' : count}
      </span>
    </button>
  );
}

/**
 * Parse vocabulary-changelog.md into structured rows. The format is
 * roughly `## YYYY-MM-DD` headers followed by `- Added \`tag\` to **Domain**
 * — first seen on "Title" by Author` bullets. We tolerate the variants
 * the auto-promoter and the manual add path produce, and ignore lines we
 * can't parse rather than failing the whole panel.
 */
function parseChangelog(md: string): ChangelogEntry[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  let currentDate = '';
  const out: ChangelogEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const dateMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }
    if (!line.startsWith('-') || !currentDate) continue;
    // - Added `tag` to **Domain** — first seen on "Title" by Author
    // - Removed `tag` from **Domain**
    const m = line.match(
      /^-\s*(?:Added|Removed)\s+`([^`]+)`\s+(?:to|from)\s+\*\*([^*]+)\*\*\s*(?:—\s*(.*))?$/
    );
    if (!m) continue;
    out.push({
      date: currentDate,
      tag: m[1].trim(),
      domain: m[2].trim(),
      source: m[3]?.trim() || undefined,
    });
  }
  // Reverse chronological — most recent first.
  return out.reverse();
}
