import type { BookRecord, PhotoBatch } from './types';

const REMOTE_AVAILABLE_KEY = 'carnegie:pending-batches:remote-available:v1';

interface RemotePendingBatchesResponse {
  available: boolean;
  batches?: PhotoBatch[];
  error?: string;
  /** Surfaced GitHub error detail when the route returned 502. Useful in
   *  console diagnostics; the UI doesn't render this directly. */
  details?: string;
  ok?: boolean;
  id?: string;
}

/**
 * Strip transient + heavy fields before sending to the remote. Photos
 * themselves never leave the device. We keep `spineThumbnail` (small,
 * needed for the Review card visuals) and drop `ocrImage` (large, only
 * needed locally for Reread).
 */
export function slimBatchForSync(batch: PhotoBatch): PhotoBatch {
  const slimBook = (bk: BookRecord): BookRecord => ({
    ...bk,
    ocrImage: undefined,
    mergedFrom: bk.mergedFrom?.map((m) => ({ ...m, ocrImage: undefined })),
  });
  return {
    ...batch,
    // The full-photo thumbnail is only used for the upload queue UI on the
    // capturing device — synced batches don't need it.
    thumbnail: '',
    books: batch.books.map(slimBook),
  };
}

/**
 * Pull every pending batch JSON from the repo. Returns an array on success,
 * or null when the remote is unavailable / errored (caller falls back to
 * localStorage).
 */
export async function syncPendingBatchesFromRepo(): Promise<PhotoBatch[] | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch('/api/pending-batches', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as RemotePendingBatchesResponse;
    rememberRemoteAvailability(data.available);
    if (!data.available || !Array.isArray(data.batches)) return null;
    return data.batches;
  } catch {
    return null;
  }
}

/**
 * Push one batch to the repo. Fire-and-forget from the caller's POV — we
 * resolve to the response so callers that care can log, but errors are
 * swallowed to a falsy result so a network blip can't block the UI.
 */
export async function pushBatchToRepo(
  batch: PhotoBatch
): Promise<RemotePendingBatchesResponse> {
  if (typeof window === 'undefined') return { available: false };
  try {
    const slim = slimBatchForSync(batch);
    const res = await fetch('/api/pending-batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slim),
    });
    const data = (await res.json().catch(() => ({}))) as RemotePendingBatchesResponse;
    if (res.status === 501) {
      rememberRemoteAvailability(false);
      return { available: false, error: data.error };
    }
    if (!res.ok) {
      return {
        available: data.available ?? true,
        error: data.error ?? `HTTP ${res.status}`,
        details: data.details,
      };
    }
    rememberRemoteAvailability(true);
    return data;
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete a single pending batch from the repo. Idempotent — a missing
 * file resolves to ok. Called on CSV export and on Clear/New-session.
 */
export async function deletePendingBatchFromRepo(
  batchId: string
): Promise<RemotePendingBatchesResponse> {
  if (typeof window === 'undefined') return { available: false };
  try {
    const res = await fetch(
      `/api/pending-batches?batchId=${encodeURIComponent(batchId)}`,
      { method: 'DELETE' }
    );
    const data = (await res.json().catch(() => ({}))) as RemotePendingBatchesResponse;
    if (res.status === 501) {
      rememberRemoteAvailability(false);
      return { available: false, error: data.error };
    }
    if (!res.ok) {
      return {
        available: data.available ?? true,
        error: data.error ?? `HTTP ${res.status}`,
        details: data.details,
      };
    }
    rememberRemoteAvailability(true);
    return data;
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
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
 * Last known availability of the remote pending-batches endpoint. Returns
 * `null` when we haven't checked yet, so the UI can render a neutral state.
 */
export function getCachedRemoteAvailability(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(REMOTE_AVAILABLE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  } catch {
    return null;
  }
}
