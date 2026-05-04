'use client';

/**
 * Authority check tool. Surfaces inconsistent author-name formatting:
 * "Solnit, Rebecca" + "Solnit, R." + "Solnit, Rebecca J." all share
 * lastname+initial and almost certainly refer to one person, but
 * differ in the stored representation. The tool groups them and lets
 * the user pick a canonical form (rewrites all entries) or dismiss
 * the group.
 *
 * Same UX shape as the duplicates tool — detection helper produces
 * groups, page renders each as a card with action buttons, dismissals
 * persist to ledger or localStorage. "Pick canonical form" enters an
 * in-card picker mode (not modal) consistent with the duplicates tool.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  loadLedger,
  syncLedgerFromRepo,
  detectAuthorityIssues,
  applyAuthorityCanonical,
  dismissAuthorityGroup,
  softDismissAuthorityGroup,
  type AuthorityGroup,
  type AuthorityVariant,
  type LedgerEntry,
} from '@/lib/export-ledger';

export default function AuthorityPage() {
  const [hydrated, setHydrated] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    setLedger(loadLedger());
    setHydrated(true);
    void (async () => {
      const remote = await syncLedgerFromRepo();
      if (remote) setLedger(remote);
    })();
  }, []);

  const detection = useMemo(() => detectAuthorityIssues(ledger), [ledger]);
  const totalEntriesInvolved = useMemo(
    () => detection.groups.reduce((s, g) => s + g.totalEntries, 0),
    [detection.groups]
  );

  async function refreshLedger() {
    const next = (await syncLedgerFromRepo()) ?? loadLedger();
    setLedger(next);
  }

  async function handleAction<T>(
    label: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    if (busy) return null;
    setBusy(label);
    setErrMsg(null);
    try {
      const result = await fn();
      await refreshLedger();
      return result;
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <div className="h-10 bg-surface-card border border-line rounded-md animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/collection"
          className="text-[12px] text-text-tertiary hover:text-navy hover:underline"
        >
          ← Collection
        </Link>
        <h1 className="typo-page-title mt-1">Authority check</h1>
        <div className="text-[13px] text-text-secondary mt-0.5">
          {detection.groups.length === 0 ? (
            <>No author-name conflicts detected.</>
          ) : (
            <>
              {detection.groups.length}{' '}
              {detection.groups.length === 1 ? 'potential conflict' : 'potential conflicts'} ·{' '}
              {totalEntriesInvolved}{' '}
              {totalEntriesInvolved === 1 ? 'entry' : 'entries'} involved
            </>
          )}
        </div>
      </div>

      {errMsg && (
        <div className="bg-mahogany-soft border border-mahogany/30 text-mahogany text-[13px] rounded-md px-4 py-2.5">
          {errMsg}
        </div>
      )}

      {detection.groups.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="space-y-3">
            {detection.groups.map((group) => (
              <GroupCard
                key={group.matchKey}
                group={group}
                ledger={ledger}
                busy={busy}
                onApplyCanonical={(canonicalForm) =>
                  handleAction('canonical', () => {
                    const handles = group.variants.flatMap((v) => v.handles);
                    return applyAuthorityCanonical(
                      handles,
                      canonicalForm,
                      group.matchKey
                    );
                  })
                }
                onDismissDifferent={() =>
                  handleAction('different_people', () => {
                    const handles = group.variants.flatMap((v) => v.handles);
                    return dismissAuthorityGroup(handles);
                  })
                }
                onKeepSeparate={() => {
                  softDismissAuthorityGroup(group.matchKey);
                  setLedger((current) => [...current]);
                }}
              />
            ))}
          </div>

          {detection.truncated > 0 && (
            <div className="text-center text-[12px] text-text-tertiary pt-2">
              {detection.truncated} more{' '}
              {detection.truncated === 1 ? 'group' : 'groups'} not shown.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function GroupCard({
  group,
  ledger,
  busy,
  onApplyCanonical,
  onDismissDifferent,
  onKeepSeparate,
}: {
  group: AuthorityGroup;
  ledger: LedgerEntry[];
  busy: string | null;
  onApplyCanonical: (canonicalForm: string) => Promise<unknown>;
  onDismissDifferent: () => Promise<unknown>;
  onKeepSeparate: () => void;
}) {
  const [pickerMode, setPickerMode] = useState(false);
  const [pickedVariant, setPickedVariant] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const canonicalForm = customForm.trim() || pickedVariant || '';
  const canConfirm = canonicalForm.trim().length > 0;

  function toggleExpanded(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function confirmPick() {
    if (!canConfirm) return;
    await onApplyCanonical(canonicalForm.trim());
    setPickerMode(false);
    setPickedVariant(null);
    setCustomForm('');
  }

  return (
    <section className="bg-surface-card border border-line rounded-lg p-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary">
          {group.variants.length} variants of the same author
        </div>
        <div className="text-[12px] font-mono text-text-tertiary">
          {group.matchKeyDisplay}
        </div>
      </div>

      {/* Variant list */}
      <ul className="mt-3 divide-y divide-line-light border-t border-line-light">
        {group.variants.map((variant) => (
          <VariantRow
            key={variant.name}
            variant={variant}
            ledger={ledger}
            pickerMode={pickerMode}
            picked={pickedVariant === variant.name}
            onPick={() => {
              setPickedVariant(variant.name);
              setCustomForm('');
            }}
            expanded={expanded.has(variant.name)}
            onToggleExpanded={() => toggleExpanded(variant.name)}
          />
        ))}
      </ul>

      {/* Custom-form input — only in picker mode */}
      {pickerMode && (
        <div className="mt-3">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-text-tertiary mb-1">
              Or type a different canonical form
            </span>
            <input
              type="text"
              value={customForm}
              onChange={(e) => {
                setCustomForm(e.target.value);
                if (e.target.value.trim()) setPickedVariant(null);
              }}
              placeholder="Last, First Middle"
              className="w-full px-3 py-2 text-[13px] bg-surface-page rounded-md border border-line focus:outline-none focus:border-navy focus:ring-1 focus:ring-navy transition"
            />
          </label>
        </div>
      )}

      {/* Actions */}
      {!pickerMode ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <ActionButton
            variant="primary"
            onClick={() => setPickerMode(true)}
            disabled={!!busy}
          >
            Pick canonical form
          </ActionButton>
          <ActionButton
            variant="secondary"
            onClick={onDismissDifferent}
            disabled={!!busy}
          >
            {busy === 'different_people' ? 'Dismissing…' : 'Mark as different people'}
          </ActionButton>
          <ActionButton
            variant="ghost"
            onClick={onKeepSeparate}
            disabled={!!busy}
          >
            Keep all separate (decide later)
          </ActionButton>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <ActionButton
            variant="primary"
            onClick={() => void confirmPick()}
            disabled={!canConfirm || !!busy}
          >
            {busy === 'canonical' ? 'Applying…' : 'Confirm canonical form'}
          </ActionButton>
          <ActionButton
            variant="ghost"
            onClick={() => {
              setPickerMode(false);
              setPickedVariant(null);
              setCustomForm('');
            }}
            disabled={!!busy}
          >
            Cancel
          </ActionButton>
        </div>
      )}
    </section>
  );
}

function VariantRow({
  variant,
  ledger,
  pickerMode,
  picked,
  onPick,
  expanded,
  onToggleExpanded,
}: {
  variant: AuthorityVariant;
  ledger: LedgerEntry[];
  pickerMode: boolean;
  picked: boolean;
  onPick: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  // Find the actual book titles for this variant — match handles back
  // to ledger entries. Capped at 5 displayed rows so the page stays
  // scannable; "+N more" if there are more.
  const titles = useMemo(() => {
    const matched = ledger.filter((e) =>
      variant.handles.some(
        (h) =>
          h.isbn === e.isbn &&
          h.titleNorm === e.titleNorm &&
          h.authorNorm === e.authorNorm &&
          h.date === e.date &&
          (h.batchLabel ?? null) === (e.batchLabel ?? null)
      )
    );
    return matched.map((e) => ({
      title: e.title ?? e.titleNorm,
      year: e.publicationYear,
    }));
  }, [variant.handles, ledger]);

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3 text-[13px]">
        {pickerMode && (
          <input
            type="radio"
            checked={picked}
            onChange={onPick}
            aria-label={`Pick "${variant.name}" as canonical`}
            className="flex-shrink-0"
          />
        )}
        <span className="flex-1 min-w-0 truncate">
          <span className="text-text-primary">{variant.name}</span>
        </span>
        <span className="text-[11px] font-mono text-text-tertiary flex-shrink-0">
          {variant.entryCount} {variant.entryCount === 1 ? 'book' : 'books'}
        </span>
        <button
          type="button"
          onClick={onToggleExpanded}
          className="text-[11px] text-text-tertiary hover:text-navy hover:underline flex-shrink-0"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse book list' : 'Expand book list'}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expanded && (
        <ul className="mt-2 ml-6 text-[12px] text-text-secondary space-y-0.5">
          {titles.slice(0, 5).map((t, i) => (
            <li key={i} className="truncate">
              · {t.title}
              {t.year ? <span className="text-text-tertiary"> ({t.year})</span> : null}
            </li>
          ))}
          {titles.length > 5 && (
            <li className="text-text-tertiary">
              + {titles.length - 5} more
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function ActionButton({
  variant,
  children,
  onClick,
  disabled,
}: {
  variant: 'primary' | 'secondary' | 'ghost';
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const base =
    'px-3 py-1.5 text-[12px] rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed';
  const cls =
    variant === 'primary'
      ? 'bg-navy text-white hover:bg-navy-deep font-medium'
      : variant === 'secondary'
        ? 'bg-surface-page border border-line text-text-secondary hover:bg-surface-card'
        : 'text-text-tertiary hover:text-text-primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${cls}`}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="bg-surface-card border border-line rounded-lg p-6 text-center">
      <div className="text-text-secondary text-[14px]">
        No author name conflicts detected. Your library&apos;s authority is clean.
      </div>
      <details className="mt-4 text-left max-w-md mx-auto">
        <summary className="text-[12px] text-text-tertiary cursor-pointer hover:text-text-primary">
          How this works
        </summary>
        <div className="text-[12px] text-text-tertiary mt-2 leading-relaxed">
          The tool groups ledger entries by author last name + first
          initial, then surfaces any group whose stored author strings
          differ. <em>Solnit, Rebecca</em> + <em>Solnit, R.</em> +{' '}
          <em>Solnit, Rebecca J.</em> all share <code>solnit|r</code>{' '}
          and almost certainly refer to one person — the tool lets you
          pick a canonical form to standardize them. Multi-author
          entries are split on semicolon so each individual author
          contributes independently.
        </div>
      </details>
      <div className="mt-4">
        <Link
          href="/collection"
          className="inline-block px-4 py-2 rounded-md bg-surface-page border border-line text-text-secondary hover:bg-surface-card transition text-[12px]"
        >
          ← Back to Collection
        </Link>
      </div>
    </div>
  );
}
