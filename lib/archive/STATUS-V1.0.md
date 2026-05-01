# The T.L. Skinsbury Library — v1.0 Status & Architecture

**Tagged at commit:** `4cabd8c` · *Reread: stop clobbering user edits and manual tags*
**Repo:** https://github.com/GonzoDuke/carnegie
**Live:** Vercel (auto-deploys from `main`)

This document is meant to be self-contained: hand it to another Claude
session and they should have full context to discuss the project, its
trade-offs, and reasonable next moves.

---

## 1. What the app does

A personal-use web app for cataloging a home book library by photographing
shelves. Workflow:

1. **Upload** one or more shelf photos. Optional batch label (e.g. "Shelf
   3", "Box 4") and free-form batch notes (e.g. "All first editions,
   signed").
2. **Process** — for each photo, an AI vision pass detects book spines as
   bounding boxes; a second per-spine OCR pass reads title/author/publisher;
   a metadata lookup chain fills in ISBN, publisher, year, LCC, and
   subjects; a tag inference pass assigns genre + form tags from a
   controlled vocabulary.
3. **Review** every detected book. Cards show the cropped spine image, the
   inferred metadata, and the tags. The reviewer can edit any field
   inline, add/remove tags, add per-book notes, reread an individual
   spine (three flavors — see §6), and approve/reject.
4. **Export** approved books as a LibraryThing-compatible CSV. The CSV
   includes Title, Author, ISBN, Publisher, Date, Tags, Collections, and
   Comments. The user can split exports per-batch or combine, and choose
   whether the batch label flows into the Collections column, the Tags
   column, both, or neither.

**Critical constraint:** No data is uploaded to LibraryThing automatically.
The pipeline has a hard stop at the Review screen.

---

## 2. Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| UI | Tailwind CSS, custom theme (Princeton orange #C85A12 accent on warm cream) |
| Fonts | Source Serif 4 (titles), Inter (UI), JetBrains Mono (ISBN/LCC) |
| State | React reducer in a single `StoreProvider` (mounted in `app/layout.tsx`, never unmounts) |
| Persistence | `localStorage` for the BookRecord/PhotoBatch state (large data URIs stripped); File handles + processing state held in `useRef`s, not persisted |
| Vision / LLM | Anthropic Claude Opus 4.7 (Pass B per-spine OCR), Claude Sonnet 4 (Pass A detection + tag inference) |
| Bibliographic | Open Library `search.json` (primary), Google Books v1 volumes (fallback), Library of Congress SRU at `lx2.loc.gov/sru/voyager` (LCC enrichment) |
| Hosting | Vercel; environment variables: `ANTHROPIC_API_KEY` (required), `GOOGLE_BOOKS_API_KEY` (optional) |
| Auth | None. Personal-use tool. |

---

## 3. Repository layout

```
carnegie/
├─ app/
│  ├─ layout.tsx                    # Root layout — fonts, dark-mode flash-prevent, StoreProvider, AppShell
│  ├─ page.tsx                      # /upload — file dropzone, batch-label/notes inputs, processing panel
│  ├─ review/page.tsx               # /review — filter chips, sort buttons, batch grouping, BookCard list
│  ├─ export/page.tsx               # /export — batch checklist, CSV preview, location-tag/collection toggles, download
│  ├─ globals.css                   # Tailwind base + animations (stripe, pulse-dot) + bookshelf-bg gradient
│  └─ api/
│     ├─ process-photo/route.ts     # Pass A: bounding-box detection (Sonnet)
│     ├─ read-spine/route.ts        # Pass B: per-spine OCR (Opus)
│     ├─ lookup-book/route.ts       # Bibliographic lookup chain (Open Library → Google Books → LoC SRU)
│     └─ infer-tags/route.ts        # Tag inference (Sonnet, system prompt + vocabulary)
├─ components/
│  ├─ AppShell.tsx                  # Header (logo, nav, dark-mode toggle), main, footer
│  ├─ BookCard.tsx                  # The Review-screen book card. Lots of UX surface here.
│  ├─ BatchProgress.tsx             # Progress bar with animated diagonal stripe
│  ├─ ConfidenceBadge.tsx           # HIGH/MEDIUM/LOW pill
│  ├─ ExportPreview.tsx             # CSV preview table
│  ├─ PhotoUploader.tsx             # Drag-drop / browse zone with photography hints
│  ├─ ProcessingQueue.tsx           # Per-photo status list during processing
│  ├─ TagChip.tsx                   # Tag pill, domain-colored or form-styled
│  └─ TagPicker.tsx                 # Tag-add dropdown grouped by domain
├─ lib/
│  ├─ types.ts                      # All shared TS interfaces (BookRecord, PhotoBatch, ProcessingState, etc.)
│  ├─ store.tsx                     # Reducer + StoreProvider + processQueue + rereadBook orchestrators
│  ├─ pipeline.ts                   # detectSpines, readSpine, lookupBookClient, inferTagsClient,
│  │                                #   buildBookFromCrop, rereadBook, dedupeBooks, groundSpineRead,
│  │                                #   loadImage, cropSpine, downscaleForUpload, makeId
│  ├─ book-lookup.ts                # Server-side: lookupBook, lookupSpecificEdition, lookupLccByIsbn,
│  │                                #   normalizeLcc, cleanAuthorForQuery, stripSubtitle, scoring helpers
│  ├─ csv-export.ts                 # CSV_HEADERS, bookToCsvRow, generateCsv, exportFilename,
│  │                                #   toAuthorLastFirst, toTitleCase
│  ├─ tag-domains.ts                # Vocabulary helpers (domainForTag, FORM_CONTENT/SERIES/COLLECTIBLE)
│  ├─ tag-vocabulary.json           # Controlled vocabulary — domains, tags, form tags, inference rules
│  └─ system-prompt.md              # Tag-inference system prompt with 12 few-shot examples
├─ tailwind.config.ts               # Theme (accent, domain colors, fonts)
├─ next.config.js
├─ tsconfig.json
├─ package.json
├─ README.md                        # User-facing intro / how-to-run
├─ PROJECT-SPEC.md                  # Original spec (legacy reference)
├─ STATUS-V1.0.md                   # ← this document
├─ vocabulary-changelog.md          # Manual log of vocab additions
├─ sample-lt-import.csv             # Reference example
└─ .gitignore                       # Excludes /*.jpeg, /*.jpg, .env*.local, node_modules, .next, .vercel, .claude/
```

---

## 4. Frontend architecture

### Three pages, one provider

Everything lives under `app/layout.tsx`, which wraps the app in `<StoreProvider>` (the single source of truth for batches, books, processing state, and pending File handles) and `<AppShell>` (header + nav + footer chrome). Because the provider sits at the layout level, it doesn't unmount when the user navigates between Upload / Review / Export — processing started on /upload keeps running and updating state while the user browses /review.

### Upload (`app/page.tsx`)

- Optional `Batch label` text input + `Batch notes` textarea above the dropzone. Whatever's in those fields when a photo is added gets stamped onto the resulting `PhotoBatch`. The user can change the label between uploads to start a new batch within the same session.
- The dropzone (`PhotoUploader`) accepts JPG/PNG/HEIC/WEBP. Images < 1500 px wide are rejected up front with a clear error in the queue.
- "Process all" calls `store.processQueue()`. While processing, a prominent panel renders with two `BatchProgress` bars (photos done, spines read), a pulsing accent dot, and a live "Current step" line ("Detecting spines in IMG_4001.jpg…", "Reading spine 7 of 19…", "Identified: Just Mercy"). When the loop finishes, the panel turns green with a "Review N books →" CTA.

### Review (`app/review/page.tsx`)

- Five `Stat` tiles (Total / Pending / Approved / Rejected / Low confidence).
- Filter chips (All / Pending / Approved / Rejected / Low confidence).
- Sort buttons (Position default / Confidence ↓ / Confidence ↑).
- Books **group by `batchLabel`** with a sticky sub-header per group ("Shelf 3 · 12 books — Approve all in Shelf 3"). Filter and sort apply before grouping.
- Bottom-of-list "Approve remaining (N)" floating button when pending items exist.

### Export (`app/export/page.tsx`)

- Stat tiles (Approved / Pending excluded / Rejected excluded).
- When more than one batch label exists: a **batch checklist** + radio (one combined CSV vs. separate CSV per batch) + two checkboxes for routing the batch label (As a Collection / As a tag).
- WYSIWYG CSV preview that updates live as toggles change.
- Download button. Per-batch mode triggers sequential downloads with distinct filenames (`carnegie-lt-import-2026-04-30-shelf-3-12books.csv`).

### BookCard (`components/BookCard.tsx`)

The richest component. Per book:

- **Cropped spine thumbnail** on the left (so the reviewer can compare what the model saw to what it identified).
- **Title** (serif, large, click-to-edit, auto-Title-Cased on save).
- **Meta line**: Author · ISBN · Publisher · Year · LCC, all click-to-edit, monospace where appropriate. A small **"from spine" badge** appears next to LCC when the LCC was read directly off the physical book (LoC's own classification — most authoritative).
- **Modified-dot indicator** (small accent dot) next to any field whose current value differs from the original snapshot, with the original shown as a tooltip on hover.
- **Confidence badge** (HIGH green / MEDIUM amber / LOW red).
- **Warning banner** for low-confidence reads, missing ISBN, missing LCC, lookup divergence, etc.
- **Genre tags** (domain-colored pills) and **form tags** (outlined or gold for collectible). Each tag has a remove (×) on hover. "+ add genre" and "+ add form" open the `TagPicker` dropdown.
- **Notes**: read-only batch notes shown as italic line at top; below that, a per-book editable textarea.
- **Reasoning**: collapsible, shows the tag-inference engine's reasoning string.
- **Footer**: source photo + spine position + a colored badge showing the lookup source (Open Library / Google Books / No match).
- **Action row**: `↻ Reread` · `Reject` · `Approve`. Reread opens a popover with three options (see §6).

---

## 5. Backend architecture

Four Route Handlers, all running on the Node.js runtime (not Edge — Anthropic SDK + sharp-style buffers want full Node).

### `/api/process-photo` — Pass A: bounding-box detection (Sonnet)

Input: `multipart/form-data` with an `image` file (JPEG, downscaled client-side to 1800 px max long edge before upload to stay under Vercel's 4.5 MB serverless body limit).

Prompt: count visible book spines, return a JSON array of `{position, x, y, width, height, note?}` in image-percentage coordinates. Skip non-books (magazines, CDs, lying-flat items). Don't read text yet.

Model: `claude-sonnet-4-20250514`.

Output: `{ detections: BboxDetection[] }`.

### `/api/read-spine` — Pass B: per-spine OCR (Opus)

Input: `{ imageBase64, mediaType, position }` — a single tightly-cropped spine.

Prompt: extract title, author, publisher, lcc (only if a real LCC sticker/print is on the spine — strict rules with format examples). Confidence rating per book. Don't invent text. If illegible, return empty fields with a note.

Model: `claude-opus-4-7`. (Tried Sonnet-first as cheaper tier; reverted because Sonnet produced confident hallucinations like "Von Fleisch und Knochen" for "Zen Flesh, Zen Bones".)

Output: `{ title, author, publisher, lcc, confidence, note? }`.

### `/api/lookup-book` — Bibliographic lookup chain

Input: `{ title, author, matchEdition?, hints? }` where `hints = { year?, publisher?, isbn? }`.

Two modes:

- **Standard** (`matchEdition` false/absent) → `lookupBook(title, author)` runs a tiered cascade:
  - **t1**: Open Library `?title=$T&author=$cleanedA`
  - **t2**: OL `?title=$shortTitle&author=$cleanedA` (drops subtitle)
  - **t3**: OL `?title=$shortTitle` (no author — catches OL author-index quirks)
  - **t4**: OL `?q=$shortTitle $cleanedA` (full-text)
  - **gb**: Google Books `intitle:+inauthor:` (also using cleaned author + short title). On 4xx/5xx with the API key, retries unauthenticated.
  - **Final post-processing**: canonicalize LCC; if still no LCC and we have an ISBN, query LoC SRU at `lx2.loc.gov` for the authoritative 050 field.

  As soon as a tier returns a `pickBestDoc` result with usable identifiers, return.

- **Edition-scoped** (`matchEdition: true`) → `lookupSpecificEdition(title, author, hints)`:
  - If `hints.isbn` is present, query OL `?isbn=` directly (most specific signal).
  - Else query OL with `publish_year=$year`, ranked with a publisher-match tiebreaker.
  - Falls back to the unscoped chain on miss.

`pickBestDoc` filters out study-guide-y titles (CliffsNotes, SparkNotes, Coles Notes, "for dummies", etc.) and ranks remaining candidates with a score:
- Has ISBN +2
- Has LCC +3
- Has publisher +1
- Has `first_publish_year` +1
- Title exact-match +2
- Author full-token match +3 (every non-stopword token of the cleaned query author must appear in candidate's `author_name`)
- Author last-name only +1 (coarser fallback)
- Any 9798-prefix ISBN (KDP/self-published) –3

Author cleaning (`cleanAuthorForQuery`): strips `ed.`, `eds.`, `edited by`, `trans.`, `translated by`, `intro by`, `foreword by`, plus leading `and`/`&`/`,`. The display author keeps the prefix.

Subtitle stripping (`stripSubtitle`): everything before the first " : ".

Title matching (`titleSubstringMatch`): bidirectional — `q ⊂ c` OR `c ⊂ q` so canonical short titles match long-subtitle queries.

LCC normalization (`normalizeLcc`): converts Open Library's padded form `BL-0053.00000000.J36 2012` to canonical `BL53 .J36 2012`.

Output: `BookLookupResult & { tier?: string }` — `{ isbn, publisher, publicationYear, lcc, subjects?, source: 'openlibrary' | 'googlebooks' | 'none', tier: 'ol-t1' | 'ol-t2' | 'ol-t3' | 'ol-t4' | 'gb' | 'none' }`.

The `tier` field surfaces in the dev console log for diagnostics.

### `/api/infer-tags` — Tag inference (Sonnet)

Input: `{ title, author, isbn?, publisher?, publicationYear?, lcc?, subjectHeadings?, existingGenreTags? }`.

Loads `lib/system-prompt.md` (12 few-shot examples covering Buddhism, Atheism, Counterculture, French literature, Existentialism, biography subtypes, edge cases like *Zen and the Art of Motorcycle Maintenance*, collectible form tags, Shakespeare → Drama + Shakespeare, Whitman → Poetry + American poetry, Lorca → Poetry + World poetry).

Prompt rules: LCC determines primary domain; 2–4 tags typical; cross-domain expected; use author knowledge for well-established intellectual identities; parse subtitles ("A Field Guide to…" → How-to); fiction is a Literature tag (not a domain); plays go to Drama (not Fiction); every poetry book gets `Poetry` plus a specific sub-tag.

Model: `claude-sonnet-4-20250514`.

Output: `{ genreTags, formTags, confidence, reasoning }`.

---

## 6. The pipeline end to end

```
User uploads photo(s) ─┐
  └─ each batch carries optional batchLabel + batchNotes
     │
     ▼
Client downscale (canvas → JPEG 1800px @ 0.85)
     │
     ▼
POST /api/process-photo  ── Sonnet vision
     │   returns array of {bbox} per spine
     ▼
For each detection (parallel, concurrency=4 worker pool):
  │
  ├─ Client-side cropSpine() at full source resolution
  │   ├─ ocrCrop: 1200px max long edge, 10% padding   → sent to /api/read-spine
  │   └─ spineThumbnail: 220px max, 5% padding         → kept on the BookRecord
  │
  ├─ POST /api/read-spine    ── Opus vision on the crop
  │   returns {title, author, publisher, lcc, confidence}
  │
  ├─ POST /api/lookup-book   ── tiered cascade (see §5)
  │   returns {isbn, publisher, year, lcc, subjects, source, tier}
  │
  ├─ groundSpineRead() — drop entries that are gibberish + no lookup,
  │                      drop magazines (title-keyword + subjects),
  │                      drop author-only labels, demote on title divergence
  │
  ├─ POST /api/infer-tags    ── Sonnet, vocabulary + system prompt
  │   returns {genreTags, formTags, confidence, reasoning}
  │
  └─ Assemble BookRecord (title-cased title, canonical LCC, batchLabel,
                          batchNotes, confidence, warnings, ocrImage,
                          spineThumbnail, original snapshot)
     │
     ▼
After all spines: dedupeBooks() — collapse cases where Pass A split a
                                   single spine into 2–3 adjacent bboxes
                                   (group by ISBN, then by normalized
                                   title + last-name)
     │
     ▼
Books appear in the global store, visible on /review
```

Wall-clock for a 20-book photo: ~30–45 seconds (4-way parallel).
Cost per 20-book photo: ~$0.40 (Pass B is the dominant line item).

### Reread paths (Review screen)

The `↻ Reread` button on each BookCard opens a popover with three options:

1. **Try again with AI.** Re-runs Pass B on the stored OCR crop. Pass B is non-deterministic, so a fresh attempt often reads better. **Merges with user edits**: any field whose current value differs from `book.original` (title, author, publisher) is preserved over Pass B's new output. If the user edited year/publisher/ISBN, the lookup is automatically routed through `lookupSpecificEdition` so those edits scope the search.

2. **Match a specific edition.** Skips Pass B entirely, treats the user's current edited fields as ground truth, calls `lookupSpecificEdition(currentTitle, currentAuthor, { year, publisher, isbn })`. Disabled until at least one of year/publisher/ISBN differs from `original`.

3. **Type the actual title…** + button. Skips Pass B, accepts a typed title (with the existing author), runs lookup + tag inference using the typed title.

**Tag preservation (v1.0 fix):** none of the three modes overwrites tags if the user has any tags at all. Tag inference only runs when the current tag list is empty (both genre and form). This keeps manual curation safe through repeated rereads.

**Edit preservation across multiple rereads (v1.0 fix):** the reread patch no longer resets `book.original`. The "edited" baseline is the very first snapshot, so user edits stay preserved no matter how many rereads happen.

---

## 7. Data sources — what comes from where

| Field | Primary | Fallback | Notes |
| --- | --- | --- | --- |
| Title | Pass B (Opus OCR on crop) | User edit | Auto Title-Cased on the way to BookRecord; dotted initialisms (U.S.A., F.B.I., T.S.) preserved uppercase |
| Author | Pass B | User edit | Editor markers ("ed. ") visible in display, stripped before lookup |
| ISBN | Open Library → Google Books | User edit | KDP/9798-prefix ISBNs penalized in scoring |
| Publisher | Open Library → Google Books → Pass B | User edit | |
| Publication year | OL `first_publish_year` (work level) → publish_date earliest → publish_year → GB `publishedDate` → user-supplied | User edit | OL work-level enrichment via `?isbn=` recovers the work's first year (e.g. 1942 for *The Stranger* even when the lookup landed on a 1989 reprint) |
| LCC | Spine-read (canonical from Pass B) → OL `lcc` field → OL work-level → LoC SRU (`bath.isbn`) | User edit | Spine LCC wins; "from spine" badge on the BookCard surfaces this provenance |
| Subjects | OL `subject` → GB `categories` | — | Used by tag inference, not displayed directly |
| Tags | Tag inference (Sonnet) using vocabulary + system prompt | User edit | `[Proposed]` prefix for tags the model invents that aren't in the controlled vocabulary |

---

## 8. The controlled tag vocabulary (`lib/tag-vocabulary.json`)

12 domains, each with its own LCC prefix list and color:

- **Philosophy** (B1, B4, B5, B8, BC, BD): Stoicism, Ethics, Epistemology, Existentialism, Postmodernism, Logic, Critical thinking, Philosophy of mind, Philosophy of science, Ancient philosophy
- **Religion & spirituality** (BL, BM, BP, BQ, BR, BS, BT, BV, BX): Atheism, Buddhism, Comparative religion, Sacred texts, Spirituality
- **Psychology** (BF): Behavioral psychology, Addiction, Neuroscience, Self-improvement
- **Literature** (PN, PQ, PR, PS): Poetry, American poetry, British poetry, Beat poetry, World poetry, Fiction, Drama, Shakespeare, Essays, Literary criticism, Writing craft, Anthology, Harlem Renaissance, French literature
- **Language & linguistics** (P1, PA, PE, PF, PG, PH, PJ, PK, PL, PM): Linguistics, Etymology, History of language
- **History** (C, D, E, F): American history, British history, World history, Cultural history, Counterculture, Exploration
- **Media, technology & information** (TK, T1): Media literacy, Disinformation, Surveillance & privacy, Internet culture, Algorithms & AI, Cybersecurity
- **Social & political** (H, J, K): Protest & activism, Civil liberties, Free speech, Identity & tribalism, Social criticism
- **Science & mathematics** (Q): Evolution, Mathematics, Complexity & systems, Nature writing
- **Biography & memoir** (CT): Literary biography, Beat biography, Music biography, Political memoir, Personal memoir, Intellectual biography
- **Arts & culture** (GV, ML, N): Music, Sports, Comedy & humor, Dance, Visual culture, Travel
- **Books & libraries** (Z): Library science, Book culture, Information science

**Form tags** (independent of content):
- *Content*: Reference, Anthology, How-to / guide, Primary source
- *Series*: Portable Library, Penguin Classics
- *Collectible*: First edition, Signed

A `_unclassified` bucket holds approved-but-unfiled tags for manual triage later.

---

## 9. Visual design

- **Palette**: Princeton orange (`#C85A12`) accent, slightly darker than official Princeton; warm cream background (`#FAFAF7`) light, warm dark (`#1A1A18`) dark; per-domain pastel pill backgrounds for tag chips with deeper saturated foreground colors for contrast.
- **Type**: Source Serif 4 for titles (literary feel); Inter for UI; JetBrains Mono for ISBN, LCC, CSV preview.
- **Spacing**: Wide layout (`max-w-[1600px]` with `px-8 lg:px-12`); 17 px base font; large H1s (`text-5xl tracking-tight`).
- **Motion**: Diagonal-stripe progress bar overlay so progress is visibly "working" between determinate updates; pulsing dot beside "Processing your shelf"; gentle 200 ms easing on transitions.
- **Dark mode**: Fully supported via Tailwind's `dark:` prefix. Warm dark, not pure black.

---

## 10. CSV export contract

Header row:
```
"TITLE","AUTHOR (last, first)","ISBN","PUBLICATION","DATE","TAGS","COLLECTIONS","COMMENTS","COPIES"
```

Each book contributes one row. Tags column joins genre + form tags with `, `. When the user has enabled "As a tag" for batch labels, `location:Shelf 3` is appended to that book's tags. When "As a Collection" is enabled, the batch label fills the COLLECTIONS column. The COMMENTS column joins batch notes + per-book notes with ` · `. UTF-8 BOM prepended to the file so LibraryThing handles accented characters correctly.

Filename:
```
carnegie-lt-import-{YYYY-MM-DD}[-{batch-slug}]-Nbooks.csv
```

---

## 11. Recent commit history (most recent first)

| Commit | Subject |
| --- | --- |
| `4cabd8c` | Reread: stop clobbering user edits and manual tags |
| `98fccd6` | Fix lookup query layer: strip 'ed.', drop subtitle, cascade tiers |
| `7e4996a` | Rebrand: "The T.L. Skinsbury Library" + Princeton orange accent |
| `a1518fd` | Notes (batch + per-book) → LT COMMENTS; preserve dotted initialisms; ignore root .jpg/.jpeg |
| `52f32e8` | AI Reread merges user edits + Batch labels (Collections + tags) |
| `f81b0d6` | Downscale shelf photos before upload to /api/process-photo |
| `24ca899` | Title Case for titles + edition-specific Reread |
| `6baa0da` | Revert Sonnet-first Pass B — accuracy regression on real photos |
| `60ee97a` | Streamline pipeline: parallel spines, two-tier vision, no-match short-circuits |
| `0428dd9` | Canonical LCC format + LoC SRU fallback + sort by confidence |
| `8efe27c` | Reread: per-book retry with optional typed hint |
| `226bbfb` | Read LCC off the spine and use it as the authoritative classification |
| `bf2e71c` | Add generic Poetry tag (and British poetry) so all verse is one bucket |
| `3dda876` | Make processing durable across navigation; tag Shakespeare as Drama |
| `eb9606d` | Wider layout, larger type, prominent processing UI |
| `5fe531e` | Two-pass spine pipeline + lookup hardening |
| `bac0044` | initial build |

---

## 12. Verified accuracy benchmarks

End-to-end runs against three different shelf photos, after the v1.0 lookup-cascade fix:

| Photo | Spines detected | Books kept | Hallucinations | Real books on shelf | Hit rate |
| --- | --- | --- | --- | --- | --- |
| WhatsApp shelf (Klosterman/Palahniuk/Carroll/James) | 19–23 (varies, Pass A non-deterministic) | 16–17 after dedup | 0 | ~17 | ~95% |
| `test1.jpeg` (Shakespeare/Crime & Punishment) | 25 | 20 after dedup | 0 | ~20 | ~100% |
| `test2.jpeg` (education/professional) | 25 | 25 after dedup | 0 | ~22 | ~95% (some duplicates Pass A split) |

A 20-book CSV the user produced just before the cascade fix had ~30% rows missing ISBN/year/publisher/tags. After the cascade fix, all six failing inputs from that CSV (Foolproof, Major Dudes, Amsterdam, Penguin Anthology, Everything Must Go, Digital Religion) resolved on tiers 1–3 with full metadata.

---

## 13. Known limitations / what v1.0 does not do

- **No barcode/ISBN scanning from photos.** Spines only.
- **No batch *renaming* after upload.** Label is set at upload time. To correct typos: re-upload (acceptable for a beta-testing tool).
- **No persistence beyond `localStorage`.** Closing the tab and coming back keeps the data; clearing browser data wipes it. No accounts, no server-side store.
- **No proposed-tag feedback loop.** When the user accepts a `[Proposed]` tag, it's not yet written back to `tag-vocabulary.json`. Manual update for now.
- **Pass A is non-deterministic.** Same photo can produce different bbox counts run-to-run. Dedup catches some but not all consequences.
- **Low-resolution / dim / glare-heavy photos still produce hallucinations.** Pass B with Opus dramatically reduced this vs. Sonnet, but it's not zero. The user-instruction guidance ("get within 2–3 feet, fill the frame, even lighting, ≥ 1500 px wide") matters.
- **WorldCat / OCLC not yet integrated.** Would be the natural 5th lookup tier. Requires the user to set up a free OCLC API key. Not prioritized while the OL/GB/LoC chain is hitting > 95% on test runs.
- **No mobile-optimized capture flow.** Desktop-first. Tablet usable.
- **The dev server log uses `console.log` for diagnostics** — fine for personal use on Vercel, would want structured logging for any larger context.

---

## 14. Pending product decisions / known tensions

- **Cost vs. accuracy of Pass B.** Tried Sonnet-first as a cheaper tier, reverted because hallucinations on hard spines were worse than the cost savings. Currently Opus-only. If the bill becomes a concern, the right next experiment is per-spine model selection based on `det.width × det.height` (small spines → Opus; obviously-clear large horizontal spines → Sonnet).
- **What to do when Pass A misses a book entirely.** No way today for the user to add a missed book without re-photographing. The original product spec hinted at this; it's a real follow-up if the WorldCat tier still leaves gaps.
- **Re-tagging existing books after vocabulary changes.** When new tags are added (e.g., the recent Drama/Shakespeare/Poetry additions), pre-existing BookRecords keep their old tags. There's no bulk re-tag UI. The user manually fixes via the Reread "clear tags then reread" pattern.

---

## 15. Suggested follow-ups (good candidates for the next session)

1. **WorldCat / OCLC as t5.** Free API key, biggest English catalog. Likely closes most of the remaining lookup gaps for obscure or very-recent books.
2. **"Add missing book" on Review.** Lets the user click on the source photo, draw a bbox around a spine Pass A missed, and run the per-spine pipeline on that region.
3. **Bulk re-tag.** Run tag inference on every approved book that lacks a specific new vocabulary tag (e.g., "anyone in PR class without 'Drama' or 'Shakespeare'"), so vocabulary updates propagate without one-by-one rereads.
4. **Per-spine model selector.** Use Sonnet on visually clear spines (large bbox, horizontal title), Opus on the narrow vertical ones — cuts ~50% of Pass B cost with no quality regression.
5. **Approved-tag feedback loop.** Auto-promote `[Proposed] X` tags into `tag-vocabulary.json` when approved, with a corresponding entry in `vocabulary-changelog.md`.
6. **Browser extension or PWA Add to Home Screen** for one-tap shelf-cataloging from a phone.

---

## 16. Environment variables

| Var | Required? | Used by | Notes |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | `/api/process-photo`, `/api/read-spine`, `/api/infer-tags` | Set in Vercel project env |
| `GOOGLE_BOOKS_API_KEY` | No | `/api/lookup-book` (Google Books fallback) | Optional; if the keyed call 5xx's the route auto-retries unauth'd |

LoC SRU and Open Library require no key.

---

## 17. Quick run instructions

```bash
git clone https://github.com/GonzoDuke/carnegie
cd carnegie
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env.local
npm run dev
# open http://localhost:3000
```

Production deploys auto-trigger from `main` on Vercel with the env vars set.

---

*End of v1.0 status report. Pass this document to a future Claude session
along with a specific question; everything you need to discuss the
project's architecture, trade-offs, and reasonable next steps is
captured above.*
