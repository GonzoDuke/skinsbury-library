# Carnegie — v2.0 Status & Architecture

**Tagged at commit:** `38fcd60` · *Tag v2.0.0 — bump package.json + CHANGELOG release section*
**Repo:** https://github.com/GonzoDuke/carnegie
**Live:** Vercel (auto-deploys from `main`)

This document is meant to be self-contained: hand it to another Claude session
and they should have full context to discuss the project, its trade-offs, and
reasonable next moves. The v1 snapshot lives at
[lib/archive/STATUS-V1.0.md](lib/archive/STATUS-V1.0.md) — useful for spotting
what changed and why.

---

## 1. What the app does

A personal-use web app for cataloging a home book library by photographing
shelves. Workflow:

1. **Upload** one or more shelf photos. Optional batch label (e.g. "Shelf 3",
   "Box 4") and free-form batch notes (e.g. "All first editions, signed").
   The user can shoot in-app via the camera modal or pick from the gallery.
2. **Crop** — every incoming photo passes through an inline crop modal so the
   user can frame just the shelf section that matters. "Use full image" skips
   the crop and passes the original through.
3. **Process** — for each photo, an AI vision pass detects book spines as
   bounding boxes; a per-spine OCR pass reads title/author/publisher; a
   six-tier metadata lookup chain fills in ISBN, publisher, year, LCC, DDC,
   subjects; a tag inference pass assigns genre + form tags from a controlled
   vocabulary.
4. **Review** every detected book. Cards show the cropped spine image, the
   inferred metadata, and the tags in three visual zones (identity / tags /
   actions). Same-title duplicates surface a banner with **Merge into this**
   and **Keep both** buttons — never silently merged.
5. **Export** approved books as a LibraryThing-compatible CSV. Approved
   `[Proposed]` tags can be promoted into the controlled vocabulary with a
   one-click GitHub commit. The export ledger writes back to the repo so
   every device shares one view of "what's been shipped."

**Critical constraint:** No data is uploaded to LibraryThing automatically.
The pipeline has a hard stop at the Review screen.

---

## 2. Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| UI | Tailwind CSS, custom Carnegie palette (library green `#1E3A2F` accent, brass `#C9A96E`, marble/limestone surfaces) |
| Fonts | Cormorant Garamond (display / page titles), Source Serif 4 (book titles), Inter (UI), JetBrains Mono (ISBN/LCC) |
| State | React reducer in a single `StoreProvider` (mounted in `app/layout.tsx`, never unmounts) |
| Persistence | `localStorage` for the BookRecord/PhotoBatch state (large data URIs stripped); GitHub repo files for ledger + vocabulary (synced via authenticated routes) |
| Vision / LLM | Anthropic Claude Opus 4.6 (Pass B per-spine OCR), Claude Sonnet 4 (Pass A detection + tag inference) |
| Bibliographic | Open Library `search.json` (t1) → LoC SRU `lx2.loc.gov/sru/voyager` (t2) → ISBNdb (t3) → Google Books v1 (t4) → Wikidata SPARQL (t5) → OCLC Classify (t6) |
| Hosting | Vercel; environment variables: `ANTHROPIC_API_KEY` (required), `GOOGLE_BOOKS_API_KEY` (optional), `ISBNDB_API_KEY` (optional, paid), `GITHUB_TOKEN` (optional, fine-grained PAT with Contents R/W on this repo) |
| Auth | None. Personal-use tool. |

---

## 3. Repository layout

```
carnegie/
├─ app/
│  ├─ layout.tsx                    # Root layout — fonts, dark-mode flash-prevent, StoreProvider, AppShell
│  ├─ page.tsx                      # /upload — dropzone, batch inputs, crop queue, empty-state welcome, processing panel
│  ├─ review/page.tsx               # /review — accent-bordered stat tiles, filter chips, sort, batch grouping, BookCard list
│  ├─ export/page.tsx               # /export — batch checklist, zebra CSV preview, vocab auto-commit, download
│  ├─ ledger/page.tsx               # /ledger — manage exported-books ledger; deletes propagate to repo
│  ├─ globals.css                   # Tailwind base + typography scale (typo-page-title etc) + animations + bookshelf-bg
│  └─ api/
│     ├─ process-photo/route.ts     # Pass A: bounding-box detection (Sonnet) — vertical AND horizontal spines
│     ├─ read-spine/route.ts        # Pass B: per-spine OCR (Opus, Sonnet for clear horizontals)
│     ├─ lookup-book/route.ts       # Bibliographic lookup chain (six tiers)
│     ├─ infer-tags/route.ts        # Tag inference (Sonnet, system prompt + vocabulary)
│     ├─ infer-lcc/route.ts         # AI-inferred LCC fallback (last resort, marked "AI-inferred")
│     ├─ ledger/route.ts            # GET/POST lib/export-ledger.json via GitHub Contents API
│     └─ commit-vocabulary/route.ts # PUT lib/tag-vocabulary.json + lib/vocabulary-changelog.md via GitHub
├─ components/
│  ├─ AppShell.tsx                  # Header (wordmark, three-step nav rail, Ledger button), main, footer
│  ├─ BookCard.tsx                  # Three-zone Review card: identity / tags / actions, with Merge/Unmerge
│  ├─ BatchProgress.tsx             # Progress bar with animated diagonal stripe
│  ├─ ConfidenceBadge.tsx           # HIGH / MEDIUM / LOW pill
│  ├─ CropModal.tsx                 # Inline crop step — canvas-based, brass-accented, queue-aware
│  ├─ ExportPreview.tsx             # CSV preview table — sticky headers, alternating row backgrounds
│  ├─ PhotoUploader.tsx             # Drag-drop + in-app camera modal (getUserMedia, thumbnail strip, brass shutter)
│  ├─ ProcessingQueue.tsx           # Per-photo status list during processing
│  ├─ SpineSelector.tsx             # "Add missing book" — draw a rectangle on the source photo
│  ├─ TagChip.tsx                   # Tag pill, domain-colored or form-styled
│  └─ TagPicker.tsx                 # Tag-add dropdown grouped by domain
├─ lib/
│  ├─ types.ts                      # All shared TS interfaces (BookRecord includes duplicateGroup / mergedFrom etc)
│  ├─ store.tsx                     # Reducer + StoreProvider + processQueue + rereadBook + bulkRetag +
│  │                                #   mergeDuplicates + unmergeBook + keepBothDuplicates orchestrators
│  ├─ pipeline.ts                   # detectSpines, readSpine, lookupBookClient, inferTagsClient,
│  │                                #   buildBookFromCrop, rereadBook, retagBook, flagDuplicates, groundSpineRead,
│  │                                #   loadImage, cropSpine, downscaleForUpload, makeId
│  ├─ book-lookup.ts                # Server-side six-tier cascade and helpers (lookupBook, lookupIsbndb, lookupWikidata, lookupOclcClassify, lookupSpecificEdition, normalizeLcc, etc.)
│  ├─ csv-export.ts                 # CSV_HEADERS, bookToCsvRow, generateCsv, exportFilename, toAuthorLastFirst, toTitleCase
│  ├─ json-backup.ts                # generateBackupJson — companion JSON file alongside each CSV download
│  ├─ export-ledger.ts              # LedgerEntry; localStorage cache + GitHub sync (syncLedgerFromRepo, pushLedgerDelta)
│  ├─ tag-domains.ts                # Vocabulary helpers (domainForTag, FORM_CONTENT/SERIES/COLLECTIBLE)
│  ├─ tag-vocabulary.json           # Controlled vocabulary — domains, tags, form tags, inference rules
│  ├─ vocabulary-update.ts          # findProposedTagsToPromote, buildUpdatedVocabularyJson, buildChangelogEntries
│  ├─ vocabulary-changelog.md       # Append-only log of vocabulary additions (auto-written by approval pipeline)
│  ├─ system-prompt.md              # Tag-inference system prompt with few-shot examples
│  ├─ export-ledger.json            # ← (created on first export when GITHUB_TOKEN is wired) shared dedup ledger
│  └─ archive/                      # Per-session spec docs and superseded status snapshots
│     ├─ carnegie-brand-update.md
│     ├─ carnegie-design-polish.md
│     ├─ carnegie-isbndb-wikidata.md
│     ├─ carnegie-tablet-camera.md
│     ├─ v1.1-feature-plan.md
│     └─ STATUS-V1.0.md             # ← prior status snapshot
├─ public/                          # PWA manifest, sw.js, icons
├─ tailwind.config.ts               # Carnegie theme (accent green, brass, fern, mahogany, domain colors, fonts)
├─ next.config.js
├─ tsconfig.json
├─ package.json                     # version: 2.0.0
├─ README.md                        # User-facing intro / how-to-run
├─ PROJECT-SPEC.md                  # Original spec (legacy reference)
├─ CHANGELOG.md                     # Hand-curated release log; v2.0.0 at the top
├─ STATUS-V2.0.md                   # ← this document
├─ sample-lt-import.csv             # Reference example
└─ .gitignore                       # Excludes /*.jpeg, /*.jpg, .env*.local, node_modules, .next, .vercel, .claude/
```

---

## 4. Frontend architecture

### Three pages, one provider

`app/layout.tsx` wraps the app in `<StoreProvider>` (the single source of
truth for batches, books, processing state, pending File handles, and
ledger sync state) and `<AppShell>` (header + nav + footer). Because the
provider sits at the layout level, it doesn't unmount when the user
navigates between Upload / Review / Export / Ledger — processing
started on /upload keeps running while the user browses /review.

On mount, the provider fires `syncLedgerFromRepo()` so the duplicate
detector reads from a freshly merged cache (remote + local union). The
sync is best-effort: when `GITHUB_TOKEN` is missing or unreachable, it
silently falls back to the local-only cache.

### AppShell

Three-step nav rail centered in the header (Upload / Review / Export);
Ledger lives as a standalone right-anchor button. Wordmark on the left
("CARNEGIE" in Cormorant Garamond, "PERSONAL CATALOGING SYSTEM"
subtitle in brass). Dark-mode toggle is a small text link beneath the
queue summary on the upload page — no longer in the header.

### Upload (`app/page.tsx`)

- Optional **Batch label** + **Batch notes** above the dropzone. Captured
  at queue time so a label change between shots doesn't leak into
  already-queued frames.
- Dropzone or "Take photos" — the camera opens an in-app `getUserMedia`
  modal with a brass shutter, a captured-thumbnails strip, and a "Done"
  text link. Multi-shot stays inside the modal until the user dismisses.
- **Crop step** — every incoming file (camera or gallery) opens
  [CropModal](components/CropModal.tsx). Drag corner / edge handles to
  frame just the shelf, or "Use full image". Multi-file uploads queue
  and crop sequentially. Cropped output is JPEG at 0.92 quality at the
  cropped pixel resolution.
- **Empty-state welcome** when no photos are queued: three-step "How it
  works" flow, photography tips, and lifetime stats pulled from the
  ledger ("47 books cataloged · 3 batches exported"). Disappears the
  moment a photo enters the queue.
- "Process all" calls `store.processQueue()`. The processing panel
  shows photo + spine progress bars, a pulsing accent dot, and a live
  "Current step" line. When the loop finishes, the panel turns green
  with a "Review N books →" CTA.

### Review (`app/review/page.tsx`)

- Five **stat tiles** with 3px left rails (Total: green, Pending: brass,
  Approved: warm green, Rejected: warm red, Low: mahogany). The active
  filter's tile gets a subtle background tint.
- Filter chips, sort buttons, batch grouping with sticky sub-headers.
- BookCards render in three zones:
  - **A — Identity**: spine thumbnail, editable title, metadata row,
    LCC + provenance badge on its own line, banners (previously
    exported, possible duplicate, merged/kept-both, low confidence).
  - **B — Tags**: genre + form rows with `+ add` pickers.
  - **C — Actions** (below a hairline divider): Location field, Notes
    textarea, source badge row, Reread / Reject / Approve buttons. The
    Approve button plays a 320ms brass glow + scale(1.02) pulse on
    transition into the approved state.
- **Duplicate handling** — when Pass A returns multiple records that
  match by ISBN or normalized title+author, every member of the group
  gets a `duplicateGroup` id and a banner: *"Possible duplicate — same
  title found at spine #X and #Y. Merge or keep both?"* Merge folds the
  losers into the winner's `mergedFrom` (snapshots preserved for
  Unmerge); Keep both records both as legitimate separate copies.
- "Add missing book" via [SpineSelector](components/SpineSelector.tsx)
  for spines Pass A missed.

### Export (`app/export/page.tsx`)

- Three-tile summary (Approved / Pending / Rejected).
- Per-batch checklist with split-by-batch toggle.
- **Zebra CSV preview** with sticky headers, alternating marble /
  limestone rows.
- **Vocabulary updates** panel (brass top border) when the export set
  contains `[Proposed]` tags. When `GITHUB_TOKEN` is configured, a
  one-click "Commit N new tags to repo" button hits
  `/api/commit-vocabulary` which PUTs both `lib/tag-vocabulary.json`
  and `lib/vocabulary-changelog.md` via the GitHub Contents API.
  Vercel auto-redeploys per commit, so the next batch picks up the new
  tags. Falls back to the original two-file download workflow when
  the token is absent.
- After a successful CSV download the primary CTA briefly reads
  "Downloaded ✓" in warm green, and `appendToLedger` writes the new
  entries locally + fires `pushLedgerDelta` to update
  `lib/export-ledger.json` in the repo. A status banner under the
  button shows pending / synced / error / local-only with a "View
  commit →" link on success.

### Ledger (`app/ledger/page.tsx`)

- Lists every batch the app remembers exporting, grouped by
  `batchLabel`, with per-batch counts and date ranges.
- `syncLedgerFromRepo()` runs on mount so the page always reflects
  canonical state, not just this device's history.
- "Delete batch" propagates via
  `pushLedgerDelta({ removeBatchLabels: [...] })` so cleanups land on
  every device on next sync.

---

## 5. Pipeline (what `store.processQueue()` actually does)

For each queued `PhotoBatch`:

1. **Pass A — detect spines.** `POST /api/process-photo` sends a
   downscaled (≤1800px long edge, ~300–700KB JPEG) version of the
   image to Sonnet. The detect prompt accepts BOTH vertical (upright
   shelf) and horizontal (laid-flat stack) spines and asks for an
   `orientation` field on each detection, which the route falls back
   to bbox-shape inference for if the model omits it. Raw model text
   is always returned in the response and `console.warn`-logged on
   zero detections.

2. **Pass B — read each spine.** A concurrency-4 worker pool crops
   each detected region from the original full-resolution `File` and
   sends it to `/api/read-spine`. The route picks the model based on
   spine geometry (Sonnet for clear horizontal spines; Opus for narrow
   vertical or hard cases). Auto-retries with Opus when Sonnet returns
   `LOW` confidence.

3. **Lookup chain.** Each book runs through `/api/lookup-book`:
   1. Open Library `search.json` (free, no key) — primary
   2. Library of Congress SRU (free, no key) — authoritative LCC
   3. ISBNdb (`ISBNDB_API_KEY` required, paid) — broadest single book DB; 1 req/sec
   4. Google Books v1 (free, optional `GOOGLE_BOOKS_API_KEY`) — fallback
   5. Wikidata SPARQL (free, no key) — LCC gap-filler
   6. OCLC Classify (free, no key) — final LCC fallback
   Lower tiers never overwrite values from higher-priority tiers; they
   only fill gaps.

4. **Tag inference.** `/api/infer-tags` calls Sonnet with the
   `lib/system-prompt.md` rules and the current
   `lib/tag-vocabulary.json`. New domain-relevant tags are returned
   prefixed with `[Proposed]`; the user reviews them and the export
   step promotes accepted ones into the vocabulary.

5. **Grounding.** `groundSpineRead()` cross-checks the OCR'd
   title/author against the lookup result and downgrades confidence
   when they disagree — surfaces as a warning banner on the BookCard.

6. **Duplicate flagging.** `flagDuplicates()` groups books from the
   same photo by ISBN-or-title+author and marks each group member
   with a shared `duplicateGroup` id and a "Possible duplicate"
   warning. Never silently collapses entries.

7. **Ledger flagging.** `flagIfPreviouslyExported()` cross-checks each
   book against the export ledger (refreshed at app load). Hits get
   auto-rejected with a "Duplicate — previously exported on YYYY-MM-DD"
   banner; the user can still approve to ship a second copy.

---

## 6. Storage / persistence

### Local (`localStorage`)

- `carnegie:state:v1` — full BookRecord/PhotoBatch state, with
  `spineThumbnail` and `ocrImage` data URIs stripped to stay under
  quota.
- `carnegie:export-ledger:v1` — ledger cache.
- `carnegie:export-ledger:remote-available:v1` — last-known repo
  availability so the UI can render the right CTA without waiting on
  a probe.
- `carnegie:dark` — dark-mode preference.

### Repo-backed (`GITHUB_TOKEN` required)

- `lib/tag-vocabulary.json` — controlled vocabulary, replaced
  wholesale by `/api/commit-vocabulary` on each promotion run.
- `lib/vocabulary-changelog.md` — append-only log; new entries slot
  in above the trailing comment marker.
- `lib/export-ledger.json` — duplicate-detection ledger;
  `/api/ledger` accepts deltas (`add`, `removeBatchLabels`,
  `clearAll`) and applies them server-side against a freshly fetched
  remote state, so two devices writing concurrently won't clobber
  each other.

### Working memory (refs, not persisted)

- `pendingFiles: Map<string, File>` — the original full-res `File`
  handles, used by Pass A crop, "Add missing book" Path A, and
  reread. Lost on hard reload; affected batches survive but become
  unprocessable.

---

## 7. What changed from v1.0

- **Brand rebuild**: Princeton orange → Carnegie palette (library
  green, brass, marble/limestone, mahogany, fern). Cormorant Garamond
  wordmark and page titles. Warmer dark mode (`#2E2924` cards,
  `#3D2E1A` warning banners).
- **Lookup chain widened**: ISBNdb at tier 3 and Wikidata at tier 5
  joined the original Open Library + LoC + Google Books + OCLC
  cascade.
- **Pass A accepts horizontal spines**: laid-flat stacks now detect
  alongside upright shelves. Each detection carries an `orientation`
  field.
- **Camera rebuilt**: `getUserMedia` modal replaces the file-picker
  capture path (fixes Samsung Chrome OS-picker flash). Thumbnail
  strip alongside the live video, brass shutter, "Done" text link.
- **Inline crop step**: every incoming photo passes through
  [CropModal](components/CropModal.tsx) before the queue. Canvas
  crop, eight handles, rule-of-thirds guides, "Use full image" skip.
- **Dedup is flag-only**: same-title bboxes are no longer silently
  merged. Per-card banner with **Merge into this** / **Keep both**;
  merged records carry an **Unmerge** button that restores the
  losers from `mergedFrom` snapshots.
- **Export ledger lives in the repo**: `lib/export-ledger.json` shared
  across devices via `/api/ledger`. localStorage is now a cache.
- **Vocabulary auto-commit**: `/api/commit-vocabulary` PUTs the new
  vocabulary + changelog entry directly when `GITHUB_TOKEN` is set,
  replacing the manual two-file download workflow.
- **Nav reshuffle**: three-step nav rail (Upload / Review / Export);
  Ledger as a standalone button; dark-mode toggle as a small text
  link on the upload page.
- **Design polish (eight sections)**: typography hierarchy locked to
  five levels, 8px spacing grid, BookCard zones (identity / tags /
  actions) with hairline dividers, micro-interactions on
  approve/reject/tag-remove, upload empty-state welcome with lifetime
  stats, accented stats tiles, zebra CSV preview with sticky headers,
  warmer dark-mode card surfaces.
- **PWA + lifetime stats** carried over from v1.1 features (manifest,
  service worker, installable on tablet home screens; ledger-derived
  "books cataloged · batches exported" line on the empty state).

The git history through `b9a015c` → `3f82b21` (commits in
[CHANGELOG.md](CHANGELOG.md)'s v2.0.0 section) covers the cohort that
got tagged.

---

## 8. Reasonable next moves (not committed yet)

These are deliberate non-goals for v2.0 — listed so a future session
doesn't confuse "missing" with "not yet decided":

- **Per-spine model selector retry tuning** — auto-retry with Opus on
  Sonnet `LOW` confidence is in place; the area/aspect thresholds
  haven't been re-measured against the v2 horizontal-spine corpus.
- **Cross-fade on reread** — section 4 of the polish spec asked for
  cross-fading old→new field values when a reread completes; only the
  retagging-pulse half landed.
- **Per-queue-item progress bars** — section 5 of the polish spec.
  Would need pipeline progress events surfaced into the
  `ProcessingQueue` component.
- **Atomic vocabulary commits** — `/api/commit-vocabulary` writes one
  commit per file (vocab + changelog). Could be a single commit via
  the Git Data API; would reduce double-deploy noise on Vercel.
- **Mobile crop UX** — `CropModal` works on touch via pointer events
  but the corner-handle hit area could be larger on small screens.
- **Ledger-driven empty-state heatmap** — the lifetime stats line
  ("47 books cataloged · 3 batches exported") could grow into a
  small per-domain bar, useful enough to be worth an experiment.

---

## 9. Environment variables

| Var | Required? | Used by |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Yes** | All AI passes (detect, OCR, infer-tags, infer-lcc) |
| `GOOGLE_BOOKS_API_KEY` | No | Lookup tier 4. Falls back to anonymous if absent. |
| `ISBNDB_API_KEY` | No | Lookup tier 3 (paid). Skipped silently when absent. |
| `GITHUB_TOKEN` | No | Vocabulary auto-commit + ledger sync. Without it, both fall back to local-only. Fine-grained PAT scoped to this repo with **Contents: Read and write**. |
| `GITHUB_REPO` | No | Defaults to `GonzoDuke/carnegie`. |
| `GITHUB_BRANCH` | No | Defaults to `main`. |
