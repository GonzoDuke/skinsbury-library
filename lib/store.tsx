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
  dedupeBooks,
  detectSpines,
  loadImage,
  rereadBook as runReread,
  type RereadOptions,
} from './pipeline';

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
  | { type: 'SET_PROCESSING'; processing: ProcessingState | null }
  | { type: 'PATCH_PROCESSING'; patch: Partial<ProcessingState> }
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
    case 'ADD_BATCH':
      return { ...state, batches: [...state.batches, action.batch] };
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
    case 'SET_PROCESSING':
      return { ...state, processing: action.processing };
    case 'PATCH_PROCESSING':
      return state.processing
        ? { ...state, processing: { ...state.processing, ...action.patch } }
        : state;
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
  clear: () => void;

  /** Register a File against a queued batch so the orchestrator can read it later. */
  setPendingFile: (batchId: string, file: File) => void;
  removePendingFile: (batchId: string) => void;
  hasPendingFile: (batchId: string) => boolean;

  /** Run detect → read → lookup → ground → dedup over every queued batch. */
  processQueue: () => Promise<void>;

  /** Re-run the per-book pipeline. Optional hint skips Pass B and uses the typed title/author. */
  rereadBook: (id: string, options: RereadOptions) => Promise<{ ok: boolean; error?: string }>;
}

const StoreCtx = createContext<StoreApi | null>(null);

const STORAGE_KEY = 'skinsbury:state:v1';

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    if (typeof window === 'undefined') return init;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return init;
      const parsed = JSON.parse(raw) as Partial<State>;
      // Strip any in-flight processing state on cold load — Files don't survive
      // a page refresh, so anything that was processing is no longer recoverable.
      const batches = (parsed.batches ?? []).map((b) =>
        b.status === 'processing' || b.status === 'queued'
          ? { ...b, status: 'done' as const }
          : b
      );
      return { batches, allBooks: parsed.allBooks ?? [], processing: null };
    } catch {
      return init;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      // Don't persist large data URIs (batch thumbnail, spine thumbnails,
      // OCR crops) or processing state.
      const slim = {
        batches: state.batches.map((b) => ({
          ...b,
          thumbnail: '',
          books: b.books.map((bk) => ({ ...bk, spineThumbnail: '', ocrImage: undefined })),
        })),
        allBooks: state.allBooks.map((bk) => ({
          ...bk,
          spineThumbnail: '',
          ocrImage: undefined,
        })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // ignore quota errors
    }
  }, [state.batches, state.allBooks]);

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
          let nextIndex = 0;
          async function runWorker() {
            while (true) {
              const i = nextIndex++;
              if (i >= jobs.length) return;
              const { det, bbox, ocrCrop, spineThumbnail, position: pos } = jobs[i];
              const { book, kept } = await buildBookFromCrop({
                position: pos,
                bbox,
                spineThumbnail,
                ocrCrop,
                sourcePhoto: batch.filename,
                batchLabel: batch.batchLabel,
                batchNotes: batch.batchNotes,
              });
              bookDone += 1;
              if (kept) keptBooks.push(book);
              dispatch({
                type: 'PATCH_PROCESSING',
                patch: {
                  bookDone,
                  currentLabel: kept
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

          const finalBooks = dedupeBooks(keptBooks);
          for (const book of finalBooks) {
            dispatch({ type: 'ADD_BOOK', batchId: batch.id, book });
          }

          dispatch({ type: 'UPDATE_BATCH', id: batch.id, patch: { status: 'done' } });
        } catch (err: any) {
          dispatch({
            type: 'UPDATE_BATCH',
            id: batch.id,
            patch: { status: 'error', error: err?.message ?? 'Unknown error' },
          });
        }

        // Done with this photo — drop its File handle to free memory.
        pendingFiles.current.delete(batch.id);
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

  const api = useMemo<StoreApi>(
    () => ({
      state,
      addBatch: (batch) => dispatch({ type: 'ADD_BATCH', batch }),
      updateBatch: (id, patch) => dispatch({ type: 'UPDATE_BATCH', id, patch }),
      removeBatch: (id) => {
        pendingFiles.current.delete(id);
        dispatch({ type: 'REMOVE_BATCH', id });
      },
      addBook: (batchId, book) => dispatch({ type: 'ADD_BOOK', batchId, book }),
      updateBook: (id, patch) => dispatch({ type: 'UPDATE_BOOK', id, patch }),
      clear: () => {
        pendingFiles.current.clear();
        dispatch({ type: 'CLEAR' });
      },
      setPendingFile: (batchId, file) => {
        pendingFiles.current.set(batchId, file);
      },
      removePendingFile: (batchId) => {
        pendingFiles.current.delete(batchId);
      },
      hasPendingFile: (batchId) => pendingFiles.current.has(batchId),
      processQueue,
      rereadBook,
    }),
    [state, processQueue, rereadBook]
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
      localStorage.setItem('skinsbury:dark', on ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem('skinsbury:dark');
      if (stored !== null) {
        apply(stored === '1');
        return;
      }
    } catch {
      // ignore
    }
    const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
    apply(prefers);
  }, [apply]);

  return { setDark: apply };
}
