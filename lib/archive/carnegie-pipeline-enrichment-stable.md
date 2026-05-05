# Carnegie — pipeline data enrichment (stability-first)

## Ground rules

These rules override everything else in this document:

1. **No existing function signatures change.** If a function currently returns `string | null`, it still returns `string | null`. Create new functions alongside old ones. Migrate callers gradually.
2. **Every new field is optional with a default.** Old data from localStorage and GitHub will not have new fields. Every read of a new field must use optional chaining and a fallback: `book.pageCount ?? null`, `book.lcshSubjects ?? []`.
3. **Every commit must pass `npm run build` with zero errors AND the app must load correctly with old localStorage data still present.** Test this explicitly: don't clear localStorage between commits.
4. **No existing behavior changes unless explicitly stated.** If the Review screen currently shows the spine-read title, it keeps showing the spine-read title until a specific commit says otherwise. No silent side effects.
5. **If a section feels risky, add it behind a feature flag.** `const USE_CANONICAL_TITLES = true;` at the top of the file. Easy to flip off if something breaks.

---

## Phase 1: Expand the containers (zero behavioral change)

### Commit 1: Add new optional fields to types

In `lib/types.ts`, add these fields to `BookLookupResult`. All optional, all with `?`:

```typescript
// Add to BookLookupResult — all optional
canonicalTitle?: string;
canonicalAuthor?: string;
allAuthors?: string[];
subtitle?: string;
synopsis?: string;
pageCount?: number;
edition?: string;
binding?: string;
language?: string;
series?: string;
lcshSubjects?: string[];
coverUrlFallbacks?: string[];
```

In `lib/types.ts`, add matching optional fields to `BookRecord`:

```typescript
// Add to BookRecord — all optional
canonicalTitle?: string;
subtitle?: string;
allAuthors?: string[];
synopsis?: string;
pageCount?: number;
edition?: string;
binding?: string;
language?: string;
series?: string;
lcshSubjects?: string[];
coverUrlFallbacks?: string[];
```

**What this commit does:** Nothing behavioral. Just adds optional fields that default to undefined. Old data loads fine because the fields are optional. No component reads them yet.

**Test:** Load the app with existing localStorage data. Everything works exactly as before. `npm run build` clean.

---

## Phase 2: Extract more data from APIs (additive only)

Each commit below adds data extraction WITHOUT changing any existing behavior. The new data lands in the new optional fields. Nothing reads it yet.

### Commit 2: Sanitize special characters

Create a new function in `lib/lookup-utils.ts`:

```typescript
export function sanitizeForSearch(text: string): string {
  return text.replace(/[\*@#\$!]/g, '').replace(/\s{2,}/g, ' ').trim();
}
```

In `lib/book-lookup.ts`, at the top of `lookupBook()`, create sanitized copies of title and author. Use the sanitized copies for all API queries. Do NOT modify the original `title` and `author` parameters — those still flow through unchanged.

```typescript
const searchTitle = sanitizeForSearch(title);
const searchAuthor = sanitizeForSearch(author);
// Pass searchTitle/searchAuthor to API calls
// Pass original title/author everywhere else
```

**What this commit does:** Queries are cleaner. Results are potentially better. No existing behavior changes — if queries were working before with special characters, they still work. If they were failing, they might now succeed.

**Test:** Process "Holy Sh*t" — does it match better now? Existing books unaffected.

### Commit 3: Extract more from Open Library

In the existing `tryOpenLibrary` function, after the existing extraction code, add:

```typescript
// New extractions — additive only, don't touch existing fields
result.canonicalTitle = best.title || undefined;
result.canonicalAuthor = best.author_name?.[0] || undefined;
result.allAuthors = best.author_name || undefined;
```

Add `number_of_pages_median` to OL_FIELDS. After extraction:

```typescript
result.pageCount = best.number_of_pages_median || undefined;
```

In the work record fetch (already happening for LCC), add after the existing LCC extraction:

```typescript
result.synopsis = typeof workData.description === 'string' 
  ? workData.description 
  : workData.description?.value || undefined;
```

**What this commit does:** More data lands on BookLookupResult. Nothing reads it yet downstream. Existing fields unchanged.

**Test:** Process a book. Check the dev console lookup log. New fields should appear in the result. App behavior identical.

### Commit 4: Extract more from ISBNdb

In `lib/book-lookup.ts`, update the `IsbndbBook` interface to add the missing fields — `edition`, `pages`, `binding`, `synopsis`, `language`. All optional with `?`.

In `isbndbBookToHit`, add extraction for the new fields into a new `IsbndbHit` extension (or add optional fields to the existing IsbndbHit):

```typescript
// Add to IsbndbHit interface — all optional
edition?: string;
pages?: number;
binding?: string;
synopsis?: string;
language?: string;
allAuthors?: string[];
```

In the mapper:
```typescript
hit.edition = b.edition || undefined;
hit.pages = b.pages || undefined;
hit.binding = b.binding || undefined;
hit.synopsis = b.synopsis || undefined;
hit.language = b.language || undefined;
hit.allAuthors = b.authors || undefined;
```

In the `lookupBook` ISBNdb merge block, add after existing merges:

```typescript
// New field merges — only fill if empty
result.canonicalTitle = result.canonicalTitle || isbndbHit.title || undefined;
result.canonicalAuthor = result.canonicalAuthor || isbndbHit.allAuthors?.[0] || undefined;
result.allAuthors = result.allAuthors || isbndbHit.allAuthors || undefined;
result.synopsis = result.synopsis || isbndbHit.synopsis || undefined;
result.pageCount = result.pageCount || isbndbHit.pages || undefined;
result.edition = isbndbHit.edition || undefined;
result.binding = isbndbHit.binding || undefined;
result.language = result.language || isbndbHit.language || undefined;
if (isbndbHit.coverUrl) {
  result.coverUrlFallbacks = result.coverUrlFallbacks || [];
  result.coverUrlFallbacks.push(isbndbHit.coverUrl);
}
```

**What this commit does:** ISBNdb data now fully extracted. Nothing reads the new fields yet. Existing behavior unchanged.

**Test:** Process a book. Check console log. ISBNdb fields populated. App behavior identical.

### Commit 5: Extract more from LoC MARC records

**DO NOT change the existing function signatures.** Instead, create a NEW function alongside the old ones:

```typescript
// Keep existing — unchanged:
export async function lookupLccByIsbn(isbn: string): Promise<string | null> { ... }

// Add new — richer extraction:
export async function lookupFullMarcByIsbn(isbn: string): Promise<MarcResult | null> { ... }

interface MarcResult {
  lcc: string | null;
  ddc: string | null;
  lcshSubjects: string[];
  author: string | null;
  title: string | null;
  publisher: string | null;
  pageCount: number | null;
  edition: string | null;
  coAuthors: string[];
}
```

The new function can internally call the same LoC SRU endpoint but parse more MARC fields. The old function continues to work exactly as before — nothing that calls it breaks.

In `lookupBook`, add a call to the new function AFTER the existing LoC calls:

```typescript
// Existing LoC call — unchanged
// ... existing code ...

// New: if we have an ISBN and want richer LoC data
if (result.isbn && !result.lcshSubjects?.length) {
  try {
    const marc = await lookupFullMarcByIsbn(result.isbn);
    if (marc) {
      result.lcshSubjects = marc.lcshSubjects;
      result.ddc = result.ddc || marc.ddc || undefined;
      result.pageCount = result.pageCount || marc.pageCount || undefined;
      result.edition = result.edition || marc.edition || undefined;
      result.canonicalAuthor = result.canonicalAuthor || marc.author || undefined;
      if (marc.coAuthors?.length) {
        result.allAuthors = result.allAuthors || [];
        result.allAuthors.push(...marc.coAuthors);
      }
    }
  } catch (e) {
    // Silent fail — this is enrichment, not critical path
    console.warn('[loc-marc] enrichment failed:', e);
  }
}
```

Wrap in try/catch so a failure here never crashes the pipeline.

**What this commit does:** LCSH subject headings and other MARC data now extracted. Old LoC functions untouched. Pipeline resilient to failures.

**Test:** Process a book with a known ISBN. Check console. LCSH subjects should appear. Old behavior unchanged. Deliberately test with a bad ISBN — should fail silently.

### Commit 6: Expand Wikidata SPARQL query

Update the SPARQL query string in `lookupWikidata` to add genre, subject, pages, and series. Add the new OPTIONAL clauses to the existing query.

Extract the new fields into the result using the same optional pattern:

```typescript
result.pageCount = result.pageCount || parseInt(binding.pages?.value) || undefined;
result.series = binding.seriesLabel?.value || undefined;
if (binding.genreLabel?.value) {
  result.subjects = result.subjects || [];
  result.subjects.push(binding.genreLabel.value);
}
if (binding.subjectLabel?.value) {
  result.subjects = result.subjects || [];
  result.subjects.push(binding.subjectLabel.value);
}
```

Also: apply `sanitizeForSearch` to the title in the SPARQL CONTAINS filter so special characters don't break the query.

**What this commit does:** Wikidata returns more data. Existing Wikidata behavior unchanged for the fields it already extracts.

**Test:** Process a book that Wikidata has. Check console for genre/subject/series. Existing behavior identical.

---

## Phase 3: Use the new data (behavioral changes — one at a time)

Each commit below turns on one new behavior. If anything breaks, the previous commits are all safe to keep and this commit can be reverted independently.

### Commit 7: Show new data in the Review detail panel

In the expanded detail row (BookTableRow and MobileBookCard), add new rows for data that exists on the BookRecord:

```tsx
{book.pageCount && <div><span className="d-label">Pages</span><div className="d-val">{book.pageCount}</div></div>}
{book.edition && <div><span className="d-label">Edition</span><div className="d-val">{book.edition}</div></div>}
{book.binding && <div><span className="d-label">Binding</span><div className="d-val">{book.binding}</div></div>}
{book.language && book.language !== 'en' && <div><span className="d-label">Language</span><div className="d-val">{book.language}</div></div>}
{book.synopsis && <div className="synopsis"><span className="d-label">Synopsis</span><div className="d-val">{book.synopsis.slice(0, 200)}...</div></div>}
{book.lcshSubjects?.length > 0 && <div><span className="d-label">LCSH</span><div className="d-val">{book.lcshSubjects.join('; ')}</div></div>}
{book.allAuthors?.length > 1 && <div><span className="d-label">All authors</span><div className="d-val">{book.allAuthors.join('; ')}</div></div>}
```

Every line uses conditional rendering — if the field is null/undefined/empty, the row doesn't render. Old books without these fields display exactly as they do now.

**What this commit does:** Detail panel shows richer data when available. Old books look the same. No data flow changes.

**Test:** Expand a recently processed book — new fields visible. Expand an old book — looks the same as before. Phone layout — no overflow.

### Commit 8: Feed LCSH and synopsis to tag inference

In `/api/infer-tags/route.ts`, update the prompt construction to include new data when available:

```typescript
// Add to the user message, after existing fields:
${lcshSubjects?.length ? `LCSH subject headings: ${lcshSubjects.join('; ')}` : ''}
${ddc ? `DDC: ${ddc}` : ''}
${synopsis ? `Synopsis (first 300 chars): ${synopsis.slice(0, 300)}` : ''}
```

Add to the system prompt:

```
When LCSH (Library of Congress Subject Headings) are provided, treat them as the most
authoritative signal for tag assignment. They are assigned by professional catalogers.
When a synopsis is provided, use it to disambiguate subject matter — especially for
books whose titles don't clearly indicate their content.
```

**What this commit does:** Tag inference gets richer input. Results should be more accurate. Books without LCSH/synopsis get the same inference as before — the prompt lines are conditional.

**Test:** Process a book that has LCSH data. Compare tags to a book without LCSH. The LCSH book should have more precise tags. Old books re-tagged via bulk re-tag should also benefit.

### Commit 9: Canonical title/author override (behind feature flag)

This is the riskiest change. Put it behind a flag.

At the top of `lib/pipeline.ts`:

```typescript
const USE_CANONICAL_TITLES = true; // flip to false if anything breaks
```

In `buildBookFromCrop` and all other BookRecord construction points:

```typescript
if (USE_CANONICAL_TITLES && lookup.canonicalTitle && lookup.source !== 'none') {
  book.canonicalTitle = lookup.canonicalTitle;
  // Show canonical title as the display title
  book.title = lookup.canonicalTitle;
  // Preserve original spine read in spineRead.rawText (already there)
} else {
  book.title = spineRead.title; // existing behavior
}

// Same pattern for author
if (USE_CANONICAL_TITLES && lookup.canonicalAuthor && lookup.source !== 'none') {
  book.author = lookup.canonicalAuthor;
}

// Multi-author
if (lookup.allAuthors?.length) {
  book.allAuthors = lookup.allAuthors;
  // Format for LT
  book.authorLF = lookup.allAuthors.map(name => {
    if (name.includes(',')) return name.trim();
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    const last = parts.pop();
    return `${last}, ${parts.join(' ')}`;
  }).join('; ');
}
```

**What this commit does:** Book titles and authors now come from databases when available. The feature flag lets you turn this off instantly if something looks wrong.

**Test:** Process a shelf photo. Titles should be properly formatted (full titles with subtitles, correct capitalization). Authors should have full names, not just what the OCR caught. Flip `USE_CANONICAL_TITLES = false` — behavior reverts to spine-read titles. Flip it back.

### Commit 10: Cover URL fallback chain

Update the cover URL assignment in `lookupBook` to collect all candidates:

```typescript
result.coverUrlFallbacks = [];
if (result.isbn) {
  result.coverUrlFallbacks.push(`https://covers.openlibrary.org/b/isbn/${result.isbn}-M.jpg?default=false`);
}
if (gbCoverUrl) result.coverUrlFallbacks.push(gbCoverUrl);
if (isbndbCoverUrl) result.coverUrlFallbacks.push(isbndbCoverUrl);
// Keep existing coverUrl assignment as-is for backward compatibility
result.coverUrl = result.coverUrlFallbacks[0] || result.coverUrl || '';
```

In the image components (BookTableRow, MobileBookCard), add the fallback handler:

```tsx
const covers = book.coverUrlFallbacks?.length ? book.coverUrlFallbacks : [book.coverUrl].filter(Boolean);
const [coverIdx, setCoverIdx] = useState(0);

<img
  src={covers[coverIdx] || ''}
  onError={() => {
    if (coverIdx < covers.length - 1) setCoverIdx(prev => prev + 1);
  }}
/>
```

**What this commit does:** When a cover 404s, the next source loads automatically. Old books without `coverUrlFallbacks` use `coverUrl` as before.

**Test:** Find a book where Open Library's cover 404s (check the console for those 404 errors we've been seeing). After this change, ISBNdb or Google Books cover should load instead. Old books unaffected.

### Commit 11: Cross-tier ISBN re-queries

In `lookupBook`, after the ISBNdb block, add:

```typescript
// Re-query with ISBNdb's ISBN if we didn't have one before
const isbnFromIsbndb = isbndbHit?.isbn;
const hadIsbnBeforeIsbndb = !!preIsbndbIsbn; // capture result.isbn before ISBNdb block

if (isbnFromIsbndb && !hadIsbnBeforeIsbndb) {
  try {
    const [olEnrich, locEnrich] = await Promise.all([
      enrichFromIsbn(isbnFromIsbndb).catch(() => null),
      lookupFullMarcByIsbn(isbnFromIsbndb).catch(() => null),
    ]);
    // Merge — only fill empty fields
    if (olEnrich) {
      result.lcc = result.lcc || olEnrich.lcc || undefined;
      result.publicationYear = result.publicationYear || olEnrich.year || undefined;
    }
    if (locEnrich) {
      result.lcshSubjects = result.lcshSubjects?.length ? result.lcshSubjects : locEnrich.lcshSubjects;
      result.ddc = result.ddc || locEnrich.ddc || undefined;
    }
  } catch (e) {
    console.warn('[re-query] failed:', e);
  }
}
```

Capture `preIsbndbIsbn` before the ISBNdb block: `const preIsbndbIsbn = result.isbn;`

Wrap the whole re-query in try/catch. If it fails, nothing breaks — we just don't get the extra data.

**What this commit does:** When ISBNdb discovers an ISBN that earlier tiers missed, we go back and get LoC subject headings and Open Library data with it. Silent failure on error.

**Test:** Find a book where Open Library missed but ISBNdb found the ISBN. After this change, the re-query should fill in LCC and LCSH from LoC. Check the console log for the re-query calls.

### Commit 12: Author formatting for CSV export

In `lib/csv-export.ts`, update the author column formatting:

```typescript
// Use authorLF if available (already formatted), otherwise format from author
const authorForCsv = book.authorLF || formatLastFirst(book.author);

function formatLastFirst(name: string): string {
  if (!name) return '';
  if (name.includes(',')) return name.trim(); // already formatted
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts.pop();
  return `${last}, ${parts.join(' ')}`;
}
```

**What this commit does:** CSV author field is consistently formatted. Old books without `authorLF` get formatted from `author` as a fallback.

**Test:** Export a CSV. Check every author is in "Last, First" format. Check multi-author books use semicolons. Import into LibraryThing — authors should parse correctly.

---

## What this plan does NOT do

- Does not change any existing function signatures
- Does not break localStorage backward compatibility
- Does not change the pipeline execution order
- Does not add new API calls to the critical path (all enrichment is additive and wrapped in try/catch)
- Does not modify the existing tag inference system prompt structure (only appends new optional lines)
- Does not change the Review screen layout (only adds conditional rows to the detail panel)
- Does not remove any existing code

---

## Rollback plan

If any commit causes problems:

- Commits 1-6 (Phase 2): safe to keep regardless. They only add data extraction. Nothing reads the data yet.
- Commit 7: revert just this commit. Detail panel goes back to showing only existing fields.
- Commit 8: revert just this commit. Tag inference goes back to existing inputs.
- Commit 9: flip `USE_CANONICAL_TITLES = false`. Instant revert without removing code.
- Commit 10: revert just this commit. Covers go back to single-URL behavior.
- Commit 11: revert just this commit. No re-queries, same as before.
- Commit 12: revert just this commit. Author formatting goes back to existing behavior.

Every commit is independently revertible. No commit depends on a later commit.
