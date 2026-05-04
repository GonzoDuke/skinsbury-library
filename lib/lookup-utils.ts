/**
 * Env-free lookup helpers shared between the server lookup cascade
 * (lib/book-lookup.ts) and the client-bundled barcode-scan flow
 * (lib/scan-pipeline.ts). Anything that touches `process.env` for an
 * API key MUST stay out of this module — keeping that boundary clean
 * is what guarantees server-only secret names never leak into the
 * client bundle through transitive imports.
 *
 * The LoC SRU endpoint is fully public (no key, no auth) so this is
 * safe to call from the browser.
 */

const UA = 'Carnegie/1.0 (personal cataloging tool)';

const LOC_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/xml',
};

/**
 * Damerau-flavored Levenshtein distance via the standard rolling-row
 * matrix. Quadratic in min(len(a), len(b)) — fine for book titles
 * (typically <100 chars). Returns the number of single-character
 * insertions, deletions, or substitutions to turn `a` into `b`.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Always iterate over the shorter string for the inner loop.
  let s = a.length < b.length ? a : b;
  let t = a.length < b.length ? b : a;
  const m = s.length;
  const n = t.length;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    const tj = t.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const cost = s.charCodeAt(i - 1) === tj ? 0 : 1;
      const del = curr[i - 1] + 1;
      const ins = prev[i] + 1;
      const sub = prev[i - 1] + cost;
      curr[i] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

/**
 * Normalized 0..1 string similarity. 1 = identical, 0 = completely
 * different. Calculated as `1 - distance / max(len)`. Caller should
 * lowercase / strip punctuation before comparing if loose-match
 * semantics are wanted.
 */
export function stringSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshteinDistance(a, b) / max;
}

/**
 * Strip characters that mangle external API queries — wildcards (*),
 * mentions (@), hashes (#), shell-y money signs ($), exclamation
 * marks (!) — and collapse runs of whitespace. Used by lookupBook
 * to clean spine-read titles like "Holy Sh*t" before they hit OL,
 * Google Books, ISBNdb, or Wikidata, where a literal `*` becomes a
 * wildcard or breaks the SPARQL CONTAINS filter.
 */
export function sanitizeForSearch(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\*@#\$!]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Static DDC→LCC class-letter crosswalk. Loaded once at module-load
 * via direct JSON import (Next ships JSON bundles fine, no fs needed).
 * Map shape: 3-digit DDC class string (e.g. "823") → { lccLetter, confidence }.
 */
import ddcToLccTable from './ddc-to-lcc.json';

interface DdcLccEntry {
  lccLetter: string;
  confidence: 'high' | 'medium';
}
const DDC_TO_LCC_MAP = ddcToLccTable as unknown as Record<string, DdcLccEntry>;

/**
 * Derive an LCC class letter from a DDC value. Returns null when the
 * DDC string is empty / unparseable / not in the mapping. Class-letter
 * only — Carnegie uses the result as a domain anchor, not a full call
 * number, so we can't synthesize a cutter.
 *
 * Strategy:
 *   1. Strip a leading subject-class prefix (some ISBNdb DDCs start
 *      with letters like "F " for fiction). Then scan for the leading
 *      3-digit Dewey class.
 *   2. Look up the exact 3-digit key (e.g. "823" → "PR").
 *   3. If miss, fall back to the tens key (e.g. "823" → "820" → "PR").
 *   4. If still miss, return null.
 *
 * The caller should write the derived letter into a `lccDerivedFromDdc`
 * field, NOT the regular `lcc` field — keep authoritative LCC distinct
 * from class-letter inferences so the Review surface can flag which
 * is which.
 */
export function deriveLccFromDdc(
  ddc: string | undefined | null
): { lccLetter: string; confidence: 'high' | 'medium' } | null {
  if (!ddc) return null;
  // Find the first 3-digit run that starts with a digit. Handles
  //   "823.912"  → "823"
  //   "F 813.54" → "813"
  //   "973"      → "973"
  //   "92 K"     → "920" via tens-fallback below
  const match = ddc.match(/(\d{3})/);
  if (!match) {
    // Try a 2-digit prefix (some old ISBNdb records use "92" for
    // biography rather than "920"). Promote to the 3-digit hundreds
    // key by appending "0".
    const two = ddc.match(/(\d{2})/);
    if (!two) return null;
    const hundredsKey = `${two[1]}0`;
    const hit = DDC_TO_LCC_MAP[hundredsKey];
    return hit ? { lccLetter: hit.lccLetter, confidence: hit.confidence } : null;
  }
  const exactKey = match[1];
  const exact = DDC_TO_LCC_MAP[exactKey];
  if (exact) return { lccLetter: exact.lccLetter, confidence: exact.confidence };
  // Fall back to the tens key (round down to the nearest 10).
  const tensKey = `${exactKey.slice(0, 2)}0`;
  const tens = DDC_TO_LCC_MAP[tensKey];
  if (tens) return { lccLetter: tens.lccLetter, confidence: tens.confidence };
  return null;
}

/**
 * Open Library returns LCC in a padded internal form like
 *   "BL-0053.00000000.J36 2012"
 *   "Q--0335.00000000.M6 2024"
 *   "E--0169.12000000.K556 2022"
 * Convert to canonical Library of Congress format:
 *   "BL53 .J36 2012", "Q335 .M6 2024", "E169.12 .K556 2022".
 *
 * Inputs already in canonical or unparseable form pass through trimmed.
 */
export function normalizeLcc(s: string | undefined | null): string {
  if (!s) return '';
  const m = s.match(/^([A-Z]{1,3})[-\s]+(\d+)\.(\d+)\.(.+)$/);
  if (!m) return s.trim();
  const klass = m[1];
  const intPart = String(parseInt(m[2], 10));
  const decPart = m[3].replace(/0+$/, '');
  const num = decPart ? `${intPart}.${decPart}` : intPart;
  const cutter = m[4].trim();
  return `${klass}${num} .${cutter}`;
}

/**
 * Library of Congress SRU lookup by ISBN. Returns canonical-format LCC
 * or empty string. Free, no API key, ~0.5–2s typical.
 *
 * Example response (excerpted):
 *   <datafield tag="050" ind1="0" ind2="0">
 *     <subfield code="a">CT275.H62575</subfield>
 *     <subfield code="b">A3 2010</subfield>
 *   </datafield>
 */
async function loFetch050(url: string, timeoutMs: number): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      headers: LOC_HEADERS,
    });
    if (!res.ok) return '';
    const xml = await res.text();
    const fieldMatch = xml.match(
      /<datafield[^>]*tag="050"[^>]*>([\s\S]*?)<\/datafield>/
    );
    if (!fieldMatch) return '';
    const block = fieldMatch[1];
    const a = block.match(/<subfield[^>]*code="a"[^>]*>([^<]+)<\/subfield>/)?.[1]?.trim() ?? '';
    const b = block.match(/<subfield[^>]*code="b"[^>]*>([^<]+)<\/subfield>/)?.[1]?.trim() ?? '';
    return [a, b].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

export async function lookupLccByIsbn(isbn: string): Promise<string> {
  if (!isbn) return '';
  const cleaned = isbn.replace(/[^\dxX]/g, '');
  if (!cleaned) return '';
  const url =
    `https://lx2.loc.gov/sru/voyager?version=1.1&operation=searchRetrieve` +
    `&query=bath.isbn=${cleaned}&maximumRecords=1&recordSchema=marcxml`;
  return loFetch050(url, 8000);
}

/**
 * Richer MARC fetch by ISBN. Returns LCC, DDC (082), LCSH subject
 * headings (600/610/611/630/650/651), main author (100), title
 * statement (245), publisher (264 b / 260 b), edition (250), page
 * count parsed from physical description (300 a), and added-entry
 * co-authors (700/710).
 *
 * The existing string-returning lookupLccByIsbn is intentionally
 * kept untouched alongside this — every existing caller's signature
 * stays exactly the same. New callers that want MARC enrichment use
 * this helper.
 */
export interface MarcResult {
  lcc: string | null;
  ddc: string | null;
  lcshSubjects: string[];
  /** MARC 655 — Index Term — Genre/Form. Distinct from LCSH (subject) —
   *  this is what KIND of work it is (e.g. "Detective and mystery
   *  fiction", "Bildungsromans", "Festschriften", "Cookbooks"). */
  marcGenres: string[];
  author: string | null;
  title: string | null;
  publisher: string | null;
  pageCount: number | null;
  edition: string | null;
  coAuthors: string[];
}

const LOC_HEADERS_MARC: Record<string, string> = {
  'User-Agent': 'Carnegie/1.0 (personal cataloging tool)',
  Accept: 'application/xml',
};

function marcDatafields(xml: string, tag: string): string[] {
  const re = new RegExp(
    `<datafield[^>]*tag="${tag}"[^>]*>([\\s\\S]*?)<\\/datafield>`,
    'g'
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function marcSubfield(block: string, code: string): string {
  const m = block.match(
    new RegExp(`<subfield[^>]*code="${code}"[^>]*>([^<]*)<\\/subfield>`)
  );
  return m ? m[1].trim() : '';
}

function marcSubfieldsAll(block: string): string[] {
  const re = /<subfield[^>]*code="[^"]*"[^>]*>([^<]*)<\/subfield>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  return out;
}

function trimTrailingPunct(s: string): string {
  return s.replace(/[\s,;:./]+$/, '').trim();
}

export async function lookupFullMarcByIsbn(
  isbn: string
): Promise<MarcResult | null> {
  if (!isbn) return null;
  const cleaned = isbn.replace(/[^\dxX]/g, '');
  if (!cleaned) return null;
  const url =
    `https://lx2.loc.gov/sru/voyager?version=1.1&operation=searchRetrieve` +
    `&query=bath.isbn=${cleaned}&maximumRecords=1&recordSchema=marcxml`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      headers: LOC_HEADERS_MARC,
    });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!/<record\b/.test(xml)) return null;

    // 050 — LCC: subfield a + b joined.
    const lcc050 = marcDatafields(xml, '050')[0] ?? '';
    const lccA = marcSubfield(lcc050, 'a');
    const lccB = marcSubfield(lcc050, 'b');
    const lcc = [lccA, lccB].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null;

    // 082 — DDC: subfield a.
    const ddcBlock = marcDatafields(xml, '082')[0] ?? '';
    const ddc = marcSubfield(ddcBlock, 'a') || null;

    // 100 — main personal-author entry: subfield a.
    const authorBlock = marcDatafields(xml, '100')[0] ?? '';
    const author = marcSubfield(authorBlock, 'a')
      ? trimTrailingPunct(marcSubfield(authorBlock, 'a'))
      : null;

    // 245 — title statement: a + b.
    const titleBlock = marcDatafields(xml, '245')[0] ?? '';
    const titleA = marcSubfield(titleBlock, 'a');
    const titleB = marcSubfield(titleBlock, 'b');
    const titleRaw = [titleA, titleB].filter(Boolean).join(' ');
    const title = titleRaw ? trimTrailingPunct(titleRaw) : null;

    // 264 (preferred) / 260 — publisher subfield b.
    const pubBlock = marcDatafields(xml, '264')[0] ?? marcDatafields(xml, '260')[0] ?? '';
    const publisher = pubBlock
      ? trimTrailingPunct(marcSubfield(pubBlock, 'b')) || null
      : null;

    // 250 — edition statement subfield a.
    const editionBlock = marcDatafields(xml, '250')[0] ?? '';
    const edition = marcSubfield(editionBlock, 'a')
      ? trimTrailingPunct(marcSubfield(editionBlock, 'a'))
      : null;

    // 300 — physical description; pageCount from subfield a. Match both
    // "384 p." and "vii, 384 pages" (with/without period, singular/plural,
    // case-insensitive). The previous /(\d{2,4})\s*p\.?/ regex required
    // the trailing dot and missed common LoC formatting.
    const physBlock = marcDatafields(xml, '300')[0] ?? '';
    const physA = marcSubfield(physBlock, 'a');
    const pageMatch = physA.match(/(\d{2,4})\s*(?:p\.?|pages?)\b/i);
    const pageCount = pageMatch ? parseInt(pageMatch[1], 10) || null : null;

    // 600/610/611/630/650/651 — LCSH subject headings. Concatenate all
    // subfields per datafield; cap at 25 to stay well under any prompt budget.
    const subjectTags = ['600', '610', '611', '630', '650', '651'];
    const lcshSubjects: string[] = [];
    for (const t of subjectTags) {
      for (const block of marcDatafields(xml, t)) {
        const subs = marcSubfieldsAll(block).map(trimTrailingPunct).filter(Boolean);
        if (subs.length > 0) lcshSubjects.push(subs.join(' — '));
      }
    }
    const dedupedLcsh = Array.from(new Set(lcshSubjects)).slice(0, 25);

    // 655 — Index Term — Genre/Form. Cataloger-applied explicit genre
    // vocabulary. We read subfield $a (the term itself) only; trailing
    // subfields like $2 (source vocabulary) and $5 (institution) are
    // not signal for tag inference. Capped at 15 — these are usually
    // 1–3 per book, so the cap is a safety belt, not a hot path.
    const marcGenres: string[] = [];
    for (const block of marcDatafields(xml, '655')) {
      const a = marcSubfield(block, 'a');
      if (a) {
        const cleaned = trimTrailingPunct(a);
        if (cleaned) marcGenres.push(cleaned);
      }
    }
    const dedupedMarcGenres = Array.from(new Set(marcGenres)).slice(0, 15);

    // 700/710 — added entries (co-authors / corporate co-authors).
    const coAuthors: string[] = [];
    for (const t of ['700', '710']) {
      for (const block of marcDatafields(xml, t)) {
        const a = marcSubfield(block, 'a');
        if (a) coAuthors.push(trimTrailingPunct(a));
      }
    }
    const dedupedCoAuthors = Array.from(new Set(coAuthors)).slice(0, 10);

    return {
      lcc,
      ddc,
      lcshSubjects: dedupedLcsh,
      marcGenres: dedupedMarcGenres,
      author,
      title,
      publisher,
      pageCount,
      edition,
      coAuthors: dedupedCoAuthors,
    };
  } catch {
    return null;
  }
}

/**
 * Tier 5: LoC SRU by title + author. Best-effort — the LoC endpoint is
 * occasionally slow/flaky on text queries; tight timeout, fall through
 * silently on miss or timeout.
 */
export async function lookupLccByTitleAuthor(title: string, author: string): Promise<string> {
  const t = (title ?? '').trim();
  const a = (author ?? '').trim();
  if (!t || !a) return '';
  const cql = `bath.title=${JSON.stringify(t)} AND bath.author=${JSON.stringify(a)}`;
  const url =
    `https://lx2.loc.gov/sru/voyager?version=1.1&operation=searchRetrieve` +
    `&query=${encodeURIComponent(cql)}&maximumRecords=1&recordSchema=marcxml`;
  return loFetch050(url, 7000);
}
