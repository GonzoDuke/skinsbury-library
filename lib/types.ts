export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface SpineBbox {
  x: number; // 0–100, percent of image width
  y: number;
  width: number;
  height: number;
}

export interface SpineRead {
  position: number;
  rawText: string;
  title?: string;
  author?: string;
  publisher?: string;
  /** LCC read directly from the physical spine (canonical format), if visible. */
  lcc?: string;
  confidence: Confidence;
  note?: string;
  bbox?: SpineBbox;
}

export interface BookLookupResult {
  isbn: string;
  publisher: string;
  publicationYear: number;
  lcc: string;
  subjects?: string[];
  source: 'openlibrary' | 'googlebooks' | 'none';
}

export interface BookRecord {
  id: string;
  spineRead: SpineRead;
  title: string;
  author: string;
  authorLF: string;
  isbn: string;
  publisher: string;
  publicationYear: number;
  lcc: string;
  genreTags: string[];
  formTags: string[];
  confidence: Confidence;
  reasoning: string;
  status: 'pending' | 'approved' | 'rejected';
  warnings: string[];
  sourcePhoto: string;
  /** Optional location label (e.g., "Shelf 3") inherited from the parent PhotoBatch. */
  batchLabel?: string;
  /** Free-form notes set at upload time and inherited by every book in the batch. */
  batchNotes?: string;
  /** Free-form per-book notes editable on the BookCard. Goes into LT's COMMENTS column. */
  notes?: string;
  lookupSource: 'openlibrary' | 'googlebooks' | 'none';
  /** Where the LCC came from. 'spine' wins over 'lookup'. */
  lccSource: 'spine' | 'lookup' | 'none';
  /** Cropped image of just this spine, as a data URI. Lets the reviewer see what the model saw. */
  spineThumbnail?: string;
  /** Higher-resolution OCR-quality crop, used by "Reread spine". Not persisted to localStorage. */
  ocrImage?: string;
  /** True while a reread is in flight, so the BookCard can disable controls + show a spinner. */
  rereading?: boolean;
  /** Snapshot of metadata as it came from spine read + lookup, before any user edits. */
  original: {
    title: string;
    author: string;
    isbn: string;
    publisher: string;
    publicationYear: number;
    lcc: string;
  };
}

export interface PhotoBatch {
  id: string;
  filename: string;
  fileSize: number;
  thumbnail: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  error?: string;
  spinesDetected: number;
  booksIdentified: number;
  books: BookRecord[];
  /** Optional location label set at upload time (e.g., "Shelf 3"). */
  batchLabel?: string;
  /** Free-form notes set at upload time, inherited by every book in this batch. */
  batchNotes?: string;
}

export interface AppState {
  batches: PhotoBatch[];
  allBooks: BookRecord[];
}

export interface InferTagsResult {
  genreTags: string[];
  formTags: string[];
  confidence: Confidence;
  reasoning: string;
}
