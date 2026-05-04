import type {
  BookRecord,
  InferTagsResult,
  BookLookupResult,
  SpineRead,
  SpineBbox,
} from './types';
import { toAuthorLastFirst, toTitleCase } from './csv-export';
import { stringSimilarity } from './lookup-utils';

/**
 * When true, prefer canonical title / author from the lookup chain
 * (OL/ISBNdb/MARC) over the spine OCR text on the displayed
 * BookRecord. The spine read is preserved on `spineRead.rawText`
 * either way. Flip to false to instantly revert to spine-OCR titles
 * if anything looks wrong — no other code change needed.
 */
const USE_CANONICAL_TITLES = true;

/**
 * Format a single "First Last" or already-flipped name into "Last,
 * First" form. Used by the multi-author authorLF builder when the
 * lookup chain returned a full author list. Mirrors the conservative
 * single-author flip in csv-export's toAuthorLastFirst — single-token
 * names ("Madonna") and already-comma'd inputs pass through.
 */
function flipNameLastFirst(name: string): string {
  const trimmed = name.trim().replace(/,$/, '');
  if (!trimmed) return '';
  if (trimmed.includes(',')) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${last}, ${first}`;
}

/**
 * Per-spine model selection. The big OCR cost driver is Pass B; Opus is
 * ~5× the per-token cost of Sonnet. Wide horizontal spines with large
 * type read fine on Sonnet; narrow vertical spines need Opus to avoid
 * confident hallucinations (we tried Sonnet-everywhere and reverted —
 * see commit 6baa0da).
 *
 * Heuristic: a spine is "easy" when its bbox area is at least
 * `easyAreaThreshold` percent of the image AND the aspect ratio is
 * less than `easyAspectMaxRatio`. Otherwise: hard.
 */
export const SPINE_MODEL_CONFIG = {
  easyAreaThreshold: 2.0, // % of image area
  easyAspectMaxRatio: 3, // height / width
};

export function pickSpineModel(bbox: { width: number; height: number }): 's' | 'o' {
  const area = bbox.width * bbox.height; // bbox is in image-percent already, so this is roughly % of image area × 100
  const aspect = bbox.height / Math.max(0.0001, bbox.width);
  const easy =
    area >= SPINE_MODEL_CONFIG.easyAreaThreshold &&
    aspect < SPINE_MODEL_CONFIG.easyAspectMaxRatio;
  return easy ? 's' : 'o';
}

export function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ----- API clients -----

interface DetectionResponse {
  detections: Array<{
    position: number;
    x: number;
    y: number;
    width: number;
    height: number;
    orientation?: 'vertical' | 'horizontal';
    note?: string;
  }>;
}

export async function detectSpines(file: File): Promise<DetectionResponse['detections']> {
  // Pass A only draws bounding boxes — it doesn't need full source resolution.
  // Phone photos can be 8–15 MB and would blow Vercel's 4.5 MB serverless body
  // limit. Downscale to ~1800px long edge (~300–700 KB JPEG) before upload.
  // The original full-res File stays in memory and is what cropSpine reads
  // for the per-spine OCR crops, so OCR quality is unaffected.
  const compressed = await downscaleForUpload(file, 1800, 0.85);
  const fd = new FormData();
  fd.append('image', compressed, file.name);
  const res = await fetch('/api/process-photo', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `process-photo failed (${res.status})`);
  }
  const data = (await res.json()) as DetectionResponse;
  return data.detections ?? [];
}

async function downscaleForUpload(file: File, maxLongEdge: number, quality: number): Promise<Blob> {
  const { img, width, height } = await loadImage(file);
  // Don't upscale; if the source is already small enough, just send the original.
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return file;
  const scale = maxLongEdge / longEdge;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, w, h);
  return await new Promise<Blob>((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? file), 'image/jpeg', quality);
  });
}

interface ReadSpineResponse {
  title: string;
  author: string;
  publisher: string;
  lcc: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  note?: string;
  // Step 2 sticker extractions. All optional.
  extractedCallNumber?: string;
  extractedCallNumberSystem?: 'lcc' | 'ddc' | 'unknown';
  extractedEdition?: string;
  extractedSeries?: string;
}

export async function readSpine(args: {
  imageBase64: string;
  mediaType: string;
  position: number;
  model?: 'sonnet' | 'opus';
}): Promise<ReadSpineResponse> {
  const res = await fetch('/api/read-spine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    return { title: '', author: '', publisher: '', lcc: '', confidence: 'LOW', note: 'Read failed' };
  }
  return (await res.json()) as ReadSpineResponse;
}

export async function lookupBookClient(
  title: string,
  author: string,
  options?: {
    matchEdition?: boolean;
    hints?: { year?: number; publisher?: string; isbn?: string };
  }
): Promise<BookLookupResult> {
  const res = await fetch('/api/lookup-book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      author,
      matchEdition: options?.matchEdition,
      hints: options?.hints,
    }),
  });
  if (!res.ok) {
    return { isbn: '', publisher: '', publicationYear: 0, lcc: '', source: 'none' };
  }
  return (await res.json()) as BookLookupResult;
}

export interface IdentifyBookResponse {
  title: string;
  author: string;
  isbn: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
}

/**
 * Last-resort identifier. Calls /api/identify-book to ask Claude
 * Sonnet to recognize a book from raw spine fragments. Used by
 * buildBookFromCrop when the title-search lookup chain produces
 * `source: 'none'` despite the spine read having captured something.
 */
export async function identifyBookClient(args: {
  rawText: string;
  partialTitle?: string;
  partialAuthor?: string;
}): Promise<IdentifyBookResponse> {
  const empty: IdentifyBookResponse = {
    title: '',
    author: '',
    isbn: '',
    confidence: 'LOW',
    reasoning: '',
  };
  try {
    const res = await fetch('/api/identify-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) return empty;
    return (await res.json()) as IdentifyBookResponse;
  } catch {
    return empty;
  }
}

export interface InferLccResponse {
  lcc: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning?: string;
}

export async function inferLccClient(args: {
  title: string;
  author: string;
  publisher?: string;
  publicationYear?: number;
}): Promise<InferLccResponse> {
  const res = await fetch('/api/infer-lcc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) return { lcc: '', confidence: 'LOW' };
  return (await res.json()) as InferLccResponse;
}

export async function inferTagsClient(args: {
  title: string;
  author: string;
  isbn?: string;
  publisher?: string;
  publicationYear?: number;
  lcc?: string;
  subjectHeadings?: string[];
  // Phase-3 enrichment fields. All optional — old callers continue to
  // build the same prompt as before because the route only adds lines
  // when these are populated.
  ddc?: string;
  lcshSubjects?: string[];
  /** MARC 655 genre/form terms — cataloger-applied explicit genre
   *  vocabulary. Highest-priority signal for genre/form classification
   *  (outranks LCSH and LCC for that purpose specifically). */
  marcGenreTerms?: string[];
  /** Publisher series indicator extracted directly from the spine
   *  ("Penguin Classics", "Library of America", "Folio Society"). When
   *  present, the prompt should apply the matching form tag with high
   *  confidence — this is read off the physical artifact and overrides
   *  the "only when publisher confirms" guard for series form tags. */
  extractedSeries?: string;
  synopsis?: string;
}): Promise<InferTagsResult> {
  // Pull the user's most recent tag corrections from localStorage and
  // forward them so the inference route can append them to the system
  // prompt as few-shot examples. Reads through a dynamic import so the
  // module stays SSR-safe — pipeline is also used server-side during
  // some flows.
  let corrections: unknown[] = [];
  if (typeof window !== 'undefined') {
    try {
      const mod = await import('./corrections-log');
      corrections = mod.recentCorrections(20);
    } catch {
      // ignore — corrections are best-effort
    }
  }
  const res = await fetch('/api/infer-tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, corrections }),
  });
  if (!res.ok) {
    return { genreTags: [], formTags: [], confidence: 'LOW', reasoning: '' };
  }
  return (await res.json()) as InferTagsResult;
}

// ----- Image utilities -----

export interface LoadedImage {
  /** HTMLImageElement at full natural resolution. */
  img: HTMLImageElement;
  /** Image's intrinsic width in CSS pixels. */
  width: number;
  height: number;
}

export function loadImage(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      URL.revokeObjectURL(url);
      resolve({ img, width, height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

export function createThumbnail(file: File, maxSize = 160): Promise<string> {
  return loadImage(file).then(({ img }) => {
    const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.drawImage(img, 0, 0, w, h);
    try {
      return canvas.toDataURL('image/jpeg', 0.75);
    } catch {
      return '';
    }
  });
}

/**
 * Crop a region of an image (specified as bbox percentages 0–100) and return
 * it as a base64-encoded JPEG. The crop is at full source resolution, with
 * 10% padding added on each side, clamped to image bounds.
 */
export function cropSpine(
  loaded: LoadedImage,
  bbox: SpineBbox,
  options: { paddingPct?: number; quality?: number; maxLongEdge?: number } = {}
): string {
  const padding = options.paddingPct ?? 10;
  const quality = options.quality ?? 0.88;
  const maxLongEdge = options.maxLongEdge ?? 1600;

  const padW = (bbox.width * padding) / 100;
  const padH = (bbox.height * padding) / 100;

  const x0 = Math.max(0, bbox.x - padW);
  const y0 = Math.max(0, bbox.y - padH);
  const x1 = Math.min(100, bbox.x + bbox.width + padW);
  const y1 = Math.min(100, bbox.y + bbox.height + padH);

  const sx = Math.round((x0 / 100) * loaded.width);
  const sy = Math.round((y0 / 100) * loaded.height);
  const sw = Math.max(1, Math.round(((x1 - x0) / 100) * loaded.width));
  const sh = Math.max(1, Math.round(((y1 - y0) / 100) * loaded.height));

  // Downscale large crops only — small crops keep their full pixel density.
  const longEdge = Math.max(sw, sh);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(loaded.img, sx, sy, sw, sh, 0, 0, dw, dh);
  return canvas.toDataURL('image/jpeg', quality);
}

// ----- Hallucination filter -----

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(s: string): string[] {
  return normalize(s).split(' ').filter(Boolean);
}

/**
 * Looks gibberish if the title is short, all-uppercase nonsense, or has no
 * letters that form pronounceable clusters. Used as a last-line filter after
 * the lookup also fails.
 */
function looksLikeGibberish(s: string): boolean {
  if (!s) return true;
  const stripped = s.replace(/[^a-zA-Z]/g, '');
  if (stripped.length < 3) return true;
  // No vowels at all is a strong gibberish signal.
  if (!/[aeiouy]/i.test(stripped)) return true;
  // 4+ identical characters in a row.
  if (/(.)\1{3,}/i.test(stripped)) return true;
  return false;
}

/**
 * Levenshtein distance — used to compare spine OCR output to lookup match.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

interface GroundResult {
  /** Whether to keep this entry at all. */
  keep: boolean;
  /** Human-readable warnings to attach to the BookRecord. */
  warnings: string[];
  /** Confidence after grounding. May be lower than the spine read. */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

const PERIODICAL_TITLE_WORDS = [
  'magazine',
  'monitor on',
  'newsletter',
  'quarterly',
  'monthly',
  'weekly',
  'annual review',
  'the atlantic',
  'the new yorker',
  'harper’s',
  "harper's",
];

const PERIODICAL_SUBJECT_KEYWORDS = ['periodical', 'magazine', 'newspapers', 'serial publication'];

/**
 * A book is a periodical if its TITLE strongly suggests so. Subjects alone
 * are too noisy — fiction set in a newspaper or an academic book about
 * journalism can pick up "periodical"/"newspapers" subjects.
 */
function isPeriodical(title: string, lookup: BookLookupResult): boolean {
  const t = title.toLowerCase();
  const titleSignal = PERIODICAL_TITLE_WORDS.some((w) => t.includes(w));
  if (!titleSignal) return false;
  // Strengthen with subject corroboration when we have one — but if subjects
  // are missing, the title alone is enough.
  if (!lookup.subjects || lookup.subjects.length === 0) return true;
  return lookup.subjects.some((s) =>
    PERIODICAL_SUBJECT_KEYWORDS.some((p) => s.toLowerCase().includes(p))
  );
}

/**
 * Cross-check a spine OCR result against the lookup outcome. Catches:
 * - illegible spines that produced gibberish (drop)
 * - author-byline-only entries the detector mistakenly captured (drop)
 * - magazines/journals that slipped past the detection prompt (drop)
 * - lookup hits whose title diverges from what the spine said (demote, warn)
 * - genuine no-match cases (keep with LOW + warning, so reviewer can fix)
 */
export function groundSpineRead(
  spine: { title: string; author: string; lcc?: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW' },
  lookup: BookLookupResult,
  lookupTitle?: string // The title Open Library / Google Books actually returned
): GroundResult {
  const warnings: string[] = [];
  const hasTitle = !!spine.title.trim();
  const hasAuthor = !!spine.author.trim();

  // 1) No title at all — was just an author byline, or fully unreadable.
  if (!hasTitle) {
    if (hasAuthor) {
      warnings.push(
        'Spine showed an author name but no readable title — possibly an author label adjacent to another book.'
      );
    } else {
      warnings.push('Spine was unreadable.');
    }
    return { keep: false, warnings, confidence: 'LOW' };
  }

  // 2) Magazine/journal slipped past the detection prompt — drop.
  if (isPeriodical(spine.title, lookup)) {
    warnings.push(
      `"${spine.title}" appears to be a magazine or journal, not a book — dropped.`
    );
    return { keep: false, warnings, confidence: 'LOW' };
  }

  // 3) Lookup found nothing AND the title looks like nonsense.
  if (lookup.source === 'none' && looksLikeGibberish(spine.title)) {
    warnings.push(
      `"${spine.title}" did not match any book and looks illegible — dropped.`
    );
    return { keep: false, warnings, confidence: 'LOW' };
  }

  // 4) Lookup found nothing — keep but flag.
  if (lookup.source === 'none') {
    warnings.push(
      'No metadata match in Open Library or Google Books — verify title and author.'
    );
    return { keep: true, warnings, confidence: 'LOW' };
  }

  // 4) Lookup found something — measure divergence between OCR and matched title.
  if (lookupTitle) {
    const a = normalize(spine.title);
    const b = normalize(lookupTitle);
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    const sharedTokens = tokenize(a).filter((t) => t.length >= 4 && tokenize(b).includes(t));
    if (maxLen > 0 && dist / maxLen > 0.5 && sharedTokens.length === 0) {
      warnings.push(
        `Lookup matched "${lookupTitle}" but the spine read "${spine.title}". Please verify which is correct.`
      );
      return { keep: true, warnings, confidence: 'LOW' };
    }
  }

  // 5) Standard non-fatal warnings.
  if (!lookup.isbn) warnings.push('No ISBN found — metadata may be incomplete.');
  // LCC missing warning suppressed when the spine itself provided one.
  if (!lookup.lcc && !spine.lcc) {
    warnings.push('LCC code missing — tags inferred from title and author only.');
  }

  return { keep: true, warnings, confidence: spine.confidence };
}

// ----- Build a BookRecord (called per detected spine) -----

function dataUriToBase64Parts(uri: string): { base64: string; mediaType: string } {
  const m = uri.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return { base64: uri, mediaType: 'image/jpeg' };
  return { mediaType: m[1], base64: m[2] };
}

export interface BuildBookOptions {
  position: number;
  bbox: SpineBbox;
  spineThumbnail: string; // data URI from cropSpine
  sourcePhoto: string;
  /** A larger crop (data URI) sent to /api/read-spine for OCR. */
  ocrCrop: string;
  /** Optional location label inherited from the parent PhotoBatch. */
  batchLabel?: string;
  /** Free-form notes inherited from the parent PhotoBatch. */
  batchNotes?: string;
  /** Stamp `manuallyAdded` on the resulting BookRecord — used by "Add missing book" Path A. */
  manuallyAdded?: boolean;
}

export interface BuiltBook {
  book: BookRecord;
  /** True when the entry survived the hallucination filter. */
  kept: boolean;
}

export async function buildBookFromCrop(opts: BuildBookOptions): Promise<BuiltBook> {
  const { position, bbox, spineThumbnail, sourcePhoto, ocrCrop, batchLabel, batchNotes, manuallyAdded } = opts;
  const { base64, mediaType } = dataUriToBase64Parts(ocrCrop);

  // Pass B — model selection per spine. Wide / large-area spines route
  // to Sonnet (cheaper); narrow vertical spines that hallucinated under
  // an earlier all-Sonnet experiment route to Opus. If a Sonnet read
  // returns LOW confidence we auto-retry with Opus before surfacing it.
  const initialModel = pickSpineModel(bbox);
  let read = await readSpine({
    imageBase64: base64,
    mediaType,
    position,
    model: initialModel === 's' ? 'sonnet' : 'opus',
  });
  let ocrModel: 's' | 'o' = initialModel;
  if (initialModel === 's' && read.confidence === 'LOW') {
    const opusRead = await readSpine({
      imageBase64: base64,
      mediaType,
      position,
      model: 'opus',
    });
    const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
    if (order[opusRead.confidence] >= order[read.confidence]) {
      read = opusRead;
      ocrModel = 'o';
    }
  }

  const spineRead: SpineRead = {
    position,
    rawText: [read.title, read.author].filter(Boolean).join(' — '),
    title: read.title,
    author: read.author,
    publisher: read.publisher,
    lcc: read.lcc,
    confidence: read.confidence,
    note: read.note,
    bbox,
    extractedCallNumber: read.extractedCallNumber,
    extractedCallNumberSystem: read.extractedCallNumberSystem,
    extractedEdition: read.extractedEdition,
    extractedSeries: read.extractedSeries,
  };

  // Look up metadata.
  let lookup: BookLookupResult = {
    isbn: '',
    publisher: read.publisher ?? '',
    publicationYear: 0,
    lcc: '',
    source: 'none',
  };

  let lookupMatchedTitle: string | undefined;

  if (read.title) {
    try {
      const r = await lookupBookClient(read.title, read.author);
      lookup = { ...r, publisher: r.publisher || read.publisher || '' };
      // We don't have the matched title from the lookup endpoint today; pass
      // undefined and rely on the gibberish + author-only checks.
      lookupMatchedTitle = undefined;
    } catch {
      // ignore — lookup remains source: 'none'
    }
  }

  // Last-resort identifier. The standard lookup chain is title-driven;
  // if the spine OCR produced a fragment too garbled to match
  // ("STRANG" / "CAMUS" / "VINTAGE", a half-cropped subtitle, an
  // author-only spine), every title-search tier returns nothing and
  // the book lands on Review with empty metadata. Ask Claude Sonnet
  // to identify the book from whatever raw text the spine read
  // captured, then re-run the lookup chain with the corrected
  // title/author. ISBN-direct on the new title's resolved ISBN
  // re-enters Phase B so the re-run returns a complete record.
  let identifyWarning = '';
  if (lookup.source === 'none') {
    const rawText = (spineRead.rawText || `${read.title ?? ''} ${read.author ?? ''}`).trim();
    if (rawText.length >= 3) {
      try {
        const guess = await identifyBookClient({
          rawText,
          partialTitle: read.title,
          partialAuthor: read.author,
        });
        if (guess.title && guess.confidence !== 'LOW') {
          // Re-run the lookup with the corrected guess. If we got an
          // ISBN from Sonnet, fold it in via matchEdition so the
          // server hits ol-by-isbn → isbndb-direct directly.
          const reRun = guess.isbn
            ? await lookupBookClient(guess.title, guess.author, {
                matchEdition: true,
                hints: { isbn: guess.isbn },
              })
            : await lookupBookClient(guess.title, guess.author);
          if (reRun.source !== 'none') {
            lookup = { ...reRun, publisher: reRun.publisher || read.publisher || '' };
            // Adopt the corrected title/author for the rest of the
            // pipeline so tag inference sees the right metadata.
            read.title = guess.title;
            if (guess.author) read.author = guess.author;
            identifyWarning = `Identified by AI from partial spine read: ${guess.reasoning || guess.title}`;
          }
        }
      } catch {
        // ignore — identifier is best-effort
      }
    }
  }

  const grounded = groundSpineRead(
    {
      title: read.title,
      author: read.author,
      lcc: read.lcc,
      confidence: read.confidence,
    },
    lookup,
    lookupMatchedTitle
  );

  // Surface the identify-book guess (when it fired and the re-run
  // succeeded) on the BookCard so the reviewer knows the metadata
  // came from an AI guess, not a direct OCR → search match.
  if (identifyWarning) grounded.warnings.push(identifyWarning);

  // Spine-printed LCC wins over the lookup-derived one — it's the LoC's
  // own classification for the exact physical edition the user owns.
  // Provenance: spine (printed or stickered) > loc/ol (from lookup
  // chain) > inferred (model best-guess).
  //
  // The Step 2 extractedCallNumber field is the strict-stickered
  // form. When present and tagged 'lcc' it gets the same 'spine'
  // provenance as read.lcc. When tagged 'ddc' it goes to lookup.ddc
  // (still gap-fill — never overwriting an LCC) so the tag prompt
  // rule on DDC kicks in.
  const stickerLcc =
    read.extractedCallNumber && read.extractedCallNumberSystem === 'lcc'
      ? read.extractedCallNumber
      : '';
  let finalLcc = stickerLcc || read.lcc || lookup.lcc;
  let lccSource: BookRecord['lccSource'] = stickerLcc || read.lcc
    ? 'spine'
    : lookup.lcc
      ? lookup.lccSource ?? 'ol'
      : 'none';

  // DDC override from a Dewey sticker. Same gap-fill semantics as the
  // network DDC tier: if the lookup found a DDC we keep it (the physical
  // sticker and the cataloger DDC should agree, and the cataloger DDC
  // tends to be more complete). If neither did, the sticker fills in.
  if (
    read.extractedCallNumber &&
    read.extractedCallNumberSystem === 'ddc' &&
    !lookup.ddc
  ) {
    lookup.ddc = read.extractedCallNumber;
  }

  // Edition gap-fill — the lookup chain may have produced an edition
  // statement from MARC 250 or ISBNdb; spine extraction is a fallback.
  if (read.extractedEdition && !lookup.edition) {
    lookup.edition = read.extractedEdition;
  }

  // Tier 6: model-inferred LCC (final fallback). Only fires when the
  // entire lookup chain (OL t1-t4 → GB → LoC SRU by ISBN → LoC SRU by
  // title+author) returned nothing. Marked 'inferred' so the BookCard
  // can show a clearly distinct badge — this is best-guess, not
  // authoritative.
  if (!finalLcc && grounded.keep && read.title && read.author) {
    try {
      const inferred = await inferLccClient({
        title: read.title,
        author: read.author,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
      });
      if (inferred.lcc && inferred.confidence !== 'LOW') {
        finalLcc = inferred.lcc;
        lccSource = 'inferred';
      }
    } catch {
      // ignore — leave LCC empty
    }
  }

  // Tag inference — only if we're keeping the entry, have a title, AND
  // a successful metadata lookup. With no lookup match we'd be tagging
  // from title alone, which produces noisy tags; better to leave empty
  // and let the user re-trigger via the Reread button after correcting
  // the title.
  let tags: InferTagsResult = {
    genreTags: [],
    formTags: [],
    confidence: 'LOW',
    reasoning: '',
  };
  if (grounded.keep && read.title) {
    // Run tag inference even when lookup missed — the model can still
    // produce useful tags from title + author + general knowledge. The
    // system prompt already flags LOW confidence when LCC is missing,
    // and the user can re-trigger via the Reread button.
    try {
      tags = await inferTagsClient({
        title: read.title,
        author: read.author,
        isbn: lookup.isbn,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
        lcc: finalLcc,
        subjectHeadings: lookup.subjects,
        ddc: lookup.ddc,
        lcshSubjects: lookup.lcshSubjects,
        marcGenreTerms: lookup.marcGenres,
        extractedSeries: read.extractedSeries,
        synopsis: lookup.synopsis,
      });
    } catch {
      grounded.warnings.push('Tag inference failed.');
    }
  }

  // Combined confidence: take the worse of OCR confidence (post-grounding) and tag confidence.
  const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  const combinedConfidence =
    order[grounded.confidence] <= order[tags.confidence] ? grounded.confidence : tags.confidence;

  const titleCased = toTitleCase(read.title);

  // Canonical title / author override. When the lookup matched (any
  // tier), the spine OCR can be replaced by the database's authoritative
  // record. Spine OCR survives on spineRead.rawText / spineRead.title
  // for diagnostic display. Flag-gated so the change is one-line
  // revertible if a regression surfaces.
  //
  // Shorter-of-two rule: when both the spine read and the canonical
  // title clearly refer to the same book (Levenshtein similarity
  // > 0.6 between lowercased forms), prefer the SHORTER of the two
  // for display. This stops "The Hobbit, Or, There and Back Again"
  // from replacing "The Hobbit" while still letting clearly-better
  // canonical titles (e.g. when the OCR caught a fragment) win when
  // similarity is low — that's a different-titles signal that means
  // the spine read was probably wrong.
  const useCanonical = USE_CANONICAL_TITLES && lookup.source !== 'none';
  const canonicalTitleCased =
    useCanonical && lookup.canonicalTitle && lookup.canonicalTitle.trim()
      ? toTitleCase(lookup.canonicalTitle)
      : '';
  let displayTitle = canonicalTitleCased || titleCased;
  if (canonicalTitleCased && titleCased) {
    const sim = stringSimilarity(canonicalTitleCased.toLowerCase(), titleCased.toLowerCase());
    if (sim >= 0.6) {
      displayTitle =
        titleCased.length < canonicalTitleCased.length ? titleCased : canonicalTitleCased;
    }
  }
  const displayAuthor =
    useCanonical && lookup.canonicalAuthor && lookup.canonicalAuthor.trim()
      ? lookup.canonicalAuthor
      : read.author;
  // Multi-author authorLF builder: when allAuthors is set, format every
  // author as Last, First and join with "; " (LibraryThing's canonical
  // multi-author delimiter). Single-author cases fall back to the
  // existing toAuthorLastFirst path.
  const authorLF =
    useCanonical && lookup.allAuthors && lookup.allAuthors.length > 1
      ? lookup.allAuthors.map(flipNameLastFirst).filter(Boolean).join('; ')
      : toAuthorLastFirst(displayAuthor);

  const book: BookRecord = {
    id: makeId(),
    spineRead,
    title: displayTitle,
    author: displayAuthor,
    authorLF,
    isbn: lookup.isbn,
    publisher: lookup.publisher,
    publicationYear: lookup.publicationYear,
    lcc: finalLcc,
    genreTags: tags.genreTags,
    formTags: tags.formTags,
    confidence: combinedConfidence,
    reasoning: tags.reasoning,
    status: 'pending',
    warnings: grounded.warnings,
    sourcePhoto,
    batchLabel,
    batchNotes,
    manuallyAdded,
    lookupSource: lookup.source,
    ddc: lookup.ddc,
    lccSource,
    spineThumbnail,
    coverUrl: lookup.coverUrl,
    ocrImage: ocrCrop,
    ocrModel,
    // Phase-3 enrichment passthrough. Each field is optional + lookup
    // may not have set it; conditionals stop us from sticking
    // `undefined` onto the record key explicitly.
    canonicalTitle: lookup.canonicalTitle,
    subtitle: lookup.subtitle,
    allAuthors: lookup.allAuthors,
    synopsis: lookup.synopsis,
    pageCount: lookup.pageCount,
    edition: lookup.edition,
    binding: lookup.binding,
    language: lookup.language,
    series: lookup.series,
    lcshSubjects: lookup.lcshSubjects,
    marcGenres: lookup.marcGenres,
    coverUrlFallbacks: lookup.coverUrlFallbacks,
    original: {
      // Snapshot the displayed (canonical when available) values so
      // the BookCard's "edited" pip compares user edits against the
      // version they actually saw, not the spine OCR text.
      title: displayTitle,
      author: displayAuthor,
      isbn: lookup.isbn,
      publisher: lookup.publisher,
      publicationYear: lookup.publicationYear,
      lcc: finalLcc,
      genreTags: [...tags.genreTags],
      formTags: [...tags.formTags],
    },
  };

  return { book, kept: grounded.keep };
}

// ----- Bulk re-tag a single book -----

/**
 * Run /api/infer-tags against the book's current metadata and produce a
 * patch that updates the tag fields. If the user has manually edited
 * tags since the last inference, MERGE rather than replace: keep all
 * current user-curated tags, then add any newly-inferred tags that
 * aren't already present. Otherwise replace wholesale (the user hasn't
 * touched anything, so a fresh inference is strictly better).
 */
export async function retagBook(book: BookRecord): Promise<{
  ok: boolean;
  patch?: Partial<BookRecord>;
  error?: string;
}> {
  if (!book.title) return { ok: false, error: 'No title.' };
  let inferred: InferTagsResult;
  try {
    inferred = await inferTagsClient({
      title: book.title,
      author: book.author,
      isbn: book.isbn,
      publisher: book.publisher,
      publicationYear: book.publicationYear,
      lcc: book.lcc,
      // Bulk re-tag now also forwards stored enrichment fields when
      // they exist on the BookRecord (LCSH, DDC, synopsis, MARC 655
      // genre/form terms). Old records without enrichment hit the
      // model with the same payload as before.
      ddc: book.ddc,
      lcshSubjects: book.lcshSubjects,
      marcGenreTerms: book.marcGenres,
      synopsis: book.synopsis,
    });
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Tag inference failed.' };
  }

  // Detect whether the user has manually edited tags since the original
  // inference. The original.genreTags/formTags fields are populated for
  // books processed by v1.1 onward; older books in localStorage may not
  // have them — treat absent baselines as "untouched, replace freely".
  const baselineGenre = book.original.genreTags;
  const baselineForm = book.original.formTags;
  const userEditedGenre =
    baselineGenre !== undefined && !sameStringSet(book.genreTags, baselineGenre);
  const userEditedForm =
    baselineForm !== undefined && !sameStringSet(book.formTags, baselineForm);

  const finalGenre = userEditedGenre
    ? mergeUnique(book.genreTags, inferred.genreTags)
    : inferred.genreTags;
  const finalForm = userEditedForm
    ? mergeUnique(book.formTags, inferred.formTags)
    : inferred.formTags;

  return {
    ok: true,
    patch: {
      genreTags: finalGenre,
      formTags: finalForm,
      reasoning: inferred.reasoning,
      // Reset the tag baseline so subsequent re-tags compare against
      // this fresh inference, not the original from initial processing.
      original: {
        ...book.original,
        genreTags: [...inferred.genreTags],
        formTags: [...inferred.formTags],
      },
    },
  };
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  const merged = [...existing];
  for (const t of incoming) {
    if (!seen.has(t.toLowerCase())) {
      merged.push(t);
      seen.add(t.toLowerCase());
    }
  }
  return merged;
}

// ----- Manual add (used by "Add missing book" on Review) -----

export interface AddManualBookOptions {
  title: string;
  author: string;
  isbn?: string;
  sourcePhoto: string;
  batchLabel?: string;
  batchNotes?: string;
}

/**
 * Path B of "Add missing book": the user typed title + author (and
 * optionally an ISBN). Skip Pass B entirely — the user is the source of
 * truth. Run lookup + tag inference, return a fully-formed BookRecord.
 */
export async function addManualBook(opts: AddManualBookOptions): Promise<BookRecord> {
  const title = opts.title.trim();
  const author = opts.author.trim();
  const isbn = opts.isbn?.trim() || '';

  // Lookup: ISBN-scoped if provided, otherwise standard.
  let lookup: BookLookupResult = {
    isbn: '',
    publisher: '',
    publicationYear: 0,
    lcc: '',
    source: 'none',
  };
  if (title) {
    try {
      lookup = isbn
        ? await lookupBookClient(title, author, {
            matchEdition: true,
            hints: { isbn },
          })
        : await lookupBookClient(title, author);
    } catch {
      // ignore
    }
  }

  // Tag inference (always run — manual entry is a known good title/author).
  let tags: InferTagsResult = {
    genreTags: [],
    formTags: [],
    confidence: 'LOW',
    reasoning: '',
  };
  try {
    tags = await inferTagsClient({
      title,
      author,
      isbn: lookup.isbn || isbn,
      publisher: lookup.publisher,
      publicationYear: lookup.publicationYear,
      lcc: lookup.lcc,
      subjectHeadings: lookup.subjects,
      ddc: lookup.ddc,
      lcshSubjects: lookup.lcshSubjects,
      marcGenreTerms: lookup.marcGenres,
      synopsis: lookup.synopsis,
    });
  } catch {
    // ignore
  }

  const titleCased = toTitleCase(title);
  const finalIsbn = lookup.isbn || isbn;
  let finalLcc = lookup.lcc;
  let lccSource: BookRecord['lccSource'] = finalLcc ? lookup.lccSource ?? 'ol' : 'none';

  // Tier 6 inference for manual entries that come back without an LCC.
  if (!finalLcc && title && author) {
    try {
      const inferred = await inferLccClient({
        title,
        author,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
      });
      if (inferred.lcc && inferred.confidence !== 'LOW') {
        finalLcc = inferred.lcc;
        lccSource = 'inferred';
      }
    } catch {
      // ignore
    }
  }

  return {
    id: makeId(),
    spineRead: {
      position: 9999, // sort to the end of the batch
      rawText: `${title}${author ? ' — ' + author : ''}`,
      title,
      author,
      confidence: 'HIGH', // user-supplied
    },
    title: titleCased,
    author,
    authorLF: toAuthorLastFirst(author),
    isbn: finalIsbn,
    publisher: lookup.publisher,
    publicationYear: lookup.publicationYear,
    lcc: finalLcc,
    genreTags: tags.genreTags,
    formTags: tags.formTags,
    confidence: lookup.source === 'none' ? 'LOW' : tags.confidence,
    reasoning: tags.reasoning,
    status: 'pending',
    warnings:
      lookup.source === 'none'
        ? ['Manual entry — no metadata match. Verify title/author and edition fields.']
        : [],
    sourcePhoto: opts.sourcePhoto,
    batchLabel: opts.batchLabel,
    batchNotes: opts.batchNotes,
    lookupSource: lookup.source,
    ddc: lookup.ddc,
    lccSource,
    manuallyAdded: true,
    // Phase-3 enrichment passthrough — see addManualBook's sibling
    // construction site in buildBookFromCrop for the same pattern.
    canonicalTitle: lookup.canonicalTitle,
    subtitle: lookup.subtitle,
    allAuthors: lookup.allAuthors,
    synopsis: lookup.synopsis,
    pageCount: lookup.pageCount,
    edition: lookup.edition,
    binding: lookup.binding,
    language: lookup.language,
    series: lookup.series,
    lcshSubjects: lookup.lcshSubjects,
    marcGenres: lookup.marcGenres,
    coverUrlFallbacks: lookup.coverUrlFallbacks,
    original: {
      title: titleCased,
      author,
      isbn: finalIsbn,
      publisher: lookup.publisher,
      publicationYear: lookup.publicationYear,
      lcc: finalLcc,
      genreTags: [...tags.genreTags],
      formTags: [...tags.formTags],
    },
  };
}

// ----- Reread an existing book -----

export interface RereadOptions {
  /** Optional hint from the user: a known title (and maybe author) to skip Pass B entirely. */
  hint?: { title: string; author?: string };
  /** When no hint is provided, the existing OCR-quality crop is required. */
  ocrImage?: string;
  /**
   * Use the BookRecord's CURRENT (user-edited) title, author, year,
   * publisher, and ISBN to scope the lookup to a specific edition.
   * Skips Pass B entirely; trusts the user's edits as ground truth.
   */
  matchEdition?: boolean;
}

export interface RereadResult {
  ok: boolean;
  /** Patch to merge into the BookRecord via updateBook. */
  patch?: Partial<BookRecord>;
  error?: string;
}

/**
 * Re-run the per-book pipeline and return a patch.
 *
 * Two modes:
 *   - **Hint mode** (user typed a title): skip Pass B entirely, treat hint
 *     as ground truth, then run lookup + tag inference.
 *   - **AI retry mode** (no hint): re-run /api/read-spine on the stored
 *     OCR crop. Pass B is non-deterministic, so a fresh attempt frequently
 *     reads better than the first try.
 */
export async function rereadBook(
  current: BookRecord,
  options: RereadOptions
): Promise<RereadResult> {
  let title = '';
  let author = '';
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = current.confidence;
  let publisher = current.publisher;
  let lccFromSpine = '';
  // Step 2 sticker extractions captured during an AI-retry reread.
  // Empty strings when the reread used hint or matchEdition mode (Pass B
  // didn't run). Plumbed forward into tag inference + edition gap-fill
  // the same way buildBookFromCrop does.
  let rereadExtractedSeries = '';
  let rereadExtractedEdition = '';
  let rereadExtractedDdc = '';

  if (options.matchEdition) {
    // Trust the user's edited fields as ground truth. Skip Pass B.
    title = (current.title ?? '').trim();
    author = (current.author ?? '').trim();
    publisher = current.publisher;
    confidence = 'HIGH';
  } else if (options.hint?.title) {
    title = options.hint.title.trim();
    author = (options.hint.author ?? current.author ?? '').trim();
    // User-supplied → trust as HIGH; we'll demote later if lookup fails.
    confidence = 'HIGH';
  } else {
    // AI retry — needs the OCR crop.
    const img = options.ocrImage ?? current.ocrImage;
    if (!img) {
      return {
        ok: false,
        error:
          'Cannot rerun the AI read — the high-resolution crop was not preserved (re-upload the photo to recover this).',
      };
    }
    const { base64, mediaType } = ((): { base64: string; mediaType: string } => {
      const m = img.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) return { base64: img, mediaType: 'image/jpeg' };
      return { mediaType: m[1], base64: m[2] };
    })();
    // Use the same heuristic as initial processing. If we have a bbox
    // (recorded on the spine read), pick by area+aspect; if not, default
    // to Opus for safety on a manual reread.
    const initialModel: 's' | 'o' = current.spineRead.bbox
      ? pickSpineModel(current.spineRead.bbox)
      : 'o';
    let read = await readSpine({
      imageBase64: base64,
      mediaType,
      position: current.spineRead.position,
      model: initialModel === 's' ? 'sonnet' : 'opus',
    });
    if (initialModel === 's' && read.confidence === 'LOW') {
      const opusRead = await readSpine({
        imageBase64: base64,
        mediaType,
        position: current.spineRead.position,
        model: 'opus',
      });
      const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
      if (order[opusRead.confidence] >= order[read.confidence]) {
        read = opusRead;
      }
    }
    // Merge: user-edited fields always win over Pass B. Field is "edited"
    // if the current value differs from the original snapshot.
    const titleEdited = current.title !== current.original.title;
    const authorEdited = current.author !== current.original.author;
    const publisherEdited = current.publisher !== current.original.publisher;
    title = titleEdited ? current.title : read.title;
    author = authorEdited ? current.author : read.author;
    publisher = publisherEdited ? current.publisher : read.publisher || current.publisher;
    confidence = read.confidence;
    // Spine LCC: prefer the strict-stickered field when system='lcc';
    // fall back to the legacy `lcc` field otherwise. Same precedence as
    // buildBookFromCrop.
    const stickerLcc =
      read.extractedCallNumber && read.extractedCallNumberSystem === 'lcc'
        ? read.extractedCallNumber
        : '';
    lccFromSpine = stickerLcc || read.lcc || '';
    rereadExtractedSeries = read.extractedSeries ?? '';
    rereadExtractedEdition = read.extractedEdition ?? '';
    if (read.extractedCallNumber && read.extractedCallNumberSystem === 'ddc') {
      rereadExtractedDdc = read.extractedCallNumber;
    }
  }

  // Lookup
  let lookup: BookLookupResult = {
    isbn: '',
    publisher,
    publicationYear: 0,
    lcc: '',
    source: 'none',
  };
  // Use edition-scoped lookup when:
  //   - matchEdition was explicitly requested, OR
  //   - this is an AI retry where the user has edited year/publisher/ISBN
  //     (in which case those edits should bias the lookup toward the
  //     user's specific printing).
  const yearEdited = current.publicationYear !== current.original.publicationYear;
  const publisherEdited = current.publisher !== current.original.publisher;
  const isbnEdited = current.isbn !== current.original.isbn;
  const useEditionScoping =
    options.matchEdition || (!options.hint && (yearEdited || publisherEdited || isbnEdited));

  if (title) {
    try {
      const r = useEditionScoping
        ? await lookupBookClient(title, author, {
            matchEdition: true,
            hints: {
              year: current.publicationYear || undefined,
              publisher: current.publisher || undefined,
              isbn: current.isbn || undefined,
            },
          })
        : await lookupBookClient(title, author);
      lookup = { ...r, publisher: r.publisher || publisher };
    } catch {
      // ignore
    }
  }

  const grounded = groundSpineRead(
    { title, author, lcc: lccFromSpine, confidence },
    lookup
  );

  if (!grounded.keep) {
    // The reread produced something the filter would drop. Don't replace
    // the existing record with a worse one — surface the warnings instead.
    return {
      ok: false,
      error: grounded.warnings[0] ?? 'Reread did not produce a usable result.',
    };
  }

  let finalLcc = lccFromSpine || lookup.lcc;
  let lccSource: BookRecord['lccSource'] = lccFromSpine
    ? 'spine'
    : lookup.lcc
      ? lookup.lccSource ?? 'ol'
      : 'none';

  // DDC + edition gap-fills from the reread's sticker extractions.
  if (rereadExtractedDdc && !lookup.ddc) lookup.ddc = rereadExtractedDdc;
  if (rereadExtractedEdition && !lookup.edition) lookup.edition = rereadExtractedEdition;

  // Tier 6 inference (same fallback as buildBookFromCrop).
  if (!finalLcc && title && author) {
    try {
      const inferred = await inferLccClient({
        title,
        author,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
      });
      if (inferred.lcc && inferred.confidence !== 'LOW') {
        finalLcc = inferred.lcc;
        lccSource = 'inferred';
      }
    } catch {
      // ignore
    }
  }

  // Tag inference: ONLY when the user's current tag list is empty.
  // Otherwise their manual tag curation is authoritative — a reread is for
  // metadata fill-in, not retagging. (User can clear tags and reread to
  // force fresh inference.)
  const userHasNoTags =
    (current.genreTags?.length ?? 0) === 0 && (current.formTags?.length ?? 0) === 0;

  let tags: InferTagsResult | null = null;
  if (userHasNoTags) {
    try {
      tags = await inferTagsClient({
        title,
        author,
        isbn: lookup.isbn,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
        lcc: finalLcc,
        subjectHeadings: lookup.subjects,
        ddc: lookup.ddc,
        lcshSubjects: lookup.lcshSubjects,
        marcGenreTerms: lookup.marcGenres,
        extractedSeries: rereadExtractedSeries || undefined,
        synopsis: lookup.synopsis,
      });
    } catch {
      grounded.warnings.push('Tag inference failed.');
    }
  }

  const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  // If we ran tag inference, factor it in; otherwise use the grounded
  // confidence directly (don't penalize the user just because we skipped
  // tagging).
  const combinedConfidence = tags
    ? order[grounded.confidence] <= order[tags.confidence]
      ? grounded.confidence
      : tags.confidence
    : grounded.confidence;

  const titleCased = toTitleCase(title);

  // Build the patch surgically: include tag fields ONLY when we actually
  // ran fresh inference. Do NOT touch the `original` snapshot — that's the
  // baseline the BookCard's "edited" detection compares against, and
  // resetting it causes user edits to be lost on subsequent rereads (the
  // edit no longer differs from the new "original", so the next reread
  // overwrites it with the AI's stale read).
  const patch: Partial<BookRecord> = {
    title: titleCased,
    author,
    authorLF: toAuthorLastFirst(author),
    isbn: lookup.isbn,
    publisher: lookup.publisher,
    publicationYear: lookup.publicationYear,
    lcc: finalLcc,
    confidence: combinedConfidence,
    warnings: grounded.warnings,
    lookupSource: lookup.source,
    ddc: lookup.ddc,
    lccSource,
    coverUrl: lookup.coverUrl,
    // Phase-3 enrichment passthrough — surgical, only sets what the
    // lookup returned. undefined values won't overwrite existing data.
    canonicalTitle: lookup.canonicalTitle,
    subtitle: lookup.subtitle,
    allAuthors: lookup.allAuthors,
    synopsis: lookup.synopsis,
    pageCount: lookup.pageCount,
    edition: lookup.edition,
    binding: lookup.binding,
    language: lookup.language,
    series: lookup.series,
    lcshSubjects: lookup.lcshSubjects,
    marcGenres: lookup.marcGenres,
    coverUrlFallbacks: lookup.coverUrlFallbacks,
  };
  if (tags) {
    patch.genreTags = tags.genreTags;
    patch.formTags = tags.formTags;
    patch.reasoning = tags.reasoning;
  }

  return { ok: true, patch };
}

/**
 * Flag possible duplicates within a single photo without dropping any entries.
 * Pass A sometimes splits one spine into adjacent bboxes (producing two
 * records for the same book), but the user might also legitimately own two
 * copies of the same title (paperback + hardcover, gift + personal). We
 * never silently merge — instead we attach a `duplicateGroup` id and a
 * warning, and let the BookCard offer Merge / Keep-both actions.
 *
 * Group by normalized (title + author last name + ISBN). Both members of a
 * pair (and every member of a 3+ group) get the same `duplicateGroup` id
 * and a list of the other spine positions in the group.
 */
export function flagDuplicates(books: BookRecord[]): BookRecord[] {
  const groups = new Map<string, BookRecord[]>();

  for (const b of books) {
    const titleKey = normalize(b.title);
    const authorLast = normalize(b.author).split(' ').slice(-1)[0] ?? '';
    const isbnKey = b.isbn || '';
    // ISBN match alone is conclusive; otherwise group by title+last-name.
    const key = isbnKey || `${titleKey}|${authorLast}`;
    const existing = groups.get(key) ?? [];
    existing.push(b);
    groups.set(key, existing);
  }

  const out: BookRecord[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      // Solo entry — clear any prior duplicate flags so re-runs heal correctly.
      const b = group[0];
      const { duplicateGroup, duplicateOf, duplicateResolved, ...rest } = b;
      void duplicateGroup;
      void duplicateOf;
      void duplicateResolved;
      out.push(rest as BookRecord);
      continue;
    }
    const groupId = `dup-${Math.random().toString(36).slice(2, 10)}`;
    const positions = group.map((b) => b.spineRead.position).sort((a, b) => a - b);
    const positionsLabel = positions.map((p) => `#${p}`).join(' and ');
    for (const b of group) {
      const others = positions.filter((p) => p !== b.spineRead.position);
      const warning = `Possible duplicate — same title found at spine ${positionsLabel}. Merge or keep both?`;
      const filteredWarnings = b.warnings.filter(
        (w) => !/^possible duplicate\b/i.test(w) && !/^detector returned\b/i.test(w)
      );
      out.push({
        ...b,
        duplicateGroup: groupId,
        duplicateOf: others,
        duplicateResolved: undefined,
        warnings: [...filteredWarnings, warning],
      });
    }
  }
  return out.sort((a, b) => a.spineRead.position - b.spineRead.position);
}
