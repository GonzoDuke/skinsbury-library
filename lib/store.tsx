'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import type { BookRecord, PhotoBatch } from './types';
import {
  buildBookFromCrop,
  cropSpine,
  flagDuplicates,
  detectSpines,
  loadImage,
  makeId,
  rereadBook as runReread,
  retagBook as runRetag,
  type RereadOptions,
} from './pipeline';
import { toTitleCase } from './csv-export';
import { flagIfPreviouslyExported, loadLedger, syncLedgerFromRepo } from './export-ledger';
import { syncCorrectionsFromRepo } from './corrections-log';
import {
  deletePendingBatchFromRepo,
  pushBatchToRepo,
  syncPendingBatchesFromRepo,
} from './pending-batches';

// ---------------------------------------------------------------------------
// sanitizeBook — defensive coercion for any BookRecord that flows in from
// persistence (localStorage hydration) or the cross-device sync. Both paths
// go through the same helper so a corrupt persisted record (an object on
// `warnings`, a non-string tag, etc.) can't reach JSX as a non-primitive
// and trigger the production "Objects are not valid as a React child"
// #418 / #438 crashes.
// ---------------------------------------------------------------------------

const toStringSafe = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : v == null
      ? ''
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : (() => {
            try {
              return JSON.stringify(v);
            } catch {
              return '';
            }
          })();

const toStringArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(toStringSafe).filter((s) => s.length > 0) : [];

const toIntSafe = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

const VALID_CONFIDENCE = new Set(['HIGH', 'MEDIUM', 'LOW']);

function sanitizeBook<
  T extends Partial<BookRecord> & { title?: string; original?: { title?: string } }
>(book: T): BookRecord {
  const conf = VALID_CONFIDENCE.has(toStringSafe(book.confidence) as 'HIGH')
    ? (book.confidence as 'HIGH' | 'MEDIUM' | 'LOW')
    : 'LOW';
  return {
    ...(book as BookRecord),
    title: book.title ? toTitleCase(toStringSafe(book.title)) : '',
    author: toStringSafe(book.author),
    authorLF: toStringSafe(book.authorLF),
    isbn: toStringSafe(book.isbn),
    publisher: toStringSafe(book.publisher),
    publicationYear: toIntSafe(book.publicationYear),
    lcc: toStringSafe(book.lcc),
    reasoning: toStringSafe(book.reasoning),
    sourcePhoto: toStringSafe(book.sourcePhoto),
    batchLabel: book.batchLabel == null ? undefined : toStringSafe(book.batchLabel),
    batchNotes: book.batchNotes == null ? undefined : toStringSafe(book.batchNotes),
    notes: book.notes == null ? undefined : toStringSafe(book.notes),
    coverUrl: book.coverUrl == null ? undefined : toStringSafe(book.coverUrl),
    spineThumbnail:
      book.spineThumbnail == null ? undefined : toStringSafe(book.spineThumbnail),
    ddc: book.ddc == null ? undefined : toStringSafe(book.ddc),
    confidence: conf,
    status:
      book.status === 'approved' || book.status === 'rejected' || book.status === 'pending'
        ? book.status
        : 'pending',
    warnings: toStringArr(book.warnings),
    genreTags: toStringArr(book.genreTags),
    formTags: toStringArr(book.formTags),
    duplicateOf: Array.isArray(book.duplicateOf)
      ? book.duplicateOf.map(toIntSafe).filter((n) => n > 0)
      : undefined,
    original: book.original
      ? {
          ...book.original,
          title: book.original.title
            ? toTitleCase(toStringSafe(book.original.title))
            : '',
        }
      : ({} as BookRecord['original']),
  };
}

function sanitizeBatch(b: Partial<PhotoBatch>): PhotoBatch {
  return {
    ...(b as PhotoBatch),
    status:
      b.status === 'processing' || b.status === 'queued'
        ? ('done' as const)
        : (b.status ?? 'done'),
    books: Array.isArray(b.books) ? b.books.map(sanitizeBook) : [],
  };
}

/**
 * Build a stub BookRecord representing a spine whose pipeline call
 * exceeded the 45s wall-clock cap in processQueue's worker loop. The
 * record is LOW confidence with a single warning so the user can
 * trigger Reread. Spine thumbnail is preserved so they can still see
 * which spine it was; everything else is empty.
 */
function makeTimeoutStubBook(args: {
  position: number;
  bbox: { x: number; y: number; width: number; height: number };
  spineThumbnail: string;
  sourcePhoto: string;
  batchLabel?: string;
  batchNotes?: string;
}): BookRecord {
  return {
    id: makeId(),
    spineRead: {
      position: args.position,
      bbox: args.bbox,
      rawText: '',
      confidence: 'LOW',
    },
    title: '',
    author: '',
    authorLF: '',
    isbn: '',
    publisher: '',
    publicationYear: 0,
    lcc: '',
    genreTags: [],
    formTags: [],
    confidence: 'LOW',
    reasoning: '',
    status: 'pending',
    warnings: ['Pipeline timeout — try rereading'],
    sourcePhoto: args.sourcePhoto,
    batchLabel: args.batchLabel,
    batchNotes: args.batchNotes,
    lookupSource: 'none',
    lccSource: 'none',
    spineThumbnail: args.spineThumbnail,
    original: {
      title: '',
      author: '',
      isbn: '',
      publisher: '',
      publicationYear: 0,
      lcc: '',
      genreTags: [],
      formTags: [],
    },
  };
}

export interface ProcessingState {
  /** True from "process all" click until the loop returns. */
  isActive: boolean;
  photoDone: number;
  photoTotal: number;
  bookDone: number;
  bookTotal: number;
  currentLabel: string;
  /** Set when the loop finishes — UI can show a "view results" CTA. */
  finishedAt?: number;
}

type Action =
  | { type: 'ADD_BATCH'; batch: PhotoBatch }
  | { type: 'UPDATE_BATCH'; id: string; patch: Partial<PhotoBatch> }
  | { type: 'REMOVE_BATCH'; id: string }
  | { type: 'ADD_BOOK'; batchId: string; book: BookRecord }
  | { type: 'UPDATE_BOOK'; id: string; patch: Partial<BookRecord> }
  | { type: 'REMOVE_BOOKS'; ids: string[] }
  | { type: 'MERGE_DUPLICATES'; winnerId: string; loserIds: string[] }
  | { type: 'UNMERGE_BOOK'; id: string }
  | { type: 'KEEP_BOTH_DUPLICATES'; groupId: string }
  | { type: 'ADD_COPY'; sourceId: string }
  | { type: 'SET_PROCESSING'; processing: ProcessingState | null }
  | { type: 'PATCH_PROCESSING'; patch: Partial<ProcessingState> }
  | { type: 'HYDRATE'; batches: PhotoBatch[]; allBooks: BookRecord[] }
  | { type: 'CLEAR' };

interface State {
  batches: PhotoBatch[];
  allBooks: BookRecord[];
  /** Processing state lives in the global store so it survives navigation. */
  processing: ProcessingState | null;
}

const initialState: State = { batches: [], allBooks: [], processing: null };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ADD_BATCH': {
      // Most callers (PhotoUploader → enqueue) push a batch with no books
      // and rely on ADD_BOOK during processQueue to populate both lists.
      // The cross-device sync path adds a pre-populated batch in one shot,
      // so union those books into allBooks here without duplicating any
      // that already exist (de-dupes by id).
      const existingBookIds = new Set(state.allBooks.map((b) => b.id));
      const newBooks = (action.batch.books ?? []).filter(
        (b) => !existingBookIds.has(b.id)
      );
      return {
        ...state,
        batches: [...state.batches, action.batch],
        allBooks: newBooks.length > 0 ? [...state.allBooks, ...newBooks] : state.allBooks,
      };
    }
    case 'UPDATE_BATCH':
      return {
        ...state,
        batches: state.batches.map((b) =>
          b.id === action.id ? { ...b, ...action.patch } : b
        ),
      };
    case 'REMOVE_BATCH': {
      const batch = state.batches.find((b) => b.id === action.id);
      const removedIds = new Set(batch?.books.map((b) => b.id));
      return {
        ...state,
        batches: state.batches.filter((b) => b.id !== action.id),
        allBooks: state.allBooks.filter((b) => !removedIds.has(b.id)),
      };
    }
    case 'ADD_BOOK':
      return {
        ...state,
        batches: state.batches.map((b) =>
          b.id === action.batchId
            ? {
                ...b,
                books: [...b.books, action.book],
                booksIdentified: b.booksIdentified + 1,
              }
            : b
        ),
        allBooks: [...state.allBooks, action.book],
      };
    case 'UPDATE_BOOK':
      return {
        ...state,
        batches: state.batches.map((b) => ({
          ...b,
          books: b.books.map((bk) =>
            bk.id === action.id ? { ...bk, ...action.patch } : bk
          ),
        })),
        allBooks: state.allBooks.map((bk) =>
          bk.id === action.id ? { ...bk, ...action.patch } : bk
        ),
      };
    case 'REMOVE_BOOKS': {
      // Bulk hard-removal — drops the named books from every batch
      // and from allBooks, with no Unmerge snapshot retained. Used by
      // the Review-mount ISBN dedup pass and any future cleanup path
      // that wants permanent removal rather than merge.
      if (action.ids.length === 0) return state;
      const idSet = new Set(action.ids);
      return {
        ...state,
        batches: state.batches.map((b) => {
          const filtered = b.books.filter((bk) => !idSet.has(bk.id));
          if (filtered.length === b.books.length) return b;
          return {
            ...b,
            books: filtered,
            booksIdentified: filtered.length,
          };
        }),
        allBooks: state.allBooks.filter((bk) => !idSet.has(bk.id)),
      };
    }
    case 'MERGE_DUPLICATES': {
      // Locate the surviving record + the snapshots we need to fold into it.
      const winner = state.allBooks.find((b) => b.id === action.winnerId);
      const losers = state.allBooks.filter((b) => action.loserIds.includes(b.id));
      if (!winner || losers.length === 0) return state;
      const winnerPatch: Partial<BookRecord> = {
        // Snapshots of the losers — kept so Unmerge can restore them later.
        // We strip the heavy data URIs (spine thumbnails, OCR crops) so the
        // merged record stays small enough for localStorage.
        mergedFrom: [
          ...(winner.mergedFrom ?? []),
          ...losers.map((l) => ({ ...l, ocrImage: undefined })),
        ],
        duplicateResolved: 'merged' as const,
        duplicateGroup: undefined,
        duplicateOf: undefined,
        warnings: winner.warnings.filter((w) => !/^possible duplicate\b/i.test(w)),
      };
      const loserIdSet = new Set(action.loserIds);
      return {
        ...state,
        batches: state.batches.map((b) => ({
          ...b,
          books: b.books
            .filter((bk) => !loserIdSet.has(bk.id))
            .map((bk) => (bk.id === action.winnerId ? { ...bk, ...winnerPatch } : bk)),
        })),
        allBooks: state.allBooks
          .filter((bk) => !loserIdSet.has(bk.id))
          .map((bk) => (bk.id === action.winnerId ? { ...bk, ...winnerPatch } : bk)),
      };
    }
    case 'UNMERGE_BOOK': {
      const winner = state.allBooks.find((b) => b.id === action.id);
      if (!winner || !winner.mergedFrom || winner.mergedFrom.length === 0) return state;
      // Re-flag everyone in the restored group as a duplicate again so the
      // user can reconsider. New groupId — the old one was discarded at merge.
      const groupId = `dup-${Math.random().toString(36).slice(2, 10)}`;
      const restoredCount = winner.mergedFrom.length + 1;
      const positions = [
        winner.spineRead.position,
        ...winner.mergedFrom.map((m) => m.spineRead.position),
      ].sort((a, b) => a - b);
      const positionsLabel = positions.map((p) => `#${p}`).join(' and ');
      const warning = `Possible duplicate — same title found at spine ${positionsLabel}. Merge or keep both?`;
      const reFlag = (b: BookRecord): BookRecord => ({
        ...b,
        duplicateGroup: groupId,
        duplicateOf: positions.filter((p) => p !== b.spineRead.position),
        duplicateResolved: undefined,
        warnings: [
          ...b.warnings.filter((w) => !/^possible duplicate\b/i.test(w)),
          warning,
        ],
      });
      const restoredWinner = reFlag({
        ...winner,
        mergedFrom: undefined,
      });
      const restoredSiblings = winner.mergedFrom.map(reFlag);

      // Find the batch the winner lives in — siblings rejoin the same one.
      const winnerBatchId = state.batches.find((b) =>
        b.books.some((bk) => bk.id === winner.id)
      )?.id;
      void restoredCount;

      return {
        ...state,
        batches: state.batches.map((b) => {
          if (b.id !== winnerBatchId) return b;
          const otherBooks = b.books.filter((bk) => bk.id !== winner.id);
          // Re-insert in spine-position order so the queue reads naturally.
          const next = [...otherBooks, restoredWinner, ...restoredSiblings].sort(
            (x, y) => x.spineRead.position - y.spineRead.position
          );
          return { ...b, books: next };
        }),
        allBooks: [
          ...state.allBooks.filter((bk) => bk.id !== winner.id),
          restoredWinner,
          ...restoredSiblings,
        ],
      };
    }
    case 'KEEP_BOTH_DUPLICATES': {
      const stripDupWarnings = (warnings: string[]) =>
        warnings.filter((w) => !/^possible duplicate\b/i.test(w));
      const patch = (bk: BookRecord): BookRecord =>
        bk.duplicateGroup === action.groupId
          ? {
              ...bk,
              duplicateResolved: 'kept-both',
              warnings: stripDupWarnings(bk.warnings),
            }
          : bk;
      return {
        ...state,
        batches: state.batches.map((b) => ({ ...b, books: b.books.map(patch) })),
        allBooks: state.allBooks.map(patch),
      };
    }
    case 'ADD_COPY': {
      // Manually clone a record into an independent second copy. Use case:
      // user owns multiple physical copies of the same title (paperback +
      // hardcover, gift + personal, two prints) and the dedup flow either
      // never separated them or already collapsed them in a prior session.
      // The new record carries a fresh id, resets status to pending, and
      // gets a "Copy N" prefix on its notes so it's distinguishable in the
      // Review queue and the LT export.
      const source = state.allBooks.find((b) => b.id === action.sourceId);
      if (!source) return state;
      const sourceBatch = state.batches.find((b) =>
        b.books.some((bk) => bk.id === source.id)
      );
      if (!sourceBatch) return state;
      // Number copies by counting existing books that share the same source
      // photo + spine position (the original counts as #1, so the new copy
      // starts at #2 and increments cleanly across repeated clicks).
      const lineage = state.allBooks.filter(
        (b) =>
          b.sourcePhoto === source.sourcePhoto &&
          b.spineRead.position === source.spineRead.position
      );
      const copyNumber = lineage.length + 1;
      const copyNote = `Copy ${copyNumber}.`;
      const mergedNote = source.notes
        ? `${copyNote} ${source.notes}`
        : copyNote;
      const copy: BookRecord = {
        ...source,
        id: makeId(),
        status: 'pending',
        notes: mergedNote,
        duplicateGroup: undefined,
        duplicateOf: undefined,
        duplicateResolved: undefined,
        mergedFrom: undefined,
        previouslyExported: undefined,
        warnings: source.warnings.filter(
          (w) => !/^possible duplicate\b/i.test(w)
        ),
      };
      return {
        ...state,
        batches: state.batches.map((b) => {
          if (b.id !== sourceBatch.id) return b;
          // Insert the copy right after its source so the two cards sit
          // adjacent in the Review queue.
          const next: BookRecord[] = [];
          for (const bk of b.books) {
            next.push(bk);
            if (bk.id === source.id) next.push(copy);
          }
          return { ...b, books: next, booksIdentified: next.length };
        }),
        allBooks: [...state.allBooks, copy],
      };
    }
    case 'SET_PROCESSING':
      return { ...state, processing: action.processing };
    case 'PATCH_PROCESSING':
      return state.processing
        ? { ...state, processing: { ...state.processing, ...action.patch } }
        : state;
    case 'HYDRATE':
      // Replace state with whatever was loaded from localStorage on mount.
      // Processing state is intentionally not restored — Files don't
      // survive a page reload, so any in-flight work is unrecoverable.
      return {
        ...state,
        batches: action.batches,
        allBooks: action.allBooks,
        processing: null,
      };
    case 'CLEAR':
      return initialState;
  }
}

interface StoreApi {
  state: State;
  addBatch: (batch: PhotoBatch) => void;
  updateBatch: (id: string, patch: Partial<PhotoBatch>) => void;
  removeBatch: (id: string) => void;
  addBook: (batchId: string, book: BookRecord) => void;
  updateBook: (id: string, patch: Partial<BookRecord>) => void;
  /** Hard-remove the named books from every batch + allBooks. No
   *  Unmerge snapshot retained — use mergeDuplicates for that. */
  removeBooks: (ids: string[]) => void;
  clear: () => void;

  /** Register a File against a queued batch so the orchestrator can read it later. */
  setPendingFile: (batchId: string, file: File) => void;
  removePendingFile: (batchId: string) => void;
  hasPendingFile: (batchId: string) => boolean;
  /** Look up the source File for a batch — used by "Add missing book" Path A. Null after a hard reload. */
  getPendingFile: (batchId: string) => File | null;

  /** Run detect → read → lookup → ground → dedup over every queued batch. */
  processQueue: () => Promise<void>;

  /** Re-run the per-book pipeline. Optional hint skips Pass B and uses the typed title/author. */
  rereadBook: (id: string, options: RereadOptions) => Promise<{ ok: boolean; error?: string }>;

  /** Re-run tag inference on a batch of books in parallel. Preserves user-edited tags via merge. */
  bulkRetag: (ids: string[]) => Promise<{ done: number; errors: number }>;

  /** Fold the named loser books into `winnerId`. Original entries are stashed
   *  on the winner as `mergedFrom` so the user can Unmerge later. */
  mergeDuplicates: (winnerId: string, loserIds: string[]) => void;
  /** Restore the books stashed on this record's `mergedFrom`. Re-flags the
   *  group as a pending duplicate so the user can reconsider. */
  unmergeBook: (id: string) => void;
  /** Mark every book in this duplicate group as legitimately separate copies. */
  keepBothDuplicates: (groupId: string) => void;
  /** Clone the named book into an independent second copy with a fresh id
   *  and a "Copy N" notes prefix. Used when the user owns multiple physical
   *  copies of the same title that the dedup flow collapsed or never split. */
  addCopy: (sourceId: string) => void;
}

const StoreCtx = createContext<StoreApi | null>(null);

const STORAGE_KEY = 'carnegie:state:v1';

export function StoreProvider({ children }: { children: React.ReactNode }) {
  // Always init with empty state so SSR and the first client render produce
  // the same HTML — React 19 throws hydration errors on any mismatch. The
  // localStorage data is layered in via a HYDRATE dispatch in the effect
  // below, after mount.
  const [state, dispatch] = useReducer(reducer, initialState);

  // Track whether we've consulted localStorage yet. Two reasons:
  //   1. We don't want to overwrite the saved cache with empty initial state
  //      before hydration runs (the persist effect would wipe it on first
  //      paint otherwise).
  //   2. Consumers can show a brief loading placeholder if they prefer not
  //      to flash empty state for a frame.
  const hasHydrated = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (hasHydrated.current) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<State>;
        const batches = (parsed.batches ?? []).map(sanitizeBatch);
        const allBooks = Array.isArray(parsed.allBooks)
          ? parsed.allBooks.map(sanitizeBook)
          : [];
        dispatch({ type: 'HYDRATE', batches, allBooks });
      }
    } catch {
      // ignore — corrupt cache, fall through with empty initial state
    } finally {
      hasHydrated.current = true;
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Don't write until we've hydrated, otherwise the empty-state first
    // render would clobber the saved cache before the HYDRATE dispatch
    // could load it.
    if (!hasHydrated.current) return;
    try {
      // Don't persist large data URIs (batch thumbnail, spine thumbnails,
      // OCR crops) or processing state. Snapshots stashed on `mergedFrom`
      // get the same treatment so a single merged book can't blow the quota.
      const slimBook = (bk: BookRecord): BookRecord => ({
        ...bk,
        spineThumbnail: '',
        ocrImage: undefined,
        mergedFrom: bk.mergedFrom?.map((m) => ({ ...m, spineThumbnail: '', ocrImage: undefined })),
      });
      const slim = {
        batches: state.batches.map((b) => ({
          ...b,
          thumbnail: '',
          books: b.books.map(slimBook),
        })),
        allBooks: state.allBooks.map(slimBook),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // ignore quota errors
    }
  }, [state.batches, state.allBooks]);

  // Debounced post-mutation sync. Watches state.batches and pushes any
  // batch whose books-array reference changed since the last seen
  // value to GitHub via pushBatchToRepo. The reducer creates new array
  // refs on every UPDATE_BOOK / MERGE_DUPLICATES / etc., so reference
  // inequality is sufficient and cheap — no deep equality needed.
  //
  // 2-second per-batch debounce: rapid edits (typing in a field) collapse
  // into a single push after the user stops, but the timer is keyed by
  // batchId so editing batch A doesn't reset batch B's timer.
  //
  // Gates (matching the per-creation push sites' implicit assumptions):
  //   1. !hasHydrated.current — same gate the persist effect uses; never
  //      push localStorage state back to GitHub on mount.
  //   2. status === 'processing' — processQueue owns the push for batches
  //      it's actively working on; we must not race it with stale snapshots.
  //   3. books.length === 0 — empty batches get cleaned up elsewhere
  //      (handleScannerClose drops empty scan batches); pushing them is
  //      noise.
  //
  // Concurrent-edit semantics: this is "newest state wins" — pushing the
  // current device's state will overwrite the remote copy. For Carnegie's
  // single-user/two-device pattern this is acceptable and intended.
  const syncTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastSyncedBooksRef = useRef<Map<string, BookRecord[]>>(new Map());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const seen = lastSyncedBooksRef.current;
    const timeouts = syncTimeoutsRef.current;
    const liveIds = new Set<string>();

    for (const batch of state.batches) {
      liveIds.add(batch.id);
      const prev = seen.get(batch.id);
      // Update last-seen unconditionally so the next run compares
      // against the current reference, even when we skip the push.
      seen.set(batch.id, batch.books);
      if (prev === batch.books) continue;
      if (!hasHydrated.current) continue;
      if (batch.status === 'processing') continue;
      if (batch.books.length === 0) continue;

      // Reset any pending timer for this batch — only the freshest
      // snapshot (after debounce settles) gets pushed.
      const existing = timeouts.get(batch.id);
      if (existing) clearTimeout(existing);

      const t = setTimeout(() => {
        timeouts.delete(batch.id);
        const current = stateRef.current.batches.find((b) => b.id === batch.id);
        if (!current) return;
        if (current.status === 'processing') return;
        if (current.books.length === 0) return;
        pushBatchToRepo(current).catch(() => {});
      }, 2000);
      timeouts.set(batch.id, t);
    }

    // Drop tracking for batches that have been removed since the last
    // run, and clear any pending timeout for them.
    for (const id of Array.from(seen.keys())) {
      if (!liveIds.has(id)) {
        seen.delete(id);
        const t = timeouts.get(id);
        if (t) {
          clearTimeout(t);
          timeouts.delete(id);
        }
      }
    }
  }, [state.batches]);

  // Unmount cleanup — prevents stray pushes after the provider tears down.
  useEffect(() => {
    const timeouts = syncTimeoutsRef.current;
    return () => {
      for (const t of timeouts.values()) clearTimeout(t);
      timeouts.clear();
    };
  }, []);

  // Pull the authoritative ledger from the repo on app load so duplicate
  // detection is consistent across devices. syncLedgerFromRepo updates the
  // localStorage cache that loadLedger() reads at processing time. When the
  // remote isn't available (no GITHUB_TOKEN configured), this is a no-op
  // and we keep using whatever's in the local cache.
  //
  // In parallel, pull any pending batches that were processed on another
  // device (typically a phone capture) so they appear in /review here.
  useEffect(() => {
    syncLedgerFromRepo().catch(() => {});
    // Pull the latest tag-correction log so this session's inference
    // calls can include corrections made on other devices as few-shot
    // examples. No-op when GITHUB_TOKEN isn't configured.
    syncCorrectionsFromRepo().catch(() => {});
    syncPendingBatchesFromRepo()
      .then((remoteBatches) => {
        if (!remoteBatches || remoteBatches.length === 0) return;
        const existingIds = new Set(stateRef.current.batches.map((b) => b.id));
        for (const raw of remoteBatches) {
          if (existingIds.has(raw.id)) continue;
          dispatch({ type: 'ADD_BATCH', batch: sanitizeBatch(raw) });
        }
      })
      .catch(() => {});
  }, []);

  // Pending files live in a ref — they can't be serialized and don't need to
  // trigger renders. The provider mounts in app/layout.tsx and never unmounts,
  // so this Map survives navigation between /upload, /review, /export.
  const pendingFiles = useRef<Map<string, File>>(new Map());

  // Guard against the user clicking "Process all" twice.
  const isRunning = useRef(false);

  // Always-fresh references so processQueue's loop doesn't capture stale state.
  const stateRef = useRef(state);
  stateRef.current = state;

  const processQueue = useCallback(async () => {
    if (isRunning.current) return;
    isRunning.current = true;

    const queued = stateRef.current.batches.filter((b) => b.status === 'queued');
    if (queued.length === 0) {
      isRunning.current = false;
      return;
    }

    const totalPhotos = queued.length;
    let photoDone = 0;
    let bookTotal = 0;
    let bookDone = 0;

    dispatch({
      type: 'SET_PROCESSING',
      processing: {
        isActive: true,
        photoDone: 0,
        photoTotal: totalPhotos,
        bookDone: 0,
        bookTotal: 0,
        currentLabel: 'Starting…',
      },
    });

    try {
      for (const batch of queued) {
        const file = pendingFiles.current.get(batch.id);
        if (!file) {
          dispatch({
            type: 'UPDATE_BATCH',
            id: batch.id,
            patch: { status: 'error', error: 'File not in memory' },
          });
          photoDone += 1;
          continue;
        }

        dispatch({ type: 'UPDATE_BATCH', id: batch.id, patch: { status: 'processing' } });
        dispatch({
          type: 'PATCH_PROCESSING',
          patch: { currentLabel: `Detecting spines in ${batch.filename}…` },
        });

        try {
          const detections = await detectSpines(file);
          dispatch({
            type: 'UPDATE_BATCH',
            id: batch.id,
            patch: { spinesDetected: detections.length },
          });
          bookTotal += detections.length;
          dispatch({
            type: 'PATCH_PROCESSING',
            patch: {
              bookTotal,
              currentLabel: `Found ${detections.length} spines — reading them…`,
            },
          });

          const loaded = await loadImage(file);
          const keptBooks: BookRecord[] = [];

          // Pre-crop everything (sync, fast) so the workers below only do I/O.
          const jobs = detections.map((det, i) => ({
            det,
            bbox: { x: det.x, y: det.y, width: det.width, height: det.height },
            ocrCrop: cropSpine(loaded, { x: det.x, y: det.y, width: det.width, height: det.height }, {
              paddingPct: 10,
              maxLongEdge: 1200,
            }),
            spineThumbnail: cropSpine(
              loaded,
              { x: det.x, y: det.y, width: det.width, height: det.height },
              { paddingPct: 5, maxLongEdge: 220, quality: 0.8 }
            ),
            position: det.position ?? i + 1,
          }));

          // Concurrency-limited worker pool. Anthropic vision and the
          // metadata APIs all happily handle 4 concurrent requests; this
          // is a roughly 4× wall-clock speedup vs. the sequential loop
          // and saves the user from staring at the screen.
          const CONCURRENCY = 4;
          // Per-spine wall-clock cap. If buildBookFromCrop's chain of
          // fetches stalls (network blip, silent Vercel hang), we want
          // the worker to unblock and pick up the next spine instead of
          // freezing the whole batch. The orphaned fetch eventually
          // resolves (or hits its server maxDuration) but the client
          // moves on.
          const PER_SPINE_TIMEOUT_MS = 45_000;
          let nextIndex = 0;
          async function runWorker() {
            while (true) {
              const i = nextIndex++;
              if (i >= jobs.length) return;
              const { det, bbox, ocrCrop, spineThumbnail, position: pos } = jobs[i];
              let book: BookRecord;
              let kept: boolean;
              let timedOut = false;
              try {
                const result = await Promise.race([
                  buildBookFromCrop({
                    position: pos,
                    bbox,
                    spineThumbnail,
                    ocrCrop,
                    sourcePhoto: batch.filename,
                    batchLabel: batch.batchLabel,
                    batchNotes: batch.batchNotes,
                  }),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error('PIPELINE_TIMEOUT')),
                      PER_SPINE_TIMEOUT_MS
                    )
                  ),
                ]);
                book = result.book;
                kept = result.kept;
              } catch (err) {
                timedOut =
                  err instanceof Error && err.message === 'PIPELINE_TIMEOUT';
                if (!timedOut) throw err;
                // Build a stub LOW-confidence record so the user can
                // recover via Reread. Position + spine thumbnail are all
                // we have; the fetches that lost the race are orphaned.
                book = makeTimeoutStubBook({
                  position: pos,
                  bbox,
                  spineThumbnail,
                  sourcePhoto: batch.filename,
                  batchLabel: batch.batchLabel,
                  batchNotes: batch.batchNotes,
                });
                kept = true;
                console.warn(
                  `[processQueue] spine #${pos} pipeline timeout after ${PER_SPINE_TIMEOUT_MS}ms`
                );
              }
              bookDone += 1;
              if (kept) keptBooks.push(book);
              dispatch({
                type: 'PATCH_PROCESSING',
                patch: {
                  bookDone,
                  currentLabel: timedOut
                    ? `Timed out — moved on from spine #${det.position}`
                    : kept
                      ? book.title
                        ? `Identified: ${book.title}`
                        : `Spine #${det.position} — verify`
                      : `Skipped illegible spine #${det.position}`,
                },
              });
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, runWorker)
          );

          const finalBooks = flagDuplicates(keptBooks);
          // Cross-check each book against the export ledger. Matches get
          // auto-rejected with a warning so the user can spot already-shipped
          // titles immediately. Loaded fresh per batch so the check picks up
          // any export that completed mid-session.
          const ledger = loadLedger();
          for (const book of finalBooks) {
            flagIfPreviouslyExported(book, ledger);
            dispatch({ type: 'ADD_BOOK', batchId: batch.id, book });
          }

          dispatch({ type: 'UPDATE_BATCH', id: batch.id, patch: { status: 'done' } });

          // Push the finalized batch to the repo so other devices (typically
          // a tablet picking up a phone capture) can see it on their next
          // sync. Fire-and-forget — failures never block the UI, and the
          // route returns 501 cleanly when GITHUB_TOKEN isn't configured.
          const finalizedBatch: PhotoBatch = {
            ...batch,
            status: 'done',
            spinesDetected: detections.length,
            booksIdentified: finalBooks.length,
            books: finalBooks,
          };
          pushBatchToRepo(finalizedBatch).catch(() => {});
        } catch (err: any) {
          dispatch({
            type: 'UPDATE_BATCH',
            id: batch.id,
            patch: { status: 'error', error: err?.message ?? 'Unknown error' },
          });
        }

        // Keep the File handle around so the user can use "Add missing book"
        // (which needs the original full-res image to crop a region).
        // The map is in-memory only, so it dies on hard reload — that's fine.
        photoDone += 1;
        dispatch({ type: 'PATCH_PROCESSING', patch: { photoDone } });
      }

      dispatch({
        type: 'PATCH_PROCESSING',
        patch: {
          isActive: false,
          currentLabel: 'Done. View your results in Review.',
          finishedAt: Date.now(),
        },
      });
    } finally {
      isRunning.current = false;
    }
  }, []);

  const rereadBook = useCallback(
    async (id: string, options: RereadOptions) => {
      const current = stateRef.current.allBooks.find((b) => b.id === id);
      if (!current) return { ok: false, error: 'Book not found.' };

      dispatch({ type: 'UPDATE_BOOK', id, patch: { rereading: true } });
      try {
        const result = await runReread(current, options);
        if (!result.ok) {
          dispatch({
            type: 'UPDATE_BOOK',
            id,
            patch: {
              rereading: false,
              warnings: [
                ...(current.warnings ?? []),
                `Reread failed: ${result.error ?? 'unknown error'}`,
              ],
            },
          });
          return { ok: false, error: result.error };
        }
        dispatch({
          type: 'UPDATE_BOOK',
          id,
          patch: { ...result.patch, rereading: false },
        });
        return { ok: true };
      } catch (err: any) {
        dispatch({ type: 'UPDATE_BOOK', id, patch: { rereading: false } });
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
    []
  );

  /**
   * Re-tag a list of books in parallel (concurrency cap of 4 — same as the
   * spine-processing pool, balances throughput against API rate limits).
   * Each book gets a `retagging: true` flag while in flight so the
   * BookCard can show a brief flash on completion.
   */
  const bulkRetag = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return { done: 0, errors: 0 };

    // Mark every targeted book as retagging up front.
    for (const id of ids) {
      dispatch({ type: 'UPDATE_BOOK', id, patch: { retagging: true } });
    }

    let done = 0;
    let errors = 0;
    let nextIndex = 0;
    const CONCURRENCY = 4;

    async function runWorker() {
      while (true) {
        const i = nextIndex++;
        if (i >= ids.length) return;
        const id = ids[i];
        const current = stateRef.current.allBooks.find((b) => b.id === id);
        if (!current) {
          errors += 1;
          continue;
        }
        try {
          const result = await runRetag(current);
          if (result.ok && result.patch) {
            dispatch({ type: 'UPDATE_BOOK', id, patch: { ...result.patch, retagging: false } });
            done += 1;
          } else {
            dispatch({ type: 'UPDATE_BOOK', id, patch: { retagging: false } });
            errors += 1;
          }
        } catch {
          dispatch({ type: 'UPDATE_BOOK', id, patch: { retagging: false } });
          errors += 1;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, runWorker)
    );
    return { done, errors };
  }, []);

  const api = useMemo<StoreApi>(
    () => ({
      state,
      addBatch: (batch) => dispatch({ type: 'ADD_BATCH', batch }),
      updateBatch: (id, patch) => dispatch({ type: 'UPDATE_BATCH', id, patch }),
      removeBatch: (id) => {
        pendingFiles.current.delete(id);
        dispatch({ type: 'REMOVE_BATCH', id });
        // Drop the cross-device copy too so other devices stop seeing it.
        deletePendingBatchFromRepo(id).catch(() => {});
      },
      addBook: (batchId, book) => dispatch({ type: 'ADD_BOOK', batchId, book }),
      updateBook: (id, patch) => dispatch({ type: 'UPDATE_BOOK', id, patch }),
      removeBooks: (ids) => dispatch({ type: 'REMOVE_BOOKS', ids }),
      clear: () => {
        pendingFiles.current.clear();
        // Tear down every remote pending-batch entry so the next session
        // doesn't pull back the work the user just discarded. Snapshot ids
        // before dispatch so the loop reads pre-clear state.
        const idsToWipe = stateRef.current.batches.map((b) => b.id);
        dispatch({ type: 'CLEAR' });
        for (const id of idsToWipe) {
          deletePendingBatchFromRepo(id).catch(() => {});
        }
      },
      setPendingFile: (batchId, file) => {
        pendingFiles.current.set(batchId, file);
      },
      removePendingFile: (batchId) => {
        pendingFiles.current.delete(batchId);
      },
      hasPendingFile: (batchId) => pendingFiles.current.has(batchId),
      getPendingFile: (batchId) => pendingFiles.current.get(batchId) ?? null,
      processQueue,
      rereadBook,
      bulkRetag,
      mergeDuplicates: (winnerId, loserIds) =>
        dispatch({ type: 'MERGE_DUPLICATES', winnerId, loserIds }),
      unmergeBook: (id) => dispatch({ type: 'UNMERGE_BOOK', id }),
      keepBothDuplicates: (groupId) =>
        dispatch({ type: 'KEEP_BOTH_DUPLICATES', groupId }),
      addCopy: (sourceId) => dispatch({ type: 'ADD_COPY', sourceId }),
    }),
    [state, processQueue, rereadBook, bulkRetag]
  );

  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

export function useDarkMode() {
  const apply = useCallback((on: boolean) => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', on);
    try {
      localStorage.setItem('carnegie:dark', on ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem('carnegie:dark');
      // Default to LIGHT on first visit. Only flip to dark when the user
      // has explicitly chosen it via the toggle. The OS-level
      // prefers-color-scheme is intentionally ignored — light mode is
      // the warm, airy default and dark is opt-in.
      apply(stored === '1');
    } catch {
      apply(false);
    }
  }, [apply]);

  return { setDark: apply };
}
