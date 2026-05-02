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
import { loadLedger, syncLedgerFromRepo } from '@/lib/export-ledger';
import vocabSeed from '@/lib/tag-vocabulary.json';

interface VocabShape {
  domains: Record<
    DomainKey,
    { label: string; lcc_prefixes: string[]; tags: string[] }
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

const DOMAIN_KEYS: DomainKey[] = (Object.keys(VOCAB.domains) as DomainKey[]).filter(
  (k) => k !== '_unclassified'
);

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
  const [newTagDomain, setNewTagDomain] = useState<DomainKey>(DOMAIN_KEYS[0]);
  const [busy, setBusy] = useState<{ kind: 'add' | 'delete'; tag: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ tag: string; domain: DomainKey } | null>(
    null
  );

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

  /** Flat list of every tag in the current vocab, with its domain. */
  const allRows = useMemo(() => {
    const rows: { tag: string; domain: DomainKey; domainLabel: string }[] = [];
    for (const key of DOMAIN_KEYS) {
      const def = vocab.domains[key];
      if (!def) continue;
      for (const tag of def.tags) {
        rows.push({ tag, domain: key, domainLabel: def.label });
      }
    }
    rows.sort((a, b) =>
      a.domainLabel === b.domainLabel
        ? a.tag.localeCompare(b.tag)
        : a.domainLabel.localeCompare(b.domainLabel)
    );
    return rows;
  }, [vocab]);

  const filteredRows = useMemo(
    () =>
      selection === 'all' ? allRows : allRows.filter((r) => r.domain === selection),
    [allRows, selection]
  );

  /** Push the current `vocab` state to the GitHub Contents API. */
  async function commitVocab(
    nextVocab: VocabShape,
    changelogLine: string,
    commitMessage: string
  ): Promise<boolean> {
    setError(null);
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

  const parsedChangelog = useMemo(
    () => parseChangelog(changelogText),
    [changelogText]
  );

  return (
    <div className="space-y-4">
      <h1 className="typo-page-title">Vocabulary</h1>

      <div className="grid grid-cols-[180px_1fr] gap-6">
        {/* LEFT — domain rail */}
        <aside className="bg-surface-card dark:bg-ink-soft border border-line dark:border-[#2E2C29] rounded-lg overflow-hidden h-max">
          <DomainRow
            label="All"
            count={allRows.length}
            active={selection === 'all'}
            onClick={() => setSelection('all')}
          />
          <div className="border-t border-line-light dark:border-[#2E2C29]" />
          {DOMAIN_KEYS.map((k) => {
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
          <div className="bg-surface-card dark:bg-ink-soft border border-line dark:border-[#2E2C29] rounded-lg p-3 flex flex-wrap items-end gap-2">
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
                className="w-full bg-surface-card border border-line rounded-md px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-quaternary focus:outline-none focus:border-navy"
              />
            </div>
            <div className="min-w-[160px]">
              <label className="typo-label block mb-1">Domain</label>
              <select
                value={newTagDomain}
                onChange={(e) => setNewTagDomain(e.target.value as DomainKey)}
                className="w-full bg-surface-card border border-line rounded-md px-3 py-1.5 text-[13px] text-text-primary focus:outline-none focus:border-navy"
              >
                {DOMAIN_KEYS.map((k) => (
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
              className="text-[13px] font-medium px-4 py-1.5 rounded-md bg-navy text-white hover:bg-navy-deep disabled:opacity-50 transition"
            >
              {busy?.kind === 'add' ? 'Adding…' : 'Add'}
            </button>
          </div>

          {error && (
            <div className="bg-carnegie-red-soft border border-carnegie-red/40 text-carnegie-red rounded-md px-3 py-2 text-[12px]">
              {error}
            </div>
          )}

          {/* Tag table */}
          <div className="bg-surface-card dark:bg-ink-soft border border-line dark:border-[#2E2C29] rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_180px_80px_60px] items-center gap-3 px-[14px] py-[7px] bg-surface-page dark:bg-ink/40 border-b border-line dark:border-[#2E2C29]">
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
                return (
                  <div
                    key={`${row.domain}:${row.tag}`}
                    className="grid grid-cols-[1fr_180px_80px_60px] items-center gap-3 px-[14px] py-[8px] border-b border-line-light dark:border-[#2E2C29] last:border-b-0 text-[13px]"
                  >
                    <span className="text-text-primary truncate">{row.tag}</span>
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
          <div className="bg-surface-card dark:bg-ink-soft border border-line dark:border-[#2E2C29] rounded-lg overflow-hidden">
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
              <div className="border-t border-line-light dark:border-[#2E2C29] px-[14px] py-[10px] space-y-1.5 max-h-[420px] overflow-y-auto">
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between text-left px-3 py-[7px] text-[13px] transition ${
        active
          ? 'bg-navy-soft text-navy font-medium border-l-2 border-l-navy'
          : 'text-text-secondary hover:bg-surface-card-hover border-l-2 border-l-transparent'
      }`}
    >
      <span>{label}</span>
      <span
        className={`text-[11px] font-mono ${
          active ? 'text-navy' : 'text-text-quaternary'
        }`}
      >
        {count}
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
