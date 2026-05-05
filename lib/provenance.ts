import type {
  BookRecord,
  BookRecordProvenance,
  FieldProvenance,
  SourceTag,
} from './types';

/**
 * The set of BookRecord fields we capture provenance for. Keep this in
 * sync with the spec's tracked-fields list. Anything not in this set
 * (status, batchLabel, notes, internal-state flags like rereading) is
 * intentionally provenance-free.
 */
export const PROVENANCE_FIELDS = [
  'title',
  'canonicalTitle',
  'author',
  'authorLF',
  'allAuthors',
  'isbn',
  'publisher',
  'publicationYear',
  'lcc',
  'ddc',
  'pageCount',
  'edition',
  'binding',
  'language',
  'synopsis',
  'lcshSubjects',
  'subjects',
  'coverUrl',
] as const;

export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

const PROVENANCE_FIELD_SET: Set<string> = new Set(PROVENANCE_FIELDS);

export function isProvenanceField(name: string): name is ProvenanceField {
  return PROVENANCE_FIELD_SET.has(name);
}

function nowIso(): string {
  return new Date().toISOString();
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

/**
 * Stamp a field's provenance, demoting the prior entry into the new
 * entry's `alternates` if the value actually changed. No-op when the
 * source + value match what's already there (idempotent re-stamps
 * don't grow the alternates list).
 */
export function setField(
  prov: BookRecordProvenance,
  field: ProvenanceField,
  source: SourceTag,
  value: unknown,
  timestamp?: string
): void {
  const ts = timestamp ?? nowIso();
  const prior = prov[field];
  if (prior && prior.source === source && valuesEqual(value, undefined)) {
    // Re-stamp from same source with no value change — refresh ts only.
    prov[field] = { ...prior, timestamp: ts };
    return;
  }
  if (prior && prior.source === source) {
    prov[field] = { ...prior, timestamp: ts };
    return;
  }
  if (!prior) {
    prov[field] = { source, timestamp: ts };
    return;
  }
  // New source replaces prior winner. Demote prior to alternates.
  const alternates = [...(prior.alternates ?? [])];
  alternates.push({ source: prior.source, value });
  prov[field] = { source, timestamp: ts, alternates };
}

/**
 * First-time tag for a field — never demotes an existing winner. Used
 * when stamping during initial result assembly where we want the FIRST
 * source for a field (Phase 1 winner) to stick rather than be replaced
 * by a same-tier re-tag.
 */
export function tagField(
  prov: BookRecordProvenance,
  field: ProvenanceField,
  source: SourceTag,
  timestamp?: string
): void {
  if (prov[field]) return;
  prov[field] = { source, timestamp: timestamp ?? nowIso() };
}

/**
 * Promote a field to "user-edit" provenance. The prior winner moves
 * into alternates carrying its prior value (so an audit trail captures
 * the database value the user overrode).
 */
export function userEditField(
  prov: BookRecordProvenance,
  field: ProvenanceField,
  priorValue: unknown,
  timestamp?: string
): void {
  const ts = timestamp ?? nowIso();
  const prior = prov[field];
  if (!prior) {
    prov[field] = { source: 'user-edit', timestamp: ts };
    return;
  }
  if (prior.source === 'user-edit') {
    prov[field] = { ...prior, timestamp: ts };
    return;
  }
  const alternates = [...(prior.alternates ?? [])];
  alternates.push({ source: prior.source, value: priorValue });
  prov[field] = { source: 'user-edit', timestamp: ts, alternates };
}

/**
 * Walk a patch about to be applied to a BookRecord and stamp every
 * tracked-field change as a user-edit. Centralizes user-edit
 * attribution at the store reducer so individual UI call sites don't
 * each have to plumb provenance.
 *
 * Returns the patch verbatim with `provenance` merged in. When the
 * patch contains no tracked-field changes, returns the patch
 * unchanged (no spurious provenance update).
 *
 * Callers pass `{ source: 'user-edit' }` by default. Internal-state
 * patches (rereading/retagging/status/etc.) are detected by the absence
 * of any tracked field — those bypass the provenance update.
 */
export function applyUserEditPatch(
  current: BookRecord,
  patch: Partial<BookRecord>,
  source: SourceTag = 'user-edit'
): Partial<BookRecord> {
  const ts = nowIso();
  let nextProv: BookRecordProvenance | undefined;
  for (const key of Object.keys(patch)) {
    if (!isProvenanceField(key)) continue;
    const newValue = (patch as Record<string, unknown>)[key];
    const oldValue = (current as unknown as Record<string, unknown>)[key];
    if (valuesEqual(newValue, oldValue)) continue;
    if (!nextProv) nextProv = { ...(current.provenance ?? {}) };
    if (source === 'user-edit') {
      userEditField(nextProv, key, oldValue, ts);
    } else {
      setField(nextProv, key, source, newValue, ts);
    }
  }
  if (!nextProv) return patch;
  return { ...patch, provenance: nextProv };
}

/**
 * Reread merge: a Reread runs the lookup pipeline again and produces a
 * fresh provenance map. The user's edits should be preserved across
 * the re-fetch — fields whose old provenance was `user-edit` keep both
 * their value and their `user-edit` source. Every other field takes
 * the new value + new source from the fresh lookup.
 *
 * Returns the merged record. Callers replace the old record entirely.
 */
export function mergeRereadProvenance(
  oldRecord: BookRecord,
  freshRecord: BookRecord
): BookRecord {
  const oldProv = oldRecord.provenance ?? {};
  const freshProv = freshRecord.provenance ?? {};
  const merged: BookRecordProvenance = { ...freshProv };
  const out: BookRecord = { ...freshRecord };
  for (const field of PROVENANCE_FIELDS) {
    const priorEntry = oldProv[field];
    if (priorEntry?.source === 'user-edit') {
      const oldValue = (oldRecord as unknown as Record<string, unknown>)[field];
      // Preserve the user-edited value and its provenance entry.
      (out as unknown as Record<string, unknown>)[field] = oldValue;
      merged[field] = priorEntry;
    }
  }
  out.provenance = merged;
  return out;
}

/**
 * Convenience: build a provenance map from a list of (field, source)
 * pairs at the same instant. Used at lookup-result assembly to bulk-
 * stamp the BookRecord's fields with the winning source.
 */
export function buildProvenance(
  pairs: Array<readonly [ProvenanceField, SourceTag]>
): BookRecordProvenance {
  const ts = nowIso();
  const prov: BookRecordProvenance = {};
  for (const [field, source] of pairs) {
    prov[field] = { source, timestamp: ts };
  }
  return prov;
}

// ---------------------------------------------------------------------------
// Dev assertions — run once at module load. Failures throw so a
// regression on the central provenance helpers fails loudly.
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  // setField — first-time tag, no demote. The `as SourceTag` casts on
  // the assertion reads break TS's literal-type narrowing across the
  // mutation calls — without them, TS deduces a single literal type
  // for `source` from the prior check and flags the next comparison
  // as unintentional even though setField has clearly mutated the map.
  const p1: BookRecordProvenance = {};
  setField(p1, 'title', 'openlibrary', 'The Hobbit', '2026-01-01T00:00:00Z');
  if ((p1.title?.source as SourceTag | undefined) !== 'openlibrary' || p1.title?.alternates) {
    throw new Error('provenance: setField first-time should not create alternates');
  }
  // setField — demote on overwrite.
  setField(p1, 'title', 'marc', 'The Hobbit', '2026-01-02T00:00:00Z');
  if (
    (p1.title?.source as SourceTag | undefined) !== 'marc' ||
    p1.title?.alternates?.length !== 1
  ) {
    throw new Error('provenance: setField overwrite must demote prior to alternates');
  }
  // userEditField — moves prior to alternates.
  const p2: BookRecordProvenance = {
    title: { source: 'openlibrary', timestamp: '2026-01-01T00:00:00Z' },
  };
  userEditField(p2, 'title', 'Old Title');
  if (p2.title?.source !== 'user-edit') {
    throw new Error('provenance: userEditField did not set source to user-edit');
  }
  if (p2.title?.alternates?.[0]?.source !== 'openlibrary') {
    throw new Error('provenance: userEditField did not preserve prior source in alternates');
  }
  // applyUserEditPatch — only stamps tracked-field changes.
  const dummyRecord = {
    id: 'x',
    title: 'Old',
    author: 'A',
    rereading: false,
    provenance: { title: { source: 'openlibrary' as SourceTag, timestamp: '2026-01-01T00:00:00Z' } },
  } as unknown as BookRecord;
  const internalOnly = applyUserEditPatch(dummyRecord, { rereading: true });
  if ('provenance' in internalOnly) {
    throw new Error('provenance: applyUserEditPatch added provenance to an internal-only patch');
  }
  const titleEdit = applyUserEditPatch(dummyRecord, { title: 'New' });
  if (!titleEdit.provenance || titleEdit.provenance.title?.source !== 'user-edit') {
    throw new Error('provenance: applyUserEditPatch did not stamp the title edit');
  }
  // mergeRereadProvenance — preserves user-edit fields from old.
  const oldR = {
    id: 'x',
    title: 'User Title',
    author: 'A',
    provenance: {
      title: { source: 'user-edit' as SourceTag, timestamp: '2026-01-02T00:00:00Z' },
      author: { source: 'openlibrary' as SourceTag, timestamp: '2026-01-01T00:00:00Z' },
    },
  } as unknown as BookRecord;
  const freshR = {
    id: 'x',
    title: 'Fresh Title',
    author: 'A',
    provenance: {
      title: { source: 'marc' as SourceTag, timestamp: '2026-02-01T00:00:00Z' },
      author: { source: 'marc' as SourceTag, timestamp: '2026-02-01T00:00:00Z' },
    },
  } as unknown as BookRecord;
  const merged = mergeRereadProvenance(oldR, freshR);
  if (merged.title !== 'User Title') {
    throw new Error('provenance: mergeRereadProvenance did not preserve user-edited title value');
  }
  if (merged.provenance?.title?.source !== 'user-edit') {
    throw new Error('provenance: mergeRereadProvenance did not preserve user-edit source');
  }
  if (merged.provenance?.author?.source !== 'marc') {
    throw new Error('provenance: mergeRereadProvenance did not adopt fresh provenance for non-user-edit fields');
  }
}
