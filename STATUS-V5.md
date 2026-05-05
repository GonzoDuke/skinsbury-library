# Carnegie — Status v5.0

**Date of writing:** 2026-05-05
**Active branch:** `main`
**Latest commit:** `24ddef3` — "v5.0.0". Caps the LCSH-browse + multi-copy + export-backup + determinism arc that defines v5.

This is a handoff document. If you are picking this project up cold, read it linearly. Every fact below was verified against the working tree at the date above.

---

## 1. Project identity

| | |
|---|---|
| **Name** | Carnegie |
| **Purpose** | Personal-use web app that catalogs a home library from shelf photos. Reads book spines via Claude Vision, identifies books via a multi-source lookup pipeline, infers genre + form tags from a controlled vocabulary, and exports LibraryThing-compatible CSV files. |
| **Hard rule** | No book ever leaves Carnegie without explicit human approval on the Review screen. The pipeline has a stop here by design. |
| **Repo URL** | https://github.com/GonzoDuke/carnegie |
| **Live URL** | https://carnegielib.vercel.app — production. Vercel auto-deploys from `main`. |
| **Version (package.json)** | `5.0.0`. Footer on the About page reads `ver. 5.0` and is wired to read from package.json (see `app/(app)/about/page.tsx`). When you bump, the footer updates automatically. |
| **Deployment platform** | Vercel. CI is the default Vercel GitHub integration — push to `main` deploys production; PRs and other branches get preview URLs. |
| **License** | All rights reserved (Jonathan M. Kelly, 2026). See `LICENSE` at the repo root. |

Origin: built by a librarian with hundreds of unboxed books, to avoid typing each into LibraryThing manually.

---

## 2. Architecture overview

### Tech stack

- **Framework:** Next.js 16.2.4 (App Router, Turbopack default in Next 16). Single Node runtime — no Edge functions.
- **Language:** TypeScript 5.5.3 (strict mode).
- **Styling:** Tailwind CSS 3.4.6, custom palette in `tailwind.config.ts`. CSS variables in `app/globals.css` drive the dark-mode swap.
- **Hosting:** Vercel.
- **Auth:** None. Personal-use app, no user system.
- **Database:** None. State lives in React + localStorage + a JSON-on-GitHub sync layer (see §7).

### Frontend

- **React** 19.2.5 / **React DOM** 19.2.5.
- **PWA:** Installable. `public/manifest.json` + a no-op `public/sw.js` service worker just to satisfy the install prompt requirement. Icons: `public/icon.svg`, `icon-192.png`, `icon-512.png`.
- **State management:** Single `StoreProvider` (React `useReducer`) in `lib/store.tsx`. No Redux, no Zustand. Persistence to localStorage on every state change; a `HYDRATE` action loads from localStorage on mount (the no-early-hydration pattern matters for React 19 strict mode — see §7).

### Server / pipeline

- **Anthropic SDK** (`@anthropic-ai/sdk` 0.30.1). Spine detection (Pass A), spine OCR (Pass B), LCC inference, tag inference, and a Sonnet last-resort book identifier. **Every Anthropic call is now `temperature: 0`** for deterministic reads (see §3).
- **External lookup APIs:** Open Library, Library of Congress SRU (MARC XML), ISBNdb, Google Books, Wikidata. Full inventory in §4.
- **Barcode scanning:** native `BarcodeDetector` API where available (modern Chrome / Edge / Safari 16.4+), with `@zxing/browser` 0.2.0 + `@zxing/library` 0.22.0 as a dynamic-import fallback. The library is loaded only when the native detector isn't present, so the desktop bundle pays no cost.

### Data flow (photo → CSV)

```
PhotoUploader        →   Pass A (Claude Sonnet)  →    Per-spine workers (×4 concurrent)
(public/, /upload)        spine bbox detection        ─────────────────────────┐
                                                                                ▼
                                                                  Pass B per spine (Sonnet/Opus)
                                                                  → spine read: title/author/publisher/lcc
                                                                                ▼
                                                                  Phase 1 — parallel candidate discovery
                                                                  ISBNdb /books/{q}  ⊕  OL search.json
                                                                  → unified scoring → winner
                                                                                ▼
                                                                  Phase 2 — parallel ISBN enrichment
                                                                  MARC + GB-by-ISBN + Wikidata-by-ISBN
                                                                  + OL-by-ISBN  (now fires on Reread too)
                                                                                ▼
                                                                  /api/infer-tags (Sonnet, temperature 0)
                                                                                ▼
                                                                  BookRecord lands in store.allBooks
                                                                                ▼
                                                                  Review screen — human approve/reject
                                                                                ▼
                                                                  Export screen — generate LT CSV +
                                                                  atomic commit: backup JSON +
                                                                  export-ledger update
                                                                                ▼
                                                                  CSV download → upload to LibraryThing
```

### Directory layout

```
carnegie/
├── app/
│   ├── (app)/                 # Route group — every page that wraps in AppShell
│   │   ├── about/             # About page + version footer
│   │   ├── export/            # Approved-books CSV generation + atomic export commit
│   │   ├── history/           # Past exports, re-download
│   │   ├── lcsh/              # NEW: browse books by Library of Congress Subject Heading
│   │   ├── ledger/            # Manage exported batches (delete, recover)
│   │   ├── review/            # Main human-in-the-loop review surface
│   │   ├── shelflist/         # NEW: two-level LCC-class accordion view of the library
│   │   ├── upload/            # Upload screen + barcode scanner trigger
│   │   └── vocabulary/        # Manage tag vocabulary, propose/promote tags
│   ├── api/                   # 13 server-only API routes (see §4)
│   ├── globals.css            # Tailwind base + CSS variables for theming
│   ├── layout.tsx             # Root layout, dark-mode pre-script
│   └── page.tsx               # / — redirect to /upload (splash component preserved as commented block)
├── components/                # Reusable UI (see §6 for inventory)
├── lib/                       # Pipeline orchestration, store, helpers, types
├── data/
│   └── export-backups/        # NEW: per-export JSON backups, written via atomic Git Trees commit
├── scripts/
│   └── gen-icons.py           # PNG icon generator for the PWA
├── public/                    # Static assets — favicon, manifest, sw.js
├── next.config.js             # Turbopack root pin + serverActions body-size cap
├── tailwind.config.ts         # Carnegie palette + font stack
├── tsconfig.json              # Strict TS + bundler module resolution
├── package.json               # Versions + scripts
├── README.md
├── LICENSE
├── CHANGELOG.md               # Primary release log
├── CHANGELOG-V4.0.md          # Retrospective for the v4 arc
├── CHANGELOG-V5.0.md          # Retrospective for the v4 → v5 arc
├── PROJECT-SPEC.md
├── STATUS-V2.0.md             # Older status snapshot
├── STATUS-V4.0.md             # Prior status snapshot
├── STATUS-V5.md               # ← this file
└── tag-vocabulary.json        # Mirror of lib/tag-vocabulary.json (root copy is the live one)
```

### Key files (read these first)

| File | What it owns | LOC |
|---|---|---|
| `lib/book-lookup.ts` | The entire metadata-lookup pipeline. Phase 1 candidate discovery, Phase 2 ISBN enrichment, the in-memory cache, all per-tier helpers. Phase-2 fan-out now extracted to a shared helper (`enrichWithIsbnFanout`) called from both `lookupBook` and all three `lookupSpecificEdition` tiers — the v5 fix that unblocked LCSH on the Reread path. | ~2150 |
| `lib/pipeline.ts` | Per-spine orchestration (`buildBookFromCrop`, `addManualBook`, `rereadBook`, `retagBook`), client wrappers around `/api/*` routes, USE_CANONICAL_TITLES flag, multi-author authorLF builder. | ~1411 |
| `lib/store.tsx` | StoreProvider, reducer, all actions, localStorage persistence (with HYDRATE), processQueue worker pool with 45s per-spine timeout, mergeDuplicates / addCopy / keepBothDuplicates flow. | ~1014 |
| `lib/export-ledger.ts` | Export ledger persistence + the `pushExportCommit` helper that bundles JSON backups + ledger delta into a single atomic commit per export. Local-only mode short-circuits with `available: true`. | ~1380 |
| `app/(app)/review/page.tsx` | The Review surface (table + expanded detail rows, filters, sort, bulk-retag, refresh-from-cloud, EmptyState). | ~644 |
| `components/BarcodeScanner.tsx` | Native + ZXing barcode detection, freeze-frame confirm flow, ISBN preview lookup with 3s timeout, dup-in-batch confirm. | ~603 |

---

## 3. The pipeline in detail

This is the order operations run in, end to end. File references are absolute paths from the repo root.

### Step 0 — capture

User on `/upload` (the bare-domain `/` redirects to `/upload`) selects or photographs shelves via `components/PhotoUploader.tsx`. Photos are stored in-memory as `File` refs in `pendingFiles` (a `Map<batchId, File>` ref inside `lib/store.tsx`). They are NOT persisted to localStorage — too big.

Tablet capture supports a multi-photo loop (`components/CropModal.tsx`) and the user can crop before queuing.

Manual entry is also a first-class capture path now: `components/ManualBookEntryModal.tsx` — a 2×2 grid (title/author/year/ISBN) shared by Upload and Review surfaces. Manual books still flow through Phase 1 + Phase 2 lookup so they receive the same enrichment as photo-detected ones.

### Step 1 — Pass A (spine detection)

- Route: `app/api/process-photo/route.ts`
- Model: `claude-sonnet-4-20250514` via Anthropic Vision. **`temperature: 0`** for deterministic spine bbox detection.
- Prompt: detects every visible spine and returns a JSON array of bounding boxes (`{x, y, width, height, position}`) in image-percent coordinates. Vertical and horizontal spines both detected.
- Wrapper: `lib/pipeline.ts:detectSpines(file)` posts the image as base64 and parses the JSON response.
- Retry: `withAnthropicRetry` (in `lib/anthropic-retry.ts`) — up to 2 retries on 429/5xx with exponential backoff (1s, 3s); respects `Retry-After` capped at 10s.

### Step 2 — Per-spine worker pool

- Orchestrator: `lib/store.tsx:processQueue()`. Concurrency cap = 4. Each worker pulls the next bbox and calls `buildBookFromCrop`.
- Hard wall-clock cap: **45 seconds per spine**, enforced via `Promise.race` against a `setTimeout`. On timeout the spine becomes a stub `BookRecord` with `confidence: 'LOW'` and warning `"Pipeline timeout — try rereading"`. Worker proceeds to next spine — does not freeze the batch.

### Step 3 — Pass B (per-spine OCR)

- Route: `app/api/read-spine/route.ts` (`temperature: 0`)
- Model selection by spine size (`pickSpineModel` in `lib/pipeline.ts`):
  - `claude-sonnet-4-20250514` (Sonnet) for "easy" spines (≥2% of image area, aspect ratio < 3).
  - `claude-opus-4-7` (Opus) for narrow / vertical / hard spines. Opus is ~5× the per-token cost; using Sonnet everywhere produced confident hallucinations on hard spines, so this hybrid sticks.
- Prompt: extracts `title`, `author`, `publisher`, `lcc` (only when actually printed/stickered on the spine), `confidence` (HIGH/MEDIUM/LOW). Strict canonical-LCC formatting rules.
- **Sticker extractions:** the prompt also returns `extractedCallNumber` (raw sticker text), `extractedCallNumberSystem` (`'lcc'` | `'ddc'` | `'unknown'`), `extractedEdition`, and `extractedSeries`. A sticker-extracted LCC takes `'spine'` provenance — same priority as a printed-on-spine LCC, **outranking every network tier**. A sticker-extracted DDC gap-fills `lookup.ddc` when network DDC is empty. The series field feeds the form-tag inference at call 2 (Penguin Classics / Library of America / Folio Society etc. with HIGH confidence).
- **Note on ISBN:** the prompt deliberately does NOT extract ISBN. ISBN-13s live in the back-cover barcode block, not on the spine. The audit-driven enhancement series re-categorized this as a wrong premise.

### Step 4 — Lookup pipeline (`lib/book-lookup.ts:lookupBook`)

Two-phase architecture. Cache check, then Phase 1 (parallel candidate discovery), then Phase 2 (parallel ISBN enrichment).

**Cache check:** `lookupCache` (module-level `Map<string, BookLookupResult>`) keyed by both title|author and ISBN. Hits short-circuit the network entirely. Survives across requests in a warm Vercel function instance.

**Phase 1 — parallel candidate discovery:**

- Two queries fire simultaneously via `Promise.all`:
  - `fetchOpenLibraryCandidates`: `GET https://openlibrary.org/search.json?title=…&author=…&limit=10&fields=…`
  - `fetchIsbndbCandidates`: `GET https://api2.isbndb.com/books/{title}%20{lastName}` (1-second rate limiter via `isbndbWaitSlot`).
- Results unified into `Candidate[]` (ISBNdb's `IsbndbBook` is adapted to the OpenLibraryDoc shape via `isbndbToCandidate`).
- `pickBestCandidate` runs the existing `scoreDoc` scorer across both pools — author-token match (3 pts), title exact match (2 pts), LCC presence (3 pts), ISBN presence (2 pts), publisher (1), year (1), KDP self-published penalty (−3), study-guide filter. Single best candidate wins regardless of source.

**Phase 2 — targeted ISBN-direct enrichment** (only when Phase 1 winner has an ISBN). This is the part that was broken on the Reread path through v4 and got fixed in v5 (`d272284`):

Phase 2's parallel fan-out + gap-fill merge has been extracted into a shared helper, `enrichWithIsbnFanout(result, log, prevLccSource)`. `lookupBook` calls it; **`lookupSpecificEdition` (the Reread / matchEdition path) calls it from each of its three early-return branches** (OL-by-ISBN, year-scoped, ISBNdb-direct). Before v5, only `lookupBook` ran the fan-out — Reread short-circuited after the first OL hit and never picked up MARC's `lcshSubjects`, GB's cover/synopsis, or Wikidata's LCC gap-fill.

Four parallel exact lookups, all gap-fill (never overwrite Phase 1):

| Tier | Function | URL |
|---|---|---|
| LoC MARC | `lookupFullMarcByIsbn` (lib/lookup-utils.ts) | `https://lx2.loc.gov/sru/voyager?…&query=bath.isbn={isbn}&recordSchema=marcxml` |
| Google Books by ISBN | `gbEnrichByIsbn` | `https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}` |
| Wikidata by ISBN | `lookupWikidataByIsbn` | `https://query.wikidata.org/sparql?…?item wdt:P212 "{isbn}"` |
| OL by ISBN | `enrichFromIsbn` | `https://openlibrary.org/search.json?isbn={isbn}` |

MARC parses 050 (LCC), 082 (DDC), 100 (main author), 245 (title), 250 (edition), 260/264 (publisher), 300 (page count, regex matches `"384 p."` and `"vii, 384 pages"` both), 600/610/611/630/650/651 (LCSH subject headings — capped 25), **655 (genre/form term — capped 15, populated as `result.marcGenres`; the SINGLE most authoritative signal for genre/form classification per system-prompt rule 10a)**, 700/710 (co-authors).

GB-by-ISBN response interface widened: `description`, `pageCount`, `subtitle`, `language`, `mainCategory`, `authors` are all read in addition to publisher / publishedDate / categories / imageLinks.

**Fallbacks** when Phase 1 produced no winner: GB title-search, LoC SRU title+author, Wikidata title-search via SPARQL CONTAINS (genre + subject merge), `/api/identify-book` Sonnet last-resort.

**Post-network class-letter fallbacks** (run inside `lookupBook`, gap-fill only):

5. **DDC → LCC class-letter crosswalk** (`deriveLccFromDdc` in `lib/lookup-utils.ts`, mapping in `lib/ddc-to-lcc.json`). Fires only when `!result.lcc && result.ddc`. Writes the derived class letter to `result.lccDerivedFromDdc` — **NOT** `result.lcc`. Tag inference uses it as a domain anchor; the Review surface flags it distinctly. ~100 entries covering DDC second-summary level (000–990 by tens) plus the exact-3-digit refinements.
6. **Author-similarity backfill** (applied at the pipeline layer, in `applyAuthorPatternEnrichment` inside `lib/pipeline.ts`). Reads the user's local export ledger via `getAuthorPattern(authorLF)` from `lib/export-ledger.ts`. When the ledger contains ≥3 books by the same author AND no LCC AND no DDC-derived class letter, the dominant LCC class letter across those books goes into `result.lccDerivedFromAuthorPattern`. Frequent tags (top 5 across matched books) flow into the tag prompt as `authorPatternTags` with the sample size.

**Three distinct LCC fields:** keep all three separate and pass all three to the tag prompt:
- `lcc` — sourced from a network tier or the spine. Authoritative.
- `lccDerivedFromDdc` — class-letter only, from the DDC crosswalk. Domain anchor.
- `lccDerivedFromAuthorPattern` — class-letter only, from the user's own collection. Domain anchor with personalization.

The `/api/infer-lcc` Sonnet model-guess is the LAST-RESORT tier after all three are empty.

**Verbose logging:** every tier emits a structured trace to the dev terminal. `process.env.VERBOSE_LOOKUP=0` silences. See `createLookupLogger` in `lib/book-lookup.ts`.

### Step 5 — Tag inference (two-call orchestrator)

- Route: `app/api/infer-tags/route.ts`
- Model: `claude-sonnet-4-20250514` for both calls. **Both calls now run `temperature: 0`.**
- Two-call architecture: call 1 detects domain, call 2 (per domain, in parallel) runs focused tag inference.

**Call 1 — domain detection** (`lib/system-prompt-domain.md`):
- Receives the full book metadata and identifies the primary domain from the **21 domains** in `lib/tag-domains.ts` (refactored in v5 from 12 → 21 to align strictly with the LCC class letters; see §8). Multi-domain output is allowed (cap 3) for genuinely cross-domain books.
- Returns `{ domains: [{ domain, confidence }], reasoning }`. Per-domain confidence is HIGH/MEDIUM/LOW. The primary domain's confidence becomes `BookRecord.domainConfidence` (`'low'` triggers a Review-surface marker).
- Few-shot context: the 20 most recent corrections with `kind === 'domain'`.

**Call 2 — focused tag inference, per domain, in parallel** (`lib/system-prompt-tags.md`, template-driven):
- Template variables: `{{domainName}}`, `{{domainVocabulary}}` (only the named domain's tags), `{{formVocabulary}}` (all form tags). Rendered server-side per call.
- For each domain returned by call 1, fires a focused Sonnet call with ONLY that domain's vocabulary loaded. Multi-domain books fan out via `Promise.all` so the latency is one call wide, not N calls deep.
- Each call's response is `{ genre_tags, form_tags, confidence, reasoning }`. The route merges across calls: case-sensitive dedupe on tags; merged confidence = WORST across calls; reasoning prefixed with the per-call domain.

**Fiction tag (auto-derived, v5):** the Fiction form tag is now derived deterministically post-inference from `lcc` + `lcshSubjects`, not asked of Sonnet. Books in the language/literature LCC range with no "Drama" / "Poetry" LCSH signal pick up Fiction automatically. Plays and verse are excluded.

**Performance:** typical book = 2–3 Sonnet calls per record (1 domain + 1 focused) with `Promise.all` for the per-domain fan-out. Cross-domain books → up to 4 calls. `maxDuration = 60` covers all of it.

### Step 6 — Final BookRecord assembly

`buildBookFromCrop` writes the BookRecord. `USE_CANONICAL_TITLES` flag at top of `lib/pipeline.ts` is `true`; canonical title overrides the spine read when Levenshtein similarity ≥ 0.6 (using the shorter of the two), unless similarity drops below — at which point canonical wins outright.

**Multi-copy handling (v5):** records sharing a `work_group_id` are different physical copies of one work (Hardcover + Paperback, e.g.). The `format` field tags the copy. `detectDuplicates` exempts groups where every entry shares the same non-empty `work_group_id`. CSV export writes a BINDING column from `book.format` only (not from `book.binding`, which is lookup-derived). Add Copy modal in `components/AddCopyModal.tsx` is the primary path for creating linked copies.

### Step 7 — Review (human approval)

- Page: `app/(app)/review/page.tsx`
- Desktop/tablet: a sortable table (`components/BookTableRow.tsx`) with click-to-expand detail rows that include `Editable` fields for title/author/ISBN/publisher/year/LCC, a `TagPicker` for adding tags, **clickable LCSH chips** linking to `/lcsh?h={heading}`, synopsis, edition, page count.
- Phone: card list (`components/MobileBookCard.tsx`) with the same Editable fields and LCSH chips.
- Filters: All / Pending / Approved / Rejected / Low confidence.
- Multi-copy rows show an `X of N · {format}` indicator and a 2px gold left-edge connector grouping siblings visually.
- Bulk re-tag (per-domain): re-runs `/api/infer-tags` against the latest vocabulary. User edits to tags are merged in, not overwritten.
- Hard rule: nothing exports without explicit Approve.

### Step 8 — Export

- Page: `app/(app)/export/page.tsx`
- Builds the CSV via `lib/csv-export.ts:generateCsv`. Columns: TITLE, AUTHOR (last, first), ISBN, PUBLICATION, DATE, TAGS, COLLECTIONS, COMMENTS, COPIES, **BINDING** (from `book.format` for multi-copy; empty otherwise).
- **Atomic export commit (v5):** on download, the CSV streams to the user's machine as before, while a single `pushExportCommit` call bundles every JSON backup file (one per batch when split-by-batch is on) plus the ledger delta into ONE atomic Git Trees commit at `data/export-backups/{filename}.json` + `lib/export-ledger.json`. Commit message: `"Export backup: {batch label} ({N} books)"`. Local-only mode falls back to client JSON downloads.
- Vocabulary commit: any `[Proposed]` tags from this batch can be promoted into `tag-vocabulary.json` via `/api/commit-vocabulary` — that route uses the **atomic Git Trees API** (refactored from the old two-PUT pattern in `28a80f3`), so vocabulary + changelog never drift relative to each other.
- Auto-default batch labels (v5): on capture, batches without a user-supplied label auto-default to `Shelf {date}`, `Scans {date}`, or `Manual {date}` depending on origin. Labels are inline-editable from Review and Export surfaces.

---

## 4. API dependencies

### External APIs (called by the server)

| API | Endpoint(s) | Returns | Key required | Free tier | Rate limit | Failure handling |
|---|---|---|---|---|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages` (via SDK) | Spine detection JSON, spine read JSON, tag inference JSON, LCC inference JSON, identify-book JSON | `ANTHROPIC_API_KEY` | No (paid usage) | RPM/TPM per Anthropic plan | `withAnthropicRetry` retries 429/5xx twice; routes return 502 with structured JSON on hard failure. Pipeline degrades gracefully — tag inference returning empty does not block the pipeline. **All Anthropic calls run `temperature: 0`.** |
| Open Library Search | `https://openlibrary.org/search.json?title=…&author=…&fields=…` | Edition + work metadata, ISBN, publisher, year, LCC, subjects, page count | No | Yes | None enforced | Phase 1 candidate; `Promise.all` paired with ISBNdb. Failure → empty candidate list. |
| Open Library Works | `https://openlibrary.org{key}.json` | Work record (LCC fallback, subjects, description used as synopsis) | No | Yes | None | Used when search-level LCC empty. |
| Open Library /isbn | `https://openlibrary.org/isbn/{isbn}.json` | Edition by ISBN — title, author refs, covers | No | Yes | None | Used by `/api/preview-isbn` and `enrichFromIsbn`. |
| Open Library Covers | `https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg?default=false` | Cover JPEG | No | Yes | None | `default=false` makes it 404 instead of grey placeholder; client falls back to GB / ISBNdb cover via `Cover.tsx`. |
| Library of Congress SRU | `https://lx2.loc.gov/sru/voyager?version=1.1&operation=searchRetrieve&query=…&recordSchema=marcxml` | MARCXML record (LCC, LCSH, DDC, edition, pages, co-authors) | No | Yes | Patchy availability | 8s timeout. Failure → null. The MARC parse is the most thorough single source we have for LCSH and DDC. |
| ISBNdb | `https://api2.isbndb.com/book/{isbn}` (direct) and `/books/{query}` (search) | ISBN, title, authors, publisher, date, pages, binding, dimensions, image, dewey_decimal, language, edition, synopsis | `ISBNDB_API_KEY` (header `Authorization`) | No (paid plan) | **1 req/sec on basic plan** — enforced by `isbndbWaitSlot` queue | One-time console warning when key missing, then skipped silently. 401/403 handled (invalid/expired key). 429 retry once. |
| Google Books | `https://www.googleapis.com/books/v1/volumes?q=…` | volumeInfo (title, authors, publisher, publishedDate, categories, imageLinks, industryIdentifiers/ISBN) | `GOOGLE_BOOKS_API_KEY` (optional) | Yes (generous unauth quota) | 1k requests/day default | Keyed call retries unauth on 4xx/5xx — quota survives most outages. |
| Wikidata SPARQL | `https://query.wikidata.org/sparql?format=json&query=…` | Book entities — P212 (ISBN), P1036 (LCC), P971 (DDC), P136 (genre), P921 (subject), P1104 (pages), P179 (series), P50/P123/P577 | No | Yes | Coarse usage policy — tens of req/min OK | 10s timeout. Title-search uses CONTAINS; ISBN-direct uses P212 exact match (`lookupWikidataByIsbn`). |
| GitHub Contents API | `https://api.github.com/repos/{REPO}/contents/{path}` | File reads/writes for ledger, corrections | `GITHUB_TOKEN` (repo scope) | Yes | 5000 req/hour per token | All routes use `sha`-based optimistic concurrency. |
| GitHub Git Trees API | `https://api.github.com/repos/{REPO}/git/...` | Atomic multi-file commits for vocabulary + export-backup | `GITHUB_TOKEN` (repo scope) | Yes | 5000 req/hour per token | Single retry on 422 fast-forward conflict (concurrent writer landed mid-flow). |

### Internal API routes (under `app/api/`)

| Route | Method(s) | Purpose | Calls |
|---|---|---|---|
| `/api/process-photo` | POST | Pass A spine detection. `temperature: 0`. | Anthropic Sonnet Vision. |
| `/api/read-spine` | POST | Pass B per-spine OCR. `temperature: 0`. | Anthropic Sonnet or Opus. |
| `/api/lookup-book` | POST | Full Phase-1+Phase-2 metadata lookup. Includes the v5 fix that runs Phase 2 fan-out on the matchEdition / Reread branch. | OL, ISBNdb, GB, LoC, Wikidata. |
| `/api/infer-tags` | POST | Two-call orchestrator: domain detection then per-domain focused tagging. Both calls `temperature: 0`. | Anthropic Sonnet × {1 + N} where N = domains identified. |
| `/api/infer-lcc` | POST | LCC inference fallback (model-guess). `temperature: 0`. | Anthropic Sonnet. |
| `/api/identify-book` | POST | Last-resort book identification from raw spine fragments. `temperature: 0`. | Anthropic Sonnet. |
| `/api/preview-isbn` | GET | Fast preview for the barcode-scanner confirm card. ISBNdb → OL fallback. 3s client timeout, 4.5s server. | ISBNdb, OL. |
| `/api/ledger` | GET, POST | Read / merge-write the export ledger to GitHub (`lib/export-ledger.json`) for non-export ledger deltas (deletions, dedupe-dismissals, renames). | GitHub Contents API. |
| `/api/corrections` | GET, POST | Read / merge-write the tag-correction log to GitHub (`data/corrections-log.json`). | GitHub Contents API. |
| `/api/commit-vocabulary` | POST | Promote `[Proposed]` tags into `lib/tag-vocabulary.json` + append to `lib/vocabulary-changelog.md`. **Atomic Git Trees commit** (refactored in `28a80f3`). | GitHub Git Trees API. |
| `/api/export-backup` | POST | **NEW (v5).** Atomic Git Trees commit bundling per-export JSON backups under `data/export-backups/` plus the ledger delta. One commit per export run. Mirrors the `commit-vocabulary` pattern. | GitHub Git Trees API. |
| `/api/changelog` | GET | Read `lib/vocabulary-changelog.md` for the Vocabulary screen. | GitHub Contents API. |
| `/api/debug-log` | POST | Server-side diagnostic logging (used by client error boundaries). | None. |

The old `/api/pending-batches` route was removed alongside the cross-device pending-batches sync (`001fa05`). See §7.

---

## 5. Environment variables

Required keys for full functionality. Place in `.env.local` for local dev; in Vercel project settings for production.

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required.** | Without it, every AI route returns 500. Pipeline non-functional. |
| `ISBNDB_API_KEY` | Strongly recommended. | Without it, Phase-1 ISBNdb candidates skip silently. Open Library + Google Books still work, but coverage drops noticeably for recent printings. One-shot console warning logged. |
| `GOOGLE_BOOKS_API_KEY` | Optional. | If absent, `lookupBook` falls back to the unauth'd Google Books endpoint. |
| `GITHUB_TOKEN` | Required for cross-device sync. | Without it, the ledger / corrections / vocabulary / export-backup routes return 501 cleanly and the client falls back to localStorage-only flow. The export page also falls back to client-side JSON downloads when the token is missing. |
| `GITHUB_REPO` | Optional. | Defaults to `GonzoDuke/carnegie`. Override only if forking. |
| `GITHUB_BRANCH` | Optional. | Defaults to `main`. |
| `VERBOSE_LOOKUP` | Optional. | Set to `0` to silence the per-tier lookup trace logging. Default on. |
| `NEXT_PUBLIC_VERBOSE_LOOKUP` | Optional. | Set to `0` to silence the barcode-scan path's browser-console trace. Default on. |
| `NEXT_PUBLIC_GOOGLE_BOOKS_API_KEY` | Optional. | Used in `lib/scan-pipeline.ts` for client-side GB lookups during barcode scan. |

A `GOOGLE_VISION_API_KEY` may exist in `.env.local` from a long-abandoned experiment. Nothing in the codebase references it. Safe to remove.

---

## 6. Frontend

### Sidebar nav (desktop / tablet — `components/AppShell.tsx`)

Fixed 260px left rail, near-black background, Carnegie tartan brand panel at top.

- **Workflow** section: Upload (`/upload`), Review (`/review`, with pending-count badge), Export (`/export`).
- **Library** section: Shelflist (`/shelflist`), **LCSH (`/lcsh`)** ← new in v5, Vocabulary (`/vocabulary`).
- **Standalone**: About (`/about`), pinned just above the footer.
- **Footer**: lifetime stats (`N books cataloged · M batches exported`, read from the export ledger) and the **Local-only mode toggle** (a small navy-soft toggle row that suppresses every GitHub write).
- **New session button**: above Workflow nav. Confirms-then-clears the active session. Disabled when session is empty.

### Mobile nav (`components/MobileShell.tsx`)

Hidden at `md+`. Top bar (48px) + bottom tab bar (~56px). Tab bar is `grid-cols-5`: Upload, Review, Export, Shelflist, Vocab. **LCSH is intentionally desktop-only** — adding a sixth column would compress every existing tab past legibility; LCSH is reachable on phone via direct URL or via the clickable LCSH chips in book detail panels. Top bar carries an About icon, New-session button, and a gear menu hosting the Local-only mode toggle.

### Pages

| Path | File | Behavior |
|---|---|---|
| `/` | `app/page.tsx` | Redirect to `/upload`. (A splash component lived here briefly on 2026-05-05 and was reverted; the original redirect logic is preserved as a commented-out block at the top of the file for future use.) |
| `/upload` | `app/(app)/upload/page.tsx` | PhotoUploader, BarcodeScanner trigger, ManualBookEntryModal trigger, batch label/notes inputs. Auto-default labels (`Shelf {date}` / `Scans {date}` / `Manual {date}`) when the user doesn't supply one; inline-editable. |
| `/review` | `app/(app)/review/page.tsx` | The main approve/reject surface. Filters, sort, bulk re-tag, "Add missing book" per-batch button, multi-copy "X of N" indicators with gold left-edge connector, clickable LCSH chips in detail panels. |
| `/export` | `app/(app)/export/page.tsx` | CSV preview, batch label / notes / "include batch tag" toggles, vocabulary-promotion section for `[Proposed]` tags, download CSV, atomic export commit. |
| `/history` | `app/(app)/history/page.tsx` | Past batches read from the ledger. Re-download CSV, Import existing LibraryThing CSV. |
| `/lcsh` | `app/(app)/lcsh/page.tsx` | **NEW (v5).** Index of every LCSH heading drawn from approved books, filterable + sortable (A→Z / By count). `?h={heading}` flips to a per-heading detail view listing books carrying it, sorted by author last name then title. Heading-as-opaque-atom (no subdivision splitting). |
| `/shelflist` | `app/(app)/shelflist/page.tsx` | **NEW (v5).** Two-level LCC accordion. Top level always shows all 21 LCC class letters (open-world); empty classes render at reduced opacity. Sub-level shows only populated sub-classes. Third level lists books. Expanded state persists across in-tab navigation via sessionStorage. |
| `/ledger` | `app/(app)/ledger/page.tsx` | Manage the export ledger. Per-batch delete with confirmation. |
| `/vocabulary` | `app/(app)/vocabulary/page.tsx` | Browse current vocabulary by domain. Add / rename / remove tags. Vocabulary changelog (read from GitHub). |
| `/about` | `app/(app)/about/page.tsx` | Editorial page with Carnegie's origin story, the five-stage pipeline explanation, version footer (reads `ver. 5.0` in v5). |

### Key components (under `components/`)

- `AppShell.tsx` — desktop sidebar shell, includes the Local-only mode toggle in the footer.
- `MobileShell.tsx` — phone nav chrome (top bar + 5-tab bottom bar); gear menu hosts Local-only mode toggle.
- `PhotoUploader.tsx` — drag-drop / file-picker, multi-photo capture.
- `CropModal.tsx` — pre-process crop UI.
- `BarcodeScanner.tsx` — native + ZXing barcode detection.
- `ManualBookEntryModal.tsx` — 2×2 grid for title/author/year/ISBN; shared by Upload + Review.
- `BookTableRow.tsx` — Review table row + expanded detail panel (desktop/tablet); renders LCSH chips via `LcshChipLink`, multi-copy "X of N" badge, gold left-edge connector for siblings.
- `MobileBookCard.tsx` — Review card (phone); same LCSH chip + multi-copy treatment.
- `BookBrowseRow.tsx` / `BookBrowseCard.tsx` — read-only book components used by `/lcsh` detail view (no approve/reject/reread; click expands to synopsis + page count + edition + full LCSH list).
- `LcshChipLink.tsx` — outlined mono link-chip rendering a single LCSH heading with `Link` to `/lcsh?h={encoded}`. Visually distinct from `TagChip` (which is filled and reserved for the controlled vocab).
- `Cover.tsx` — `<img>` wrapper that walks `coverUrlFallbacks` on each `onError`.
- `Editable.tsx` / `EditableBatchLabel.tsx` — click-to-edit text/number fields.
- `AddCopyModal.tsx` — multi-copy creator modal; clones a record with `work_group_id` linkage and a fresh `format`.
- `TagChip.tsx` / `TagPicker.tsx` — tag rendering and add/edit picker. `TagChip` is static when `onRemove` is omitted (used by `BookBrowseRow`/`BookBrowseCard` so chips don't show a remove × on the read-only LCSH browse surface).
- `ConfidenceBadge.tsx`, `ProcessingQueue.tsx`, `BatchProgress.tsx`, `SpineSelector.tsx`, `ImportLibraryThingDialog.tsx`, `UndoToast.tsx`, `ExportPreview.tsx`, `DebugErrorBoundary.tsx` — unchanged in shape from v4.

### Dark mode

CSS variables in `app/globals.css` swap on `.dark` class on `<html>`. Default LIGHT on first visit; opt-in only via toggle (sidebar). Inline script in `app/layout.tsx` reads `localStorage.getItem('carnegie:dark')` and applies before React hydrates so there's no flash. `<html suppressHydrationWarning>` covers the mismatch React 19 would otherwise complain about.

### Local-only mode

A lifetime-of-session toggle exposed in the sidebar footer (desktop) and the gear menu (phone). When ON:
- Every GitHub-write helper early-returns (`pushLedgerDelta`, `pushExportCommit`, `pushCorrectionDelta`, vocabulary commits).
- The export page falls back to client-side JSON downloads for backups.
- A 2px gold bar pinned to the top of the viewport indicates the mode is active.
- `logSkippedWrite` records each suppressed write to the dev console for traceability.

State persists in localStorage (`carnegie:no-write-mode:v1`) and broadcasts in-tab + cross-tab via a custom event so every consumer (sidebar toggle, mobile gear, top-bar gold bar) stays in sync.

### PWA

Installable via `public/manifest.json`. Service worker (`public/sw.js`) is intentionally a no-op — registered only because the install prompt requires its presence.

---

## 7. State management

### Where state lives

| Layer | What | Persistence |
|---|---|---|
| React store (`lib/store.tsx`) | `batches`, `allBooks`, `processing` | localStorage key `carnegie:state:v1` (images stripped before write). HYDRATE on mount. |
| Pending files | `Map<batchId, File>` ref inside StoreProvider | In-memory only. Lost on hard reload. |
| Export ledger | Every exported book — title, author, ISBN, date, batch label, tags, LCC, multi-copy work_group_id | localStorage key `carnegie:export-ledger:v1` + GitHub at `lib/export-ledger.json`. Updated atomically with each export's backup file via `pushExportCommit`. |
| Export backups | One JSON envelope per export run, full `BookRecord` shape with image URIs stripped | GitHub at `data/export-backups/{filename}.json`. Each landing in the same atomic commit as the matching ledger update. |
| Corrections log | Tag add/remove events for inference few-shot. Entries carry `kind: 'tag' \| 'domain'` and an optional `domain` context. | localStorage key `carnegie:corrections-log:v1` + GitHub at `data/corrections-log.json`. |
| Vocabulary | Genre + form tags (21 domains) | `tag-vocabulary.json` (root) and `lib/tag-vocabulary.json` — both written by `/api/commit-vocabulary` via the atomic Git Trees API. The lib copy is the live one read by the app. |
| Local-only mode flag | `'1'` / `'0'` | localStorage key `carnegie:no-write-mode:v1`. |
| Dark mode flag | `'1'` / `'0'` | localStorage key `carnegie:dark`. |
| Shelflist expanded state | which classes / subclasses are open | `sessionStorage` key `carnegie:shelflist-expanded`. |
| Remote-availability flags | per-resource | localStorage keys `carnegie:export-ledger:remote-available:v1`, `carnegie:corrections-log:remote-available:v1`. |

### LocalStorage discipline

`lib/store.tsx` strips heavy data URIs before every persist via `slimBook` — `spineThumbnail` zeroed, `ocrImage` deleted, `mergedFrom` snapshots also slimmed. Per-batch payload stays in tens of KB.

Hydration is gated through a `HYDRATE` action: `useReducer` initializes empty, a mount `useEffect` reads localStorage and dispatches `HYDRATE`. The persist effect bails out until `hasHydrated.current` is true so an empty first render can't wipe the cache. This keeps React 19 strict-mode happy.

### Cross-device sync (v5)

The pending-batches phone-capture-then-desktop-pickup workflow that defined v3–v4 has been **removed** (`001fa05`). The repo no longer carries `data/pending-batches/*.json`, `lib/pending-batches.ts`, or the `/api/pending-batches` route. Phone capture still works in-session; the cross-device hand-off pattern shifted to: capture on whichever device, process to approved on the same device, export — and the ledger / corrections / vocabulary / export-backup syncs propagate the approved state to other devices on next load.

What still syncs across devices:
- **Ledger:** `pushLedgerDelta` for non-export deltas (deletions, dedupe-dismissals, renames) via `/api/ledger`. Per-export adds bundle into the atomic `pushExportCommit` instead.
- **Export backups:** `pushExportCommit` writes one atomic Git Trees commit per export, containing the per-batch JSON envelope(s) + the ledger delta.
- **Corrections:** `pushCorrectionDelta` writes the entry to `data/corrections-log.json` after a tag add/remove on a system-suggested tag.
- **Vocabulary:** `/api/commit-vocabulary` writes both `lib/tag-vocabulary.json` and `lib/vocabulary-changelog.md` in a single atomic Git Trees commit.

Local-only mode short-circuits all of these — the writes are logged via `logSkippedWrite` but never actually fire.

There is a small set of orphan JSON files left under the repo's `data/pending-batches/` directory from before the cross-device sync was removed. They're not loaded by the app and should be left alone unless an explicit cleanup is scheduled.

---

## 8. Tag system

### Vocabulary structure (`tag-vocabulary.json`)

Two-tier shape: domains → tags. **The taxonomy was refactored in v5 from 12 domains to 21 — one per LCC class letter** (`4fd58be`). The 21 domains are:

```
general_works (A)
philosophy_psychology_religion (B)
auxiliary_history (C)
world_history (D)
american_history (E)
local_american_history (F)
geography_recreation (G)
social_sciences (H)
political_science (J)
law (K)
education (L)
music (M)
fine_arts (N)
language_literature (P)
science (Q)
medicine (R)
agriculture (S)
technology (T)
military_science (U)
naval_science (V)
books_libraries (Z)
```

Each domain has a list of genre tags. Form tags are separate, applied alongside genre tags:

- **content_forms**: Reference, Anthology, How-to / guide, Primary source, **Fiction (auto-derived)**
- **series**: Penguin Classics, Library of America, Folio Society, etc.
- **collectible**: First edition, Signed

**Open-world principle:** every domain stays visible everywhere it's enumerated, even when empty. New domains added in v5 (Law, Medicine, Education, Agriculture, Technology, etc.) start with hand-written starter vocabularies for Law, Medicine, and Education only; the others start empty and grow organically as books in those classes get cataloged. Empty domains render at reduced opacity but are never hidden.

**Fiction tag (v5):** form-tag `Fiction` is **auto-derived post-inference** from `lcc` + `lcshSubjects`, not asked of Sonnet. Books with LCC in the language/literature range AND no Drama / Poetry LCSH signal pick up Fiction automatically. Plays and verse are excluded by the LCSH signal. The deterministic derivation keeps Fiction consistent across reruns and simplifies the call-2 prompt.

### Inference (`/api/infer-tags`) — two-call orchestrator

The route runs two Sonnet calls per book at `temperature: 0`. Both calls receive the same user-message metadata (title, author, subtitle, all-authors, ISBN, publisher, year, edition, series, binding, language, page count, lcc / lccDerivedFromDdc / lccDerivedFromAuthorPattern, free-text subjects, LCSH, MARC 655, DDC, extractedSeries, authorPatternTags + sample size, synopsis at 300 chars). System prompts differ:

- **Call 1** — `lib/system-prompt-domain.md`. Picks 1–3 domains from the 21 plus per-domain confidence.
- **Call 2** — `lib/system-prompt-tags.md`, template-rendered per call with `{{domainName}}` / `{{domainVocabulary}}` / `{{formVocabulary}}`. Fan-out via `Promise.all` for multi-domain books.

Few-shot context: corrections split by `kind`. `kind: 'domain'` → call 1. `kind: 'tag'` → call 2, filtered to the current call's domain when possible.

### Correction feedback loop

`logCorrection({ removedTag })` fires when the user removes a system-inferred tag. `logCorrection({ addedTag })` fires when they add one the system didn't suggest. Undoing a prior correction cancels the entry. Storage: localStorage + GitHub at `data/corrections-log.json`.

### Proposed-tag promotion

Inferred tags absent from the vocabulary come back from Sonnet prefixed `[Proposed] `. The Export page surfaces these in a dedicated section; the user can promote each to either an existing or a new vocabulary entry. Promotion goes through `/api/commit-vocabulary` which now uses the **atomic Git Trees API** — both `lib/tag-vocabulary.json` and `lib/vocabulary-changelog.md` land in a single commit, eliminating the drift that the old two-PUT pattern allowed when the second PUT failed.

---

## 9. Features list (specific, current)

### Capture
- Multi-photo upload from desktop (drag-drop or file picker) via `PhotoUploader`.
- Pre-queue cropping (`CropModal`) — useful for cutting a single shelf out of a wide bookshelf shot.
- Tablet multi-capture loop — keep snapping shelves without leaving the camera.
- **Manual entry modal** — 2×2 grid (title/author/year/ISBN), shared by Upload and Review. Manual books still flow through Phase 1 + Phase 2 lookup.
- **Auto-default batch labels** (`Shelf {date}` / `Scans {date}` / `Manual {date}`) when the user doesn't supply one. Inline-editable on Review and Export.
- **Barcode scanning** with ISBNdb-then-OpenLibrary preview on the frozen camera frame. Confirm flow gates every capture; dup-in-batch confirm defaults to "No, keep scanning".
- "Add missing book" on Review: draw a rectangle on the source photo or fill a manual title/author/ISBN form. Both paths run through the standard pipeline.

### Pipeline
- Pass-A spine detection (Sonnet Vision, `temperature: 0`).
- Pass-B per-spine OCR with **per-spine model selection** — easy spines on Sonnet, hard on Opus. `temperature: 0`.
- **Sticker call number extraction** — Pass-B reads library-sticker LCC/DDC off ex-library spines and overrides every network LCC tier (provenance: `'spine'`).
- Phase-1 parallel candidate discovery — ISBNdb + OL queried simultaneously, unified scoring.
- Phase-2 parallel ISBN-direct enrichment — MARC + GB-by-ISBN + Wikidata-by-ISBN + OL-by-ISBN. **v5 fix: this fan-out now also fires from `lookupSpecificEdition` (Reread / matchEdition)** — previously short-circuited there, leaving Reread'd books without LCSH headings.
- **MARC 655 (genre/form term)** parsed and fed into the tag prompt as the SINGLE most authoritative signal for genre/form classification.
- **DDC → LCC class-letter fallback** — when network sources only return DDC, a static crosswalk derives the LCC class letter as a domain anchor.
- **Author-similarity backfill** — uses the user's own export ledger as a personalization signal at sample size ≥3.
- **Two-step domain-then-tag inference** with the 21-domain LCC-aligned vocabulary. Both calls `temperature: 0`.
- **Pipeline determinism** — every Anthropic API call (`/api/process-photo`, `/api/read-spine`, `/api/infer-tags` ×2, `/api/infer-lcc`, `/api/identify-book`) runs `temperature: 0`. Same input produces same output across runs.
- 45-second per-spine wall-clock cap.
- Anthropic retry on 429/5xx with exponential backoff.
- Verbose per-tier trace logging.

### Review surface
- Sortable table (desktop/tablet) with click-to-expand detail rows.
- Phone card list with same Editable fields.
- Filters: All / Pending / Approved / Rejected / Low confidence.
- **Multi-copy handling with format awareness** — Hardcover, Paperback, Audiobook, etc. as separate physical copies of one work. Records sharing a `work_group_id` render with an `X of N · {format}` indicator and a 2px gold left-edge connector. `detectDuplicates` exempts groups where every entry shares the same non-empty `work_group_id` so legitimate copies don't get flagged. Add Copy modal is the primary path for creating linked copies.
- **Clickable LCSH chips** in detail panels — outlined mono link-chips routing to `/lcsh?h={heading}` so the user can browse other books carrying the same heading.
- Bulk re-tag (per-domain or all-approved) — preserves user-edited tags.
- Possible-duplicate banner with Merge / Keep-both buttons (never silently merges).
- Reread per-book — now correctly populates LCSH on the Reread path post-v5 fix.
- Detail-panel rows for: page count, edition, binding, language (when not English), series, all authors, synopsis (truncated 280), all LCSH headings.

### Library surfaces (NEW in v5)
- **Shelflist** (`/shelflist`) — two-level LCC-class accordion. All 21 classes always visible (open-world); empty classes render at reduced opacity. Sub-classes only appear when populated. Books listed by full LCC ascending. SessionStorage-persistent expand state.
- **LCSH browse** (`/lcsh`) — index of every Library of Congress Subject Heading drawn from approved books, filterable + sortable A→Z or by book count. Click any heading to drill into a per-heading book list (`?h={encoded}`), sorted by author last name then title. Headings treated as opaque atoms — `"World War, 1939-1945 -- Fiction"` and `"World War, 1939-1945"` are distinct entries.

### Export
- CSV preview matching LibraryThing's expected format.
- Batch label as TAGS (`location:Shelf 3`) and/or COLLECTIONS — both toggleable.
- BINDING column populated from `book.format` when the multi-copy flow set one.
- Multi-author authorLF correctly formatted with `; ` separator.
- Vocabulary promotion for `[Proposed]` tags.
- Auto-export shortcut: `?auto=1` triggers download on mount.
- **Export backups (atomic commit)** — every export run produces ONE Git commit at `data/export-backups/{filename}.json` + the matching ledger update, message `"Export backup: {batch label} ({N} books)"`. Local-only mode falls back to client-side JSON download. Failure paths (`available: false`, `res.error`, thrown error) all also fall back to client download so the user never loses a backup.

### Cross-device
- Export ledger shared, so a previously-exported book on any device flags as duplicate on any other device.
- Tag corrections: shared across devices for inference.
- Vocabulary: shared across devices via atomic Git Trees commits.
- (Phone-capture-then-desktop-pickup pending-batches workflow has been removed in v5.)

### Diagnostics
- Per-tier lookup trace in dev console.
- Identify-book trace in browser console for barcode flow.
- API routes return structured 502 JSON with `error` + `details` fields on failure.
- Local-only mode logs every suppressed write via `logSkippedWrite`.

---

## 10. Known issues

| Issue | Severity | Notes |
|---|---|---|
| Spine-printed ISBN extraction | informational | Earlier handoffs flagged this as a gap — it's not. ISBN-13s live in the back-cover barcode block, not on the spine. The spine-side win that DID land is sticker call-number extraction for ex-library books. |
| `commit-vocabulary` / `export-backup` retry only once on fast-forward conflict | low | Both atomic Git Trees routes do a single 422-conflict retry. Two concurrent writers landing within milliseconds would surface the second as 502. Single-user pattern makes this rare in practice. |
| GitHub 409 conflict UX on `/api/ledger` | medium | The non-export ledger delta route (`/api/ledger`) doesn't have 409-retry. Concurrent writes from two devices surface as 502s. The atomic-commit path (`/api/commit-vocabulary`, `/api/export-backup`) handles this correctly via the Git Trees flow. |
| Wikidata title-search timeout-prone | low | The CONTAINS-LCASE filter is occasionally slow. Mostly bypassed thanks to ISBN-direct via `lookupWikidataByIsbn`. |
| Anthropic SDK has no `AbortSignal` | low | Relies on Vercel's `maxDuration` for cancellation. The 45s per-spine client-side `Promise.race` is the user-visible safety net. |
| MARC enrichment "no record" common | informational | LoC SRU coverage is patchy for trade-edition ISBNs. The MARC parse works correctly when a record exists; this is upstream coverage, not a bug. |
| Splash page lived for ~30 minutes 2026-05-05 and was reverted | informational | A chrome-free splash was live in production briefly before being reverted in `c46c838`. The original `/upload` redirect is restored; the splash component is preserved as a commented-out block at the top of `app/page.tsx` for future use. No source-state implication — flagged here so a future reader doesn't try to "rebuild" the splash. |
| `data/pending-batches/` directory contains orphan JSON files | informational | Left behind after the v5 removal of the cross-device pending-batches sync. Not loaded by any code path. Left alone deliberately — cleanup is unscheduled. |
| `GOOGLE_VISION_API_KEY` in `.env.local` | informational | Unused. Safe to delete. |
| No Review-surface UI for `kind: 'domain'` corrections | medium (carried from v4) | The corrections-log infrastructure supports `kind: 'domain'` corrections so a future UI can teach call 1. Today no UI fires this kind — only `kind: 'tag'`. |

---

## 11. Infrastructure concerns — audit results

### Fixed in v5
- **Phase 2 fan-out on Reread / matchEdition path** (`d272284`). `lookupSpecificEdition`'s three early-return tiers (OL-by-ISBN, year-scoped, ISBNdb-direct) were short-circuiting before MARC + GB + Wikidata + OL-by-ISBN fired. MARC is the only source of `lcshSubjects`, so any book Reread'd through this path lost its LCSH headings — and books processed before MARC was wired in were never re-enriched. Fix: extracted Phase 2 fan-out + gap-fill merge into a shared `enrichWithIsbnFanout` helper called from both `lookupBook` and all three `lookupSpecificEdition` tiers.
- **Pipeline determinism via `temperature: 0`** (`4940187`). Six call sites across five routes — `/api/process-photo`, `/api/read-spine`, `/api/infer-tags` (×2), `/api/infer-lcc`, `/api/identify-book` — now run at temperature 0 for deterministic spine reads, tag inference, LCC inference, and book identification. No call previously set a temperature explicitly.
- **Atomic vocabulary commit** (`28a80f3`). The old two-PUT pattern (`lib/tag-vocabulary.json` then `lib/vocabulary-changelog.md`) had a known drift window — if the second PUT failed, vocabulary was updated but changelog stayed stale. Refactored to a single Git Trees commit so blobs and trees are dangling-but-unreferenced until the final ref PATCH lands. Any pre-PATCH failure is a no-op on visible repo state.
- **Atomic export-backup commit** (`5bee972`). New `/api/export-backup` route + `pushExportCommit` helper. Per-export JSON backup files + ledger delta land in one Git Trees commit. Replaces the previous client-download-then-fire-and-forget-ledger-PUT pattern.
- **Removal of pending-batches cross-device sync** (`001fa05`). The phone-capture-then-desktop-pickup workflow built in v3 was removed in v5 — too much commit noise (~30+ commits per session was typical), the use case had shifted to single-device-per-session, and the alternative paths (export-ledger sync + corrections sync + vocabulary sync) cover what the user actually relies on.

### Still open
- 409 retry coverage on the non-export `/api/ledger` route. The atomic-commit routes (`commit-vocabulary`, `export-backup`) handle this correctly via the Git Trees flow's single-retry on 422.
- Postcss-via-Next-bundle moderate CVE — transitive, fix has to come upstream from Next.
- No Review-surface UI for `kind: 'domain'` corrections (see §10).

---

## 12. Design system

### Color palette (tailwind.config.ts)

**Primary**
- Carnegie navy: `#1B3A5C` — primary interactive color, accent text.
- Carnegie navy-soft: `#ECF0F4` — hover backgrounds.
- Carnegie navy-deep: `#14304B` — active / hover-darken.

**Accent**
- Carnegie gold: `#C4A35A` — approve / progress / brand accent. THE Carnegie color (matches the tartan).
- Gold-soft: `#FAF4E5` — approved row tint. Also used for the multi-copy left-edge connector and the local-only-mode indicator bar.

**Status**
- Green `#1A8754` (high confidence) / soft `#EAF6F0`.
- Red `#B83232` (reject / low confidence) / soft `#FBECEC`.
- Amber `#C08800` (medium confidence) / soft `#FBF4E6`.

**Surfaces (CSS-variable-driven for dark mode)**
- `--color-surface-page` — light: `#F6F6F4`.
- `--color-surface-card` — light: `#FFFFFF`.
- Lines `--color-line` / `--color-line-light`.
- Text `--color-text-primary` / `secondary` / `tertiary` / `quaternary`.

**Domain colors** (each with `bg` + `fg`) — 21 entries matching the LCC-aligned domain list. Representative samples: `language_literature` `#E8F2FC / #2A5F9E` · `science` `#E1ECF7 / #1F4F87` · `american_history` `#FBE6DD / #A03517` · `philosophy_psychology_religion` `#EEF0FF / #4547A9`.

### Typography

Single typeface: **Outfit** (Google Fonts, weights 300/400/500/600/700). Mono: **JetBrains Mono** for ISBN, LCC, anything that should monowidth, and LCSH chips.

Type scale lives in CSS classes `typo-page-title`, `typo-page-desc`, `typo-card-title`, `typo-label`, `typo-section-label` — defined in `app/globals.css`. The v5 typography pass (`b3afb67`) bumped the scale incrementally — page titles 28px, page-desc 15px, card-title 17px.

### Tartan

Carnegie clan tartan, recreated in CSS via two `repeating-linear-gradient` layers (180° warp + 90° weft) over a navy base. Stripe colors: gold `rgba(196,163,90,…)`, green `rgba(45,90,58,…)`, near-black `rgba(20,20,20,…)`, red `rgba(184,50,50,…)`. Used on the sidebar BrandPanel (260×260) and the 80px About-page header.

### Logo (Spine Stack)

56×56 rounded-square tile, near-black `#141414` background, four colored vertical bars representing book spines on a shelf:

- gold `#C4A35A` height 42 — tallest
- blue `#5B8DB8` height 36
- red `#B83232` height 30
- gray `#8A8A84` height 24 — shortest

Defined in `components/AppShell.tsx:SpineStackLogo`. Half-scale variant in `MobileShell.tsx`.

Wordmark: "CARNEGIE" Arial Black, 22px, white, 4px letter-spacing, uppercase. Subtitle: "CATALOGING SYSTEM" 10px, 75% white, 2.5px letter-spacing, uppercase.

### Dark mode

Toggled via `<html class="dark">`. CSS variables in `app/globals.css` swap automatically. Inline script in the layout pre-applies the saved preference before React hydrates. Default LIGHT on first visit.

### Local-only-mode indicator

A 2px gold bar (`#C4A35A`) fixed to the top of the viewport (`z-50`) whenever local-only mode is on. Always visible regardless of route, scroll position, or sidebar/mobile-chrome state. The mobile gear icon also gets a small gold dot in the top-right corner when active.

---

## 13. File structure (annotated)

Top-level (excluding `node_modules`, `.next`, the orphan `data/pending-batches/*.json`):

```
app/
├── (app)/                                Route group — every page that wraps in AppShell
│   ├── about/page.tsx                    About page + version footer (reads package.json default import)
│   ├── export/page.tsx                   /export — CSV preview, vocabulary promotion, atomic export commit
│   ├── history/page.tsx                  /history — past exports, re-download CSV, import LibraryThing CSV
│   ├── lcsh/page.tsx                     /lcsh — NEW: index of LCSH headings + per-heading book list
│   ├── ledger/page.tsx                   /ledger — manage exported batches (delete with confirmation)
│   ├── review/page.tsx                   /review — main review surface (multi-copy + clickable LCSH chips)
│   ├── shelflist/page.tsx                /shelflist — NEW: two-level LCC accordion view of the library
│   ├── upload/page.tsx                   /upload — PhotoUploader + barcode + manual entry + auto-default labels
│   └── vocabulary/page.tsx               /vocabulary — manage tag vocab, promote proposed tags, view changelog
├── api/
│   ├── changelog/route.ts                GET vocabulary changelog from GitHub
│   ├── commit-vocabulary/route.ts        POST proposed-tag promotion (atomic Git Trees commit)
│   ├── corrections/route.ts              GET/POST tag-correction log on GitHub
│   ├── debug-log/route.ts                POST diagnostic logs from client
│   ├── export-backup/route.ts            NEW: POST atomic Git Trees commit bundling backup files + ledger delta
│   ├── identify-book/route.ts            POST raw spine fragments → Sonnet book identification (temp 0)
│   ├── infer-lcc/route.ts                POST LCC inference fallback (temp 0)
│   ├── infer-tags/route.ts               POST two-call domain + tag inference (both calls temp 0)
│   ├── ledger/route.ts                   GET/POST non-export ledger deltas (deletions, dedupe-dismissals, renames)
│   ├── lookup-book/route.ts              POST full Phase-1+Phase-2 metadata lookup
│   ├── preview-isbn/route.ts             GET fast ISBN preview for the barcode-scan confirm card
│   ├── process-photo/route.ts            POST Pass A spine detection (temp 0)
│   └── read-spine/route.ts               POST Pass B per-spine OCR (temp 0)
├── globals.css                            Tailwind base + CSS variables for theming + custom typography classes
├── layout.tsx                             Root layout, dark-mode pre-script, font links
└── page.tsx                               / — redirect to /upload (splash component preserved as commented block)

components/
├── AddCopyModal.tsx                      Multi-copy creator (links via work_group_id, sets format)
├── AppShell.tsx                          Desktop sidebar shell + Local-only mode toggle in footer
├── BarcodeScanner.tsx                    Camera-based barcode detection + freeze-frame ISBN preview
├── BatchProgress.tsx                     Per-batch progress bar in the queue UI
├── BookBrowseCard.tsx                    NEW: read-only book card (phone) for /lcsh detail view
├── BookBrowseRow.tsx                     NEW: read-only book row (desktop/tablet) for /lcsh detail view
├── BookTableRow.tsx                      Review table row + expanded detail panel (multi-copy + LCSH chips)
├── ConfidenceBadge.tsx                   HIGH / MED / LOW pill with status color
├── Cover.tsx                             <img> wrapper, walks coverUrlFallbacks on onError
├── CropModal.tsx                         Pre-process crop UI for shelf photos
├── DebugErrorBoundary.tsx                React error boundary with diagnostic dump (wraps Review)
├── Editable.tsx                          Click-to-edit text/number field with original-value diff dot
├── EditableBatchLabel.tsx                Inline-editable batch label for Review and Export rows
├── ExportPreview.tsx                     CSV preview table on /export
├── ImportLibraryThingDialog.tsx          Bulk-import existing LT CSV into the local ledger
├── LcshChipLink.tsx                      NEW: outlined mono link-chip rendering one LCSH heading
├── ManualBookEntryModal.tsx              NEW: 2×2 grid (title/author/year/ISBN); shared by Upload + Review
├── MobileBookCard.tsx                    Review card (phone) (multi-copy + LCSH chips)
├── MobileShell.tsx                       Phone top bar + 5-tab bottom bar + gear menu (Local-only toggle)
├── PhotoUploader.tsx                     Drag-drop + file-picker for shelf photos
├── ProcessingQueue.tsx                   Pass-A → per-spine progress UI
├── SpineSelector.tsx                     "Add missing book" canvas (draw rect or manual form)
├── TagChip.tsx                           Single-tag rendering (static when onRemove omitted)
├── TagPicker.tsx                         Add-tag picker grouped by domain
└── UndoToast.tsx                         Global undo notification

lib/
├── anthropic-retry.ts                    withAnthropicRetry — 429/5xx retry with exponential backoff
├── batch-labels.ts                       NEW: auto-default batch label generator (Shelf/Scans/Manual + date)
├── book-lookup.ts                        Phase 1 + Phase 2 + cache + verbose logging + enrichWithIsbnFanout helper
├── corrections-log.ts                    Tag-correction log (localStorage + GitHub sync)
├── csv-export.ts                         LibraryThing CSV builder (incl. BINDING column from book.format)
├── ddc-to-lcc.json                       Static DDC second-summary → LCC class-letter crosswalk (~100 entries)
├── export-ledger.json                    Local mirror of the export ledger (also synced to GitHub)
├── export-ledger.ts                      Export ledger + pushExportCommit + dedupe + previously-exported flagging
├── json-backup.ts                        Backup envelope generator (BackupEnvelope shape, image URIs stripped)
├── lcc-subclasses.ts                     LCC sub-class extraction + label lookup for Shelflist
├── librarything-import.ts                Parse a LibraryThing CSV export into ledger entries
├── lookup-utils.ts                       Levenshtein, sanitizeForSearch, normalizeLcc, lookupLccByIsbn, lookupFullMarcByIsbn (incl. MARC 655), deriveLccFromDdc
├── no-write-mode.ts                      NEW: Local-only mode flag + subscribe + logSkippedWrite
├── pipeline.ts                           Per-spine orchestration, client wrappers around /api/* routes
├── scan-pipeline.ts                      Barcode-scan flow (ISBN → metadata via OL → GB → server fallback)
├── session.ts                            confirmDiscardSession helper for clear-session UX
├── store.tsx                             StoreProvider, reducer, all store actions, processQueue, HYDRATE pattern
├── system-prompt.md                      Legacy single-call tag prompt (DEPRECATED — kept on disk for reference)
├── system-prompt-domain.md               Two-step inference call 1 — domain detection prompt (21 domains)
├── system-prompt-tags.md                 Two-step inference call 2 — focused per-domain tag prompt template
├── tag-domains.ts                        21 domain definitions + LCC-prefix mapping (refactored in v5)
├── tag-vocabulary.json                   Live tag vocabulary read by the app (21 domains)
├── types.ts                              BookRecord, BookLookupResult, SpineRead, PhotoBatch, etc.
├── vocabulary-changelog.md               Append-only log of vocabulary edits
└── vocabulary-update.ts                  Vocabulary mutation helpers (add/rename/remove)

data/
├── corrections-log.json                  Local mirror of the corrections log (also synced to GitHub)
└── export-backups/                       NEW: per-export JSON backups, written via atomic Git Trees commit

scripts/
└── gen-icons.py                          PWA icon generator (PIL)

public/
├── icon-192.png                          PWA icon
├── icon-512.png                          PWA icon
├── icon.svg                              Source icon
├── manifest.json                         PWA manifest
└── sw.js                                 No-op service worker (installable-app marker)

next.config.js                             Turbopack root pin + serverActions body limit
next-env.d.ts                              Next-managed types
package.json                               Versions + scripts (5.0.0)
package-lock.json                          Locked deps
postcss.config.js                          PostCSS config
tag-vocabulary.json                        Mirror of lib/tag-vocabulary.json (root copy not used at runtime)
tailwind.config.ts                         Carnegie palette + font stack + safelist (21 domain color classes)
tsconfig.json                              Strict TS + bundler module resolution

CHANGELOG.md                               Primary release log
CHANGELOG-2026-05-02.md                    Daily changelog, May 2 2026
CHANGELOG-V4.0.md                          Retrospective for v1 → v4 development arc
CHANGELOG-V5.0.md                          Retrospective for v4 → v5 development arc
LICENSE                                    All Rights Reserved (Jonathan M. Kelly, 2026)
PROJECT-SPEC.md                            Original spec
README.md                                  Overview + quick-start
STATUS-V2.0.md                             v2 status snapshot
STATUS-V4.0.md                             v4 status snapshot
STATUS-V5.md                               ← this file
```

---

## 14. Dependency versions

```
dependencies:
  @anthropic-ai/sdk    ^0.30.1
  @zxing/browser       ^0.2.0
  @zxing/library       ^0.22.0      ← peer-pinned to satisfy @zxing/browser strict resolver
  next                 ^16.2.4
  react                ^19.2.5
  react-dom            ^19.2.5

devDependencies:
  @types/node          ^20.14.10
  @types/react         ^19.2.14
  @types/react-dom     ^19.2.3
  autoprefixer         ^10.4.19
  eslint               ^10.3.0
  eslint-config-next   ^16.2.4
  postcss              ^8.5.13
  tailwindcss          ^3.4.6
  typescript           ^5.5.3
```

Node minimum (per Next 16): 20.9.0 LTS. TypeScript minimum: 5.1.0.

---

## 15. Build and deploy

### From scratch (local dev)

```bash
# 1. Clone
git clone https://github.com/GonzoDuke/carnegie.git
cd carnegie

# 2. Install (Vercel uses plain `npm install`; do the same locally to catch peer-dep issues early)
npm install

# 3. Create .env.local
cat > .env.local <<'ENV'
ANTHROPIC_API_KEY=sk-ant-…
ISBNDB_API_KEY=…
GOOGLE_BOOKS_API_KEY=AIza…    # optional
GITHUB_TOKEN=ghp_…             # required for cross-device sync + atomic commits
GITHUB_REPO=GonzoDuke/carnegie
GITHUB_BRANCH=main
ENV

# 4. Run dev server (Turbopack)
npm run dev      # → http://localhost:3000

# 5. Verify
npx tsc --noEmit
npm run build
```

### Deploy to Vercel

Wired via the GitHub integration. Pushing to `main` triggers production deploy; PRs / branches get preview URLs. No `vercel.json` needed — `next.config.js` is the source of truth.

### Common build pitfalls

- **Turbopack root warning** — pinned via `next.config.js:turbopack.root = path.resolve(__dirname)` to dodge a stray `package-lock.json` in the home directory.
- **Peer-dep failure on Vercel** — strict installer rejects mismatched peer deps. Don't use `--legacy-peer-deps` locally — Vercel won't.
- **System prompt edits** — module-cached on warm starts. Restart `npm run dev` after editing prompts.

### Operational checklist when shipping a behavioral change

1. `npx tsc --noEmit` clean.
2. `npm run build` clean.
3. Run a real lookup against the dev server with `VERBOSE_LOOKUP=1` and inspect the trace.
4. Test the empty-state + populated-state of `/review`.
5. Push.

---

## 16. Future features / brainstorm list

Tracked backlog. Not commitments.

### Pipeline / lookup
- **OCLC WorldCat Metadata API** — paid replacement for the discontinued OCLC Classify. Investigate cost/value.
- **HathiTrust** for full-text matching of partially-OCR'd titles.
- **Match-uncertainty warning** — when the Phase-1 winner's title diverges from the spine read by Levenshtein < 0.6, optionally re-run via `identify-book` instead of trusting the match.

### Capture
- **Live spine-detection preview** — show bounding boxes on the camera feed before commit.
- **Mass-rescan** — select N books on Review and Reread them all in one go.
- **OCR-quality crop preserved across reload** — currently `ocrImage` is stripped; storing in IndexedDB would unblock full Reread after a refresh.

### Review / UX
- **Bulk approve all matches above HIGH confidence** — one-click for the easy cases.
- **Inline tag suggestions** — show the next 3 most-likely tags from the corrections-log few-shot pool as quick-add chips.
- **Edit history** — track per-field edit timeline.
- **Review-surface "domain wrong" control** — fires `kind: 'domain'` corrections so call 1 of the two-step inference learns from them.

### Library surfaces
- **LCSH subdivision splitting** — treat `"X -- Fiction"` as both `"X"` and `"Fiction"`. Currently atoms.
- **Cross-linking between related LCSH headings.**
- **LCSH auto-complete in Review or Edit forms.**
- **Shelflist book-detail expand inline** instead of linking to /review.

### Cross-device / sync
- **409-retry coverage on `/api/ledger`** — match what the atomic Git Trees routes already do.
- **Multi-device merge view** — see when another device is mid-processing.

### Tag system
- **Confidence-weighted tag merging** during bulk re-tag.
- **Tag co-occurrence stats** — show which tags appear together.

### Export / integration
- **Direct LibraryThing API integration** — currently the user uploads a CSV manually. LT has an import API; this would be opt-in.
- **Goodreads CSV export.**
- **Calibre integration** — push approved books straight into a local Calibre library.

### Speculative
- **Multi-user libraries** — share-link a read-only view of someone else's collection.
- **Book recommendation engine** — using the corrections-log as preference signal.
- **Mobile-native barcode loop** — keep the camera open between scans, audio click, no modal.

---

End of status doc. If you hit something that surprises you, it's probably in the changelog (read newest first) or the per-commit messages on `main`. The most recent shifts a returning AI should orient to:

1. **The 21-domain LCC-aligned taxonomy refactor (`4fd58be`)** is the biggest single behavior change in v5 — domain names, LCC mappings, vocabulary structure, and the system-prompt-domain.md all moved together.
2. **The Phase 2 fan-out fix on the Reread path (`d272284`)** unblocked the LCSH browse end-to-end. Before this, MARC was the only source of LCSH and never fired on Reread; the LCSH browse looked broken on a real library.
3. **The atomic-commit pattern** generalized from `commit-vocabulary` (`28a80f3`) to `export-backup` (`5bee972`) — both routes now use the Git Trees flow with single-retry on fast-forward conflict. Any future multi-file write should follow this pattern, not the two-PUT pattern.
4. **`temperature: 0` across all Anthropic calls (`4940187`)** — the spine-read trace, tag-inference output, and identify-book results are now reproducible across runs. Same input → same output.
5. **Pending-batches removal (`001fa05`)** — if you read older STATUS docs and see references to phone-capture-then-desktop-pickup via `data/pending-batches/`, that workflow is gone. Don't try to rebuild it without re-reading the deletion's rationale (commit churn was the killer).
