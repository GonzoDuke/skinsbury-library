# Carnegie — Changelog

A consolidated log of significant changes, organized by archived spec document.
Source documents live in [lib/archive/](lib/archive/). Newest first.

---

## v5.0.0 — 2026-05-05

Library-surfaces release. The app gains two new ways to browse the cataloged
collection (Shelflist by LCC class, LCSH by subject heading), the cross-device
sync model is simplified, and the lookup pipeline becomes deterministic.
Detailed retrospective in [CHANGELOG-V5.0.md](CHANGELOG-V5.0.md).

### Library surfaces
- **Shelflist** (`5e00dfc`): two-level LCC-class accordion at `/shelflist`.
  Top level always shows all 21 LCC class letters (open-world principle);
  empty classes render at reduced opacity. Sub-classes only appear when
  populated. Books listed by full LCC ascending. SessionStorage-persistent
  expand state.
- **LCSH browse** (`523b864`, `dc3a8bb`): new `/lcsh` route with an index of
  every Library of Congress Subject Heading drawn from approved books,
  filterable + sortable A→Z or by book count. `?h={encoded}` flips to a
  per-heading detail view listing books carrying it, sorted by author last
  name then title. Headings treated as opaque atoms — no subdivision
  splitting. Clickable LCSH chips on book detail panels (commit 2) link
  directly to `/lcsh?h={heading}` so the user can browse siblings of any
  heading they encounter while reviewing.

### Multi-copy handling
- **Format-aware copies** (`430977d`): records sharing a `work_group_id`
  are different physical copies of one work — Hardcover, Paperback,
  Audiobook etc. as separate rows. Review surfaces show an `X of N · {format}`
  indicator with a 2px gold left-edge connector grouping siblings visually.
  `detectDuplicates` exempts groups where every entry shares the same
  non-empty `work_group_id` so legitimate copies don't get flagged.
  CSV export gains a BINDING column populated from `book.format`.
  AddCopyModal is the primary path for creating linked copies.

### Taxonomy refactor
- **21-domain strict-LCC taxonomy** (`4fd58be`, `18e46f0`): vocabulary
  refactored from 12 domains to 21 — one per LCC class letter (A–Z, skipping
  I/O/W/X/Y per LCC). Hand-written starter vocabularies for Law, Medicine,
  and Education only; other new domains (Agriculture, Technology, Military
  science, Naval science) start empty and grow organically. Open-world
  principle: every domain stays visible everywhere it's enumerated, even
  when empty.
- **Fiction tag auto-derived** (`f1c5feb`): the `Fiction` form tag is now
  derived deterministically from `lcc` + `lcshSubjects` post-inference,
  not asked of Sonnet. Books in the language/literature LCC range with no
  Drama/Poetry LCSH signal pick up Fiction automatically. Plays and verse
  excluded.

### Pipeline determinism + correctness
- **`temperature: 0` across all Anthropic calls** (`4940187`): six call
  sites — `/api/process-photo`, `/api/read-spine`, `/api/infer-tags` (×2),
  `/api/infer-lcc`, `/api/identify-book` — now run at temperature 0 for
  reproducible spine reads, tag inference, LCC inference, and book
  identification.
- **Phase 2 fan-out on Reread / matchEdition path** (`d272284`):
  `lookupSpecificEdition`'s three early-return tiers (OL-by-ISBN,
  year-scoped, ISBNdb-direct) were short-circuiting before MARC + GB +
  Wikidata + OL-by-ISBN fired. MARC is the only source of `lcshSubjects`,
  so any book Reread'd through this path lost its LCSH headings — and books
  processed before MARC was wired in were never re-enriched. Fix: extracted
  the fan-out + gap-fill merge into a shared `enrichWithIsbnFanout` helper
  called from both `lookupBook` and all three `lookupSpecificEdition`
  branches. The fix shipped between LCSH commit 1 and commit 2 because
  without it the LCSH browse looked broken on a real library.

### Atomic commits
- **Vocabulary atomic Git Trees commit** (`28a80f3`): refactored
  `/api/commit-vocabulary` from sequential PUT-then-PUT to a single Git
  Trees commit. Both `lib/tag-vocabulary.json` and
  `lib/vocabulary-changelog.md` now land in one commit, eliminating the
  drift window the old pattern allowed when the second PUT failed.
- **Export backups via atomic commit** (`5bee972`): new `/api/export-backup`
  route writes per-export JSON backups under `data/export-backups/` AND
  applies the ledger delta in a single atomic Git Trees commit. Replaces
  the previous client-download-then-fire-and-forget-ledger-PUT pattern.
  Commit message: `"Export backup: {batch label} ({N} books)"`. Local-only
  mode and any failure path fall back to client-side JSON download so the
  user never loses a backup.

### Local-only mode
- **Sidebar / gear-menu toggle** (`f615dca`): suppresses every GitHub write
  (ledger, corrections, vocabulary, export-backup) and falls back to
  localStorage-only behavior. Visible indicator: 2px gold bar fixed to the
  top of the viewport whenever active. Mobile gear icon also gets a small
  gold dot in the top-right corner. Built for local iteration without
  filling commit history with debug data.

### Capture polish
- **Manual entry modal** (`bd8daec`): 2×2 grid (title/author/year/ISBN)
  shared by Upload and Review surfaces. Manual books still flow through
  Phase 1 + Phase 2 lookup so they receive the same enrichment as
  photo-detected ones.
- **Auto-default batch labels** (`8cdfc83`): batches without a user-supplied
  label auto-default to `Shelf {date}`, `Scans {date}`, or `Manual {date}`
  depending on origin. Inline-editable on Review and Export.
- **Sync on edit** (`2eb80dd`, `999e0df`): manually-entered and
  individually-scanned books now push to GitHub on success; debounced
  post-mutation push for all BookRecord edits. Replaces the old
  push-once-at-process-end pattern.

### Cross-device sync simplification
- **Pending-batches removal** (`001fa05`): the phone-capture-then-desktop-
  pickup workflow built in v3 was removed. The use case had shifted to
  single-device-per-session, the commit churn was severe (~30+ commits per
  session was typical), and the alternative paths (export-ledger sync +
  corrections sync + vocabulary sync + export-backup sync) cover what's
  actually used. `lib/pending-batches.ts`, `app/api/pending-batches/`, and
  the related store actions all deleted.

### Reverted experiments
- **Splash page lived briefly** (`c974023` / `c46c838`): a chrome-free splash
  establishing Jonathan M. Kelly authorship was live in production for a
  short window 2026-05-05 before being reverted. Original `/upload`
  redirect restored; the splash component is preserved as a commented-out
  block at the top of `app/page.tsx` for future use.
- **Stacks / Collection landing page** (`6494b43` … `f0b28f9`): a new
  library landing page with hero, stats, and tool entry points was tried
  in two iterations and reverted in favor of the layout-density pass and
  later the History → utility-surface demotion (`14cc706`).

### Misc
- `390b3e4` populate title/author/cover at all `lookupSpecificEdition`
  branches that were silently dropping them.
- `123ff04`/`dee738a` add Duplicates & Editions and Authority Check tools
  (lived in /stacks; Stacks page reverted).
- `b3afb67`/`18d4e23`/`97d8e3f` typography + density passes — page titles
  bumped to 28px, sidebar-nav font 16px, layout density tightened on Upload
  and Stacks.
- `28a80f3` vocab commit refactor (atomic Git Trees, foundation for the
  later export-backup route).

### v5.0.0 release tag
- `24ddef3` v5.0.0 — bump package.json + footer reads `ver. 5.0`.

---

## v3.5.0 — 2026-05-02

Separate-copies fix. The dedup flow was silently merging records that were
legitimately distinct physical copies of the same title. Two changes:

- **Killed the silent ISBN dedup pass on Review mount.** It used to remove
  any same-ISBN-within-batch entries on page load with only a toast for
  notice. `flagDuplicates` already flags duplicates with a Merge / Keep-both
  banner, so the silent removal was redundant *and* destructive when a
  reader genuinely owned two copies. Removed the on-mount pass plus its
  toast UI.
- **Added an "Add copy" button** to the BookCard expanded panel. Clones the
  record with a fresh id, prefixes notes with `Copy N.` (numbered by
  spine-position lineage so repeated clicks increment cleanly), resets
  status to pending, clears all duplicate/merge/exported flags, and inserts
  the clone immediately after its source in the same batch. Recovers the
  second copy when a prior session already auto-merged it away.

---

## v3.0.0 — 2026-05-02

Mobile-first release. The app stops being a desktop tool that "also works on
the phone" and becomes one that's actually pleasant to use from a phone, with
the desktop layout untouched. Three threads:

### Phone shell + cross-device sync
- **Mobile shell** (`bdc5c3e`, `1722898`, `6d51b64`): viewport-gated split.
  Phone gets a 48px navy top bar (CARNEGIE wordmark + spine-stack mark + New
  session and About icon buttons on the right) and a four-tab bottom bar —
  Capture / Review / Export / Vocab — with iOS safe-area insets honored. The
  desktop sidebar is unchanged.
- **Pending-batch sync** (`bdc5c3e`): each finished batch posts to
  `data/pending-batches/{id}.json` via the new `/api/pending-batches` route,
  so a phone capture appears on the tablet/desktop on next load. Pull on app
  load + a manual "Refresh from cloud" button on the Review header and
  Capture screen. Files delete on CSV export and on Clear/New-session.
  Token-missing returns 501 cleanly; UI continues with localStorage only.
- **Phone Review cards** (`bdc5c3e`): `MobileBookCard` replaces the desktop
  table on phone — full cover, title/author/ISBN/year row, confidence badge,
  tag pills, ✓/✕ buttons. Tap to expand the same inline `Editable` helper
  the desktop detail panel uses (extracted into `components/Editable.tsx`).

### Capture flow polish
- **Camera right-side shutter + prominent Done pill** (`fe44da6`): landscape
  grip moves the shutter to the right edge; the Done action is a solid white
  pill at top-right above the camera-feed gradient.
- **Camera shots route through CropModal** (`9ab743d`): captures queue in a
  session-local ref and flush to the parent on Done, so the CropModal opens
  on a clean stack instead of fighting the camera modal's z-index.
- **Photo queue surfaces every batch** (`9ab743d`): `<ProcessingQueue>` is
  mounted on the Upload page so error rows ("Image too small …") no longer
  vanish silently. Per-row remove button included.
- **Realistic min-image-width + max-resolution camera ask** (`9ab743d`):
  `MIN_IMAGE_WIDTH` lowered from 1500 → 1200 (phone cameras often deliver
  1280×720); `getUserMedia` now hints `width: { ideal: 3840 }` so devices
  with 4K rear sensors deliver them.
- **Sticky phone Process-all** (`e4d95cc`): single full-width CTA pinned
  above the bottom tab bar, only when the queue is actionable.

### Vocabulary phone redesign
- **Single-stack phone view** (`5856022`, `9c0fbcc`): horizontal scrollable
  domain pills at the top (All selected by default), single-column tag rows
  below (name, domain, usage count), sticky Add-tag panel at the bottom
  (input + select + full-width Add button) above the tab bar. Delete is
  desktop/tablet only. Verified at 375×812 portrait — no overflow.

### Other
- **Phone vocab + bottom tabs include Vocab** (`6d51b64`): four tabs evenly
  spaced; three-spine BooksIcon matches the desktop sidebar glyph.
- **About page** (`75a4581`): static editorial page at `/about` — 80px
  Carnegie-tartan bar, 640px text column, Outfit typography, five-stage
  pipeline list, Built with / Built by sections. Sidebar gets an info-circle
  About item above the stats footer; phone header pairs an info icon next to
  New session.
- **Upload page UX** (`5de5f9f`): dropzone is now the first thing under the
  page title; batch label / notes inputs moved below it. Inline (i) tips
  button removed from the dropzone copy.

### Known constraints carried into v3
- Phone post-process edits (`updateBook`) still don't push back to the repo
  — the sync is push-once at process-end. Refresh button covers the
  practical gap; live edit-sync is deferred.
- Pipeline (`lib/pipeline.ts`, `/api/process-photo`, `/api/read-spine`,
  `/api/lookup-book`, `/api/infer-tags`, `/api/commit-vocabulary`) untouched
  in this release.

---

## v2.0.0 — 2026-05-01

A cohort of features and a full design polish pass. The shape of the app is the
same — Upload → Review → Export — but the rough edges from v1 have been ground
down: cropping happens in-app, the ledger is shared across devices, vocabulary
promotions auto-commit, and the visual hierarchy now reads as a finished
product instead of a working prototype.

### Capture
- **In-app camera modal** (`5ee3e22`, `11e0270`): replaced the OS file-picker
  capture path with a `getUserMedia` stream rendered inside a 70vh card with
  a thumbnail strip, brass shutter, and "Done" text link. Fixes a Samsung
  Chrome regression that flashed the file picker before launching the camera.
- **Inline crop step** (`3f82b21`): every incoming photo — camera or gallery —
  passes through a canvas-based [CropModal](components/CropModal.tsx) before
  it joins the queue. Drag corner / edge handles to frame just the shelf
  section, or tap "Use full image". Multi-file uploads queue and crop
  sequentially.
- **Pass A relaxed for horizontal spines** (`71253fb`): the detect prompt now
  accepts books lying flat with the spine facing the camera, in addition to
  upright shelf books. Each detection carries an `orientation` field
  ('vertical' | 'horizontal') for downstream consumers, inferred from bbox
  shape when the model omits it. Raw model output is also surfaced in the
  response and `console.warn`-logged on zero detections.

### Duplicates
- **Flag-only dedup with Merge / Keep-both / Unmerge** (`a83e02d`): replaced
  silent auto-merge with a per-card "Possible duplicate" banner that lets the
  user decide. Merging stashes the losers in `mergedFrom` so Unmerge can
  restore them as separate cards.
- **Export ledger lives in the repo** (`fcbfe01`): moved the duplicate-detection
  ledger from localStorage to `lib/export-ledger.json` via a new
  [/api/ledger](app/api/ledger/route.ts) route. App load syncs from GitHub;
  exports POST a delta; ledger management screen propagates deletions. Falls
  back to localStorage-only when `GITHUB_TOKEN` isn't configured.

### Vocabulary
- **Auto-commit promotions** (`7243ba6`): one-click "Commit N new tags to repo"
  on the Export screen replaces the manual two-file download workflow. The
  new [/api/commit-vocabulary](app/api/commit-vocabulary/route.ts) route uses
  the GitHub Contents API to update both `lib/tag-vocabulary.json` and
  `lib/vocabulary-changelog.md`. Vercel auto-redeploys per commit.

### UI / chrome
- **Nav reshuffle** (`b9a015c`): centered nav rail holds only the three core
  steps (Upload / Review / Export); Ledger moves to the right anchor as a
  standalone button. Dark-mode toggle becomes a small text link beneath
  the queue summary on the upload page.

### Design polish (eight sections — `ee529f1` → `8858727`)
Source: [lib/archive/carnegie-design-polish.md](lib/archive/carnegie-design-polish.md)

1. **Typography hierarchy** — five-level scale (`typo-page-title`,
   `typo-page-desc`, `typo-card-title`, `typo-card-meta`, `typo-label`)
   centralized in globals.css.
2. **Spacing system** — 8px-grid alignments across page sections, BookCard
   padding `py-5 px-6`, stats tiles 16px internal, 32px gap below stats.
3. **BookCard zones** — A (identity) / B (tags) / C (actions) with a
   limestone hairline divider; LCC pulled onto its own line with provenance
   badge.
4. **Micro-interactions** — brass approve-pulse on first approve,
   warm-red reject hover, scale-in tag × icon on hover.
5. **Upload empty state** — "How it works" three-step flow + tips list +
   lifetime stats from the ledger; disappears once a photo is queued.
6. **Stats tiles** — 3px left rail per accent, 28px / weight 600 numbers,
   active-filter background tint.
7. **Export polish** — alternating zebra rows in the CSV preview, sticky
   column headers, brass top border on the vocabulary section, brief
   "Downloaded ✓" success state on the primary CTA.
8. **Dark mode warmth** — card surfaces shift to `#2E2924` with `#4A4540`
   borders; warning banners switch to a deep amber (`#3D2E1A`); tag-pill
   dark-mode opacity bumps from /30 to /45 for better presence.

---

## 2026-05-01 — Tablet camera capture (multi-capture loop)

Source: [lib/archive/carnegie-tablet-camera.md](lib/archive/carnegie-tablet-camera.md)
Shipped: `649f2a8` — Tablet camera: multi-capture loop with auto-rename and floating Done bar
Follow-up: `5ee3e22` — Camera: switch to in-app getUserMedia stream to fix Samsung Chrome

- Added a "Take photos" button to the Upload screen that opens the device rear camera.
- Each shot lands in the upload queue as `shelf-capture-NNN.jpg` (sequential auto-rename).
- Camera reopens automatically after each capture; "Done taking photos" floating bar exits the loop.
- Landscape-orientation reminder toast (2s) on first tap.
- The original `<input capture="environment">` approach was later replaced by an in-app `getUserMedia`-driven fullscreen video + canvas shutter to fix a Samsung Chrome regression that flashed the OS file picker.

---

## 2026-05-01 — Lookup chain: ISBNdb (tier 3) and Wikidata (tier 5)

Source: [lib/archive/carnegie-isbndb-wikidata.md](lib/archive/carnegie-isbndb-wikidata.md)
Shipped: `3628424` — Lookup chain: add ISBNdb (tier 3) and Wikidata (tier 5)

- Updated cascade: Open Library → LoC SRU → **ISBNdb** → Google Books → **Wikidata** → OCLC Classify.
- ISBNdb (paid, `ISBNDB_API_KEY`): broadest single book DB. Search by title+author or direct `/book/{isbn13}`. 1 req/sec rate limit. Skipped silently when key absent.
- Wikidata (free, no key): SPARQL endpoint, primarily an LCC gap-filler before OCLC Classify. Pulls LCC, DDC, ISBN, publisher, publication date.
- Neither tier overwrites values from higher-priority tiers — they only fill gaps.
- BookCard: dark-blue "ISBNdb" badge; "from Wikidata" badge slots into the LCC provenance hierarchy (spine > LoC > Wikidata > OCLC > OL).

---

## 2026-04-30 — Carnegie brand and UI update

Source: [lib/archive/carnegie-brand-update.md](lib/archive/carnegie-brand-update.md)
Shipped: `18f7358` — Carnegie rebrand — library palette, Cormorant wordmark, tighter UI
Follow-ups: `b503b5d`, `11ab3db`, `74c564d`, `9a97fca`, `2676212`, `6fe2354`, `d9a3c56`

- Replaced the Princeton-orange (`#C85A12`) accent system with a library palette: green `#1E3A2F`, brass `#C9A96E`, fern `#2D5A4A`, marble `#F5F2EB`, limestone `#E8E2D4`, mahogany `#8B4513`.
- Header switched to Cormorant Garamond wordmark; library green background with brass active-nav pills; dropped the icon/logo.
- Upload screen: hero line above dropzone; photography hints moved inside the dropzone; batch label/notes moved above the dropzone.
- Review screen: brass-toned stat tiles, mahogany for low-confidence/warning states; floating "Approve remaining" recolored to brass on green.
- Dark mode: green lifted to fern for contrast; limestone text; warm dark surfaces preserved.
- Tag domain colors and the three-screen flow were left untouched — purely a visual pass.

---

## 2026-04-30 — v1.1 feature plan (six features)

Source: [lib/archive/v1.1-feature-plan.md](lib/archive/v1.1-feature-plan.md)
Shipped across `e1c53d9`, `2a5a79d`, `25e0c72`, `b62bc7f`, `9cc50b8`

1. **Add missing book on Review** — draw on the source photo or enter manually; runs through the lookup → tag-inference pipeline.
2. **OCLC Classify as t5** — free LCC/DDC gap-filler when prior tiers miss. Provenance badge "from OCLC". (Subsequently became part of the broader cascade alongside ISBNdb and Wikidata.)
3. **Approved-tag feedback loop** — at export time, `[Proposed]` tags on approved books promote into the vocabulary; the user downloads an updated `tag-vocabulary.json` and a `vocabulary-changelog-additions-*.md` to commit.
4. **Bulk re-tag** — re-run inference on selected/approved/by-domain books without touching other metadata; preserves user-added tags via merge logic. BookCard checkboxes added for selection.
5. **Per-spine model selector** — Sonnet for easy spines (large area, low aspect ratio), Opus for hard ones; auto-retry with Opus when Sonnet returns LOW confidence.
6. **PWA / Add to Home Screen** — `manifest.json`, 192/512 icons, minimal `sw.js`, mobile camera input. Installable from a phone or tablet home screen, launches in standalone mode.

---

## 2026-04-29 — Initial vocabulary baseline

Source: [lib/vocabulary-changelog.md](lib/vocabulary-changelog.md)

- 12 domains, 60 genre tags, 8 form tags built from a 186-book LibraryThing export, a 22-book proof of concept, and a 16-book shelf scan.
- Subsequent vocabulary additions are tracked in [lib/vocabulary-changelog.md](lib/vocabulary-changelog.md), not here.

---

## How this file is maintained

This `CHANGELOG.md` is hand-curated from session-spec documents in [lib/archive/](lib/archive/) and the git history. When a new spec ships, append a section at the top with: source file link, ship commit(s), and a bulleted summary. Vocabulary additions stay in [lib/vocabulary-changelog.md](lib/vocabulary-changelog.md) — they're append-only and don't need to be duplicated here.
