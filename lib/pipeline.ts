import type {
  BookRecord,
  InferTagsResult,
  BookLookupResult,
  SpineRead,
  SpineBbox,
} from './types';
import { toAuthorLastFirst, toTitleCase } from './csv-export';

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
}

export async function readSpine(args: {
  imageBase64: string;
  mediaType: string;
  position: number;
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

export async function inferTagsClient(args: {
  title: string;
  author: string;
  isbn?: string;
  publisher?: string;
  publicationYear?: number;
  lcc?: string;
  subjectHeadings?: string[];
}): Promise<InferTagsResult> {
  const res = await fetch('/api/infer-tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
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
}

export interface BuiltBook {
  book: BookRecord;
  /** True when the entry survived the hallucination filter. */
  kept: boolean;
}

export async function buildBookFromCrop(opts: BuildBookOptions): Promise<BuiltBook> {
  const { position, bbox, spineThumbnail, sourcePhoto, ocrCrop } = opts;
  const { base64, mediaType } = dataUriToBase64Parts(ocrCrop);

  // Pass B — read the spine with Opus. (Sonnet was tried as a cheaper
  // first tier but produced confident hallucinations on hard spines —
  // reverted in favor of accuracy.)
  const read = await readSpine({ imageBase64: base64, mediaType, position });

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

  // Spine-printed LCC wins over the lookup-derived one — it's the LoC's
  // own classification for the exact physical edition the user owns.
  const finalLcc = read.lcc || lookup.lcc;
  const lccSource: 'spine' | 'lookup' | 'none' = read.lcc
    ? 'spine'
    : lookup.lcc
      ? 'lookup'
      : 'none';

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
  if (grounded.keep && read.title && lookup.source !== 'none') {
    try {
      tags = await inferTagsClient({
        title: read.title,
        author: read.author,
        isbn: lookup.isbn,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
        lcc: finalLcc,
        subjectHeadings: lookup.subjects,
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

  const book: BookRecord = {
    id: makeId(),
    spineRead,
    title: titleCased,
    author: read.author,
    authorLF: toAuthorLastFirst(read.author),
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
    lookupSource: lookup.source,
    lccSource,
    spineThumbnail,
    ocrImage: ocrCrop,
    original: {
      title: titleCased,
      author: read.author,
      isbn: lookup.isbn,
      publisher: lookup.publisher,
      publicationYear: lookup.publicationYear,
      lcc: finalLcc,
    },
  };

  return { book, kept: grounded.keep };
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
    const read = await readSpine({
      imageBase64: base64,
      mediaType,
      position: current.spineRead.position,
    });
    title = read.title;
    author = read.author;
    publisher = read.publisher || current.publisher;
    confidence = read.confidence;
    lccFromSpine = read.lcc || '';
  }

  // Lookup
  let lookup: BookLookupResult = {
    isbn: '',
    publisher,
    publicationYear: 0,
    lcc: '',
    source: 'none',
  };
  if (title) {
    try {
      const r = options.matchEdition
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

  const finalLcc = lccFromSpine || lookup.lcc;
  const lccSource: 'spine' | 'lookup' | 'none' = lccFromSpine
    ? 'spine'
    : lookup.lcc
      ? 'lookup'
      : 'none';

  // Tag inference — skip when lookup completely failed (same rationale as
  // first-pass: noisy tags from title-alone aren't worth the call).
  let tags: InferTagsResult = {
    genreTags: [],
    formTags: [],
    confidence: 'LOW',
    reasoning: '',
  };
  if (lookup.source !== 'none') {
    try {
      tags = await inferTagsClient({
        title,
        author,
        isbn: lookup.isbn,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
        lcc: finalLcc,
        subjectHeadings: lookup.subjects,
      });
    } catch {
      grounded.warnings.push('Tag inference failed.');
    }
  }

  const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  const combinedConfidence =
    order[grounded.confidence] <= order[tags.confidence]
      ? grounded.confidence
      : tags.confidence;

  const titleCased = toTitleCase(title);

  return {
    ok: true,
    patch: {
      title: titleCased,
      author,
      authorLF: toAuthorLastFirst(author),
      isbn: lookup.isbn,
      publisher: lookup.publisher,
      publicationYear: lookup.publicationYear,
      lcc: finalLcc,
      genreTags: tags.genreTags,
      formTags: tags.formTags,
      confidence: combinedConfidence,
      reasoning: tags.reasoning,
      warnings: grounded.warnings,
      lookupSource: lookup.source,
      lccSource,
      // Reset the "modified" baseline so the dots reflect changes from the new read.
      original: {
        title: titleCased,
        author,
        isbn: lookup.isbn,
        publisher: lookup.publisher,
        publicationYear: lookup.publicationYear,
        lcc: finalLcc,
      },
    },
  };
}

/**
 * Deduplicate books from a single photo. Pass A sometimes splits a single
 * spine into 2–3 adjacent bboxes (especially tall spines with author/title
 * stacked vertically), which produces multiple BookRecords for the same book.
 *
 * Group by normalized (title + author last name + ISBN). Within a group,
 * keep the highest-confidence entry and merge warnings.
 */
export function dedupeBooks(books: BookRecord[]): BookRecord[] {
  const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
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
      out.push(group[0]);
      continue;
    }
    // Pick the entry with highest confidence; ties broken by spine position.
    const winner = group.reduce((best, b) => {
      if (order[b.confidence] > order[best.confidence]) return b;
      if (
        order[b.confidence] === order[best.confidence] &&
        b.spineRead.position < best.spineRead.position
      )
        return b;
      return best;
    });
    const mergedWarnings = Array.from(
      new Set([
        ...winner.warnings,
        `Detector returned ${group.length} bounding boxes for this book — duplicates merged.`,
      ])
    );
    out.push({ ...winner, warnings: mergedWarnings });
  }
  return out.sort((a, b) => a.spineRead.position - b.spineRead.position);
}
