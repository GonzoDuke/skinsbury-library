/**
 * Tag-correction feedback loop. When a user removes a tag the system
 * suggested or adds a tag the system missed, the correction is stored
 * locally and pushed to data/corrections-log.json on GitHub via
 * /api/corrections (same pattern as the export ledger).
 *
 * The 20 most recent corrections are appended to the tag-inference
 * system prompt as additional few-shot examples so the model learns
 * from editorial judgment over time.
 *
 * Corrections only fire for system *behavior* — removing a tag the
 * user previously added themselves, or re-adding a system tag the
 * user removed in a prior session, are no-ops.
 */

const CORRECTIONS_KEY = 'carnegie:corrections-log:v1';
const REMOTE_AVAILABLE_KEY = 'carnegie:corrections-log:remote-available:v1';

export interface CorrectionEntry {
  /** Display title at the time of correction. */
  title: string;
  /** Display author at the time of correction. */
  author: string;
  /** LCC at the time of correction (may be empty). */
  lcc: string;
  /** Snapshot of every tag (genre + form) the system suggested for this book. */
  systemSuggestedTags: string[];
  /** Set when the user removed a system-inferred tag (or domain). */
  removedTag?: string;
  /** Set when the user added a tag (or domain) the system didn't suggest. */
  addedTag?: string;
  /** ISO timestamp at correction time. */
  timestamp: string;
  /**
   * Which inference call this correction targets. 'tag' = call 2
   * (focused tag inference); 'domain' = call 1 (domain detection).
   * Default 'tag' when the field is missing — back-compat for entries
   * written before the two-step refactor.
   */
  kind?: 'tag' | 'domain';
  /**
   * Domain context at correction time. Only meaningful for kind='tag' —
   * lets the focused-call few-shot filter to corrections within the
   * same domain so unrelated tagging history doesn't dilute the prompt.
   * Empty for legacy records and for kind='domain'.
   */
  domain?: string;
}

export function loadCorrections(): CorrectionEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CORRECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCorrectionEntry);
  } catch {
    return [];
  }
}

function saveCorrections(entries: CorrectionEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CORRECTIONS_KEY, JSON.stringify(entries));
  } catch {
    // ignore quota errors — corrections are best-effort
  }
}

export function setCorrectionsCache(entries: CorrectionEntry[]): void {
  saveCorrections(entries);
}

function isCorrectionEntry(e: unknown): e is CorrectionEntry {
  if (!e || typeof e !== 'object') return false;
  const c = e as Partial<CorrectionEntry>;
  return (
    typeof c.title === 'string' &&
    typeof c.author === 'string' &&
    typeof c.lcc === 'string' &&
    Array.isArray(c.systemSuggestedTags) &&
    typeof c.timestamp === 'string' &&
    (typeof c.removedTag === 'string' || typeof c.addedTag === 'string')
  );
}

/**
 * Pure dedupe: same (title|author|removedTag|addedTag) tuple is a
 * single logical correction. The latest timestamp wins so re-adding
 * a tag after removing it overwrites the prior entry.
 */
export function mergeCorrectionAdditions(
  existing: CorrectionEntry[],
  additions: CorrectionEntry[]
): CorrectionEntry[] {
  const out = [...existing];
  for (const add of additions) {
    if (!isCorrectionEntry(add)) continue;
    const idx = out.findIndex((e) => correctionsMatch(e, add));
    if (idx >= 0) {
      if (add.timestamp >= out[idx].timestamp) out[idx] = add;
    } else {
      out.push(add);
    }
  }
  return out;
}

export function correctionsMatch(a: CorrectionEntry, b: CorrectionEntry): boolean {
  return (
    a.title === b.title &&
    a.author === b.author &&
    (a.removedTag ?? '') === (b.removedTag ?? '') &&
    (a.addedTag ?? '') === (b.addedTag ?? '')
  );
}

/**
 * Inverse of an existing correction. Used to cancel a correction when
 * the user undoes the same edit (re-adds a previously-removed tag, or
 * removes a previously-added one) so the log doesn't accumulate
 * contradictory entries.
 */
export function findInverse(
  entries: CorrectionEntry[],
  title: string,
  author: string,
  inverse: { removedTag?: string; addedTag?: string }
): number {
  return entries.findIndex(
    (e) =>
      e.title === title &&
      e.author === author &&
      (inverse.removedTag !== undefined
        ? e.addedTag === inverse.removedTag
        : e.removedTag === inverse.addedTag)
  );
}

interface RemoteCorrectionsResponse {
  available: boolean;
  entries?: CorrectionEntry[];
  sha?: string | null;
  commit?: { url?: string; sha?: string };
  error?: string;
}

export async function syncCorrectionsFromRepo(): Promise<CorrectionEntry[] | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch('/api/corrections', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as RemoteCorrectionsResponse;
    rememberRemoteAvailability(data.available);
    if (!data.available || !Array.isArray(data.entries)) return null;
    const local = loadCorrections();
    const merged = mergeCorrectionAdditions(data.entries, local);
    saveCorrections(merged);
    return merged;
  } catch {
    return null;
  }
}

export async function pushCorrectionDelta(
  delta: { add?: CorrectionEntry[]; remove?: CorrectionEntry[] }
): Promise<RemoteCorrectionsResponse> {
  if (typeof window === 'undefined') return { available: false };
  try {
    const res = await fetch('/api/corrections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delta),
    });
    const data = (await res.json().catch(() => ({}))) as RemoteCorrectionsResponse;
    if (res.status === 501) {
      rememberRemoteAvailability(false);
      return { available: false, error: data.error };
    }
    if (!res.ok) {
      return {
        available: data.available ?? true,
        error: data.error ?? `HTTP ${res.status}`,
      };
    }
    rememberRemoteAvailability(true);
    if (Array.isArray(data.entries)) saveCorrections(data.entries);
    return data;
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function rememberRemoteAvailability(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(REMOTE_AVAILABLE_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

/**
 * Append a correction to the local cache and fire-and-forget a push to
 * GitHub. If the user is undoing a prior correction (e.g. re-adding a
 * tag they previously removed), the prior entry is dropped from the
 * local cache and a `remove` is sent to the server too.
 */
export function logCorrection(input: {
  title: string;
  author: string;
  lcc: string;
  systemSuggestedTags: string[];
  removedTag?: string;
  addedTag?: string;
  /** Which inference call this correction targets. Defaults to 'tag'. */
  kind?: 'tag' | 'domain';
  /** Domain context for tag corrections. Empty for domain corrections. */
  domain?: string;
}): void {
  if (typeof window === 'undefined') return;
  if (!input.title.trim()) return;
  if (!input.removedTag && !input.addedTag) return;
  const entry: CorrectionEntry = {
    title: input.title,
    author: input.author,
    lcc: input.lcc,
    systemSuggestedTags: [...input.systemSuggestedTags],
    removedTag: input.removedTag,
    addedTag: input.addedTag,
    timestamp: new Date().toISOString(),
    kind: input.kind ?? 'tag',
    domain: input.domain,
  };

  const current = loadCorrections();

  // If the user is undoing a prior correction, drop it. Removing a
  // previously-added tag cancels the add; re-adding a previously-removed
  // tag cancels the remove. No new entry is logged in either case.
  const inverseIdx = findInverse(current, input.title, input.author, {
    removedTag: input.removedTag,
    addedTag: input.addedTag,
  });
  if (inverseIdx >= 0) {
    const removed = current[inverseIdx];
    const next = current.filter((_, i) => i !== inverseIdx);
    saveCorrections(next);
    void pushCorrectionDelta({ remove: [removed] });
    return;
  }

  const next = mergeCorrectionAdditions(current, [entry]);
  saveCorrections(next);
  void pushCorrectionDelta({ add: [entry] });
}

/**
 * The 20 most recent corrections, newest first. Fed to the inference
 * route in each request so the system prompt can include them as
 * few-shot examples.
 *
 * Pass `kind` to filter to a specific call's corrections — 'tag' for
 * call 2 (focused tag inference), 'domain' for call 1 (domain
 * detection). Pass `domain` alongside `kind: 'tag'` to further filter
 * to corrections within that domain only. Legacy entries without a
 * `kind` field default to 'tag'.
 */
export function recentCorrections(
  limit = 20,
  filter?: { kind?: 'tag' | 'domain'; domain?: string }
): CorrectionEntry[] {
  const entries = loadCorrections();
  let filtered = entries;
  if (filter?.kind) {
    filtered = filtered.filter((e) => (e.kind ?? 'tag') === filter.kind);
  }
  if (filter?.domain) {
    filtered = filtered.filter((e) => e.domain === filter.domain);
  }
  return [...filtered]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, limit);
}

export function clearCorrections(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(CORRECTIONS_KEY);
  } catch {
    // ignore
  }
}
