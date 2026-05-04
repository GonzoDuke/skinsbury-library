# Carnegie — retrospective changelog (v4.0)

**Window:** 2026-04-30 (initial commit) → 2026-05-04
**Total commits:** 191 (182 source/data + v4 bump + merge commit + 7 post-merge enhancement commits)
**Generated from:** `git log --pretty=format:'%h %ad %s' --date=short --reverse`

This is the development arc of Carnegie, organized into chronological phases and grouped by feature area within each phase. Where the path took a detour or a previously-shipped approach was reversed, those moments are called out explicitly. Auto-generated cross-device sync commits (`Pending batch unlabeled/removed: …`) are present in the history as background noise — they document the phone-capture sync working but don't represent feature changes, so they're aggregated rather than listed individually.

---

## Phase 1 — Foundation day (2026-04-30, 25 commits)

The entire base of the app, including the rebrand, shipped on day one. Compressed timeline tells you something about the developer: a clear product spec going in, no wasted motion.

### Initial build — pipeline + UI scaffold
- `bac0044` initial build
- `5fe531e` Two-pass spine pipeline + lookup hardening
- `eb9606d` Wider layout, larger type, prominent processing UI
- `3dda876` Make processing durable across navigation; tag Shakespeare as Drama
- `bf2e71c` Add generic Poetry tag (and British poetry) so all verse is one bucket

The two-pass pipeline (Pass A spine detection + Pass B per-spine OCR) was load-bearing from commit two onward. Tag-vocabulary edge cases (Shakespeare → Drama, all verse → Poetry) surfaced immediately and got hard-coded into the system prompt.

### Lookup pipeline + spine LCC
- `226bbfb` Read LCC off the spine and use it as the authoritative classification
- `0428dd9` Canonical LCC format + LoC SRU fallback + sort by confidence
- `60ee97a` Streamline pipeline: parallel spines, two-tier vision, no-match short-circuits
- `f81b0d6` Downscale shelf photos before upload to /api/process-photo
- `98fccd6` Fix lookup query layer: strip 'ed.', drop subtitle, cascade tiers

The "trust the spine when it has an LCC" rule arrived early — physical-spine LCC outranks any database-derived one. Photo downscaling was a Vercel-payload pragmatic fix.

### **Reversal** — Sonnet-first Pass B regression
- `8efe27c` Reread: per-book retry with optional typed hint
- `6baa0da` **Revert Sonnet-first Pass B** — accuracy regression on real photos
- `b62bc7f` Feature 5: Per-spine model selector with auto-retry on LOW

The first attempt to use Sonnet for every spine produced confident hallucinations on hard (narrow / vertical) spines. Reverted to Opus-default and reintroduced as a per-spine model picker — Sonnet for "easy" spines (large area, modest aspect ratio), Opus for hard ones. This hybrid is still in place 180 commits later.

### UX polish + LT export wiring
- `24ca899` Title Case for titles + edition-specific Reread
- `52f32e8` AI Reread merges user edits + Batch labels (Collections + tags)
- `a1518fd` Notes (batch + per-book) → LT COMMENTS; preserve dotted initialisms
- `4cabd8c` Reread: stop clobbering user edits and manual tags

The "AI must not overwrite my edits" principle landed here and never wavered.

### **Reversal** — Skinsbury → Carnegie rebrand
- `7e4996a` Rebrand: "The T.L. Skinsbury Library" + Princeton orange accent
- `18f7358` Carnegie rebrand — library palette, Cormorant wordmark, tighter UI
- `b503b5d` Carnegie becomes the user-facing brand

Initial brand was "T.L. Skinsbury Library". Within hours of shipping it the brand was rebuilt as Carnegie — Andrew Carnegie, the libraries-as-public-good benefactor — with the Cormorant Garamond wordmark (later replaced; see Phase 3).

### v1 features in a row
- `fb9ff92` Feature 1: Add missing book on Review (draw on photo or manual entry)
- `e1c53d9` Feature 2: LCC tiers 5+6 — LoC SRU title+author + AI-inferred fallback
- `2a5a79d` Feature 3: Approved-tag feedback loop
- `25e0c72` Feature 4: Bulk re-tag + BookCard checkboxes
- `53038c1` v1.0 status & architecture document

Six features numbered 1–6 inside a single day. Feature 3 — the approved-tag feedback loop — is the early version of what later becomes the corrections log + few-shot prompt.

---

## Phase 2 — Polish, dark mode, PWA (2026-05-01, 51 commits)

Day two was almost entirely about presentation, with the lookup chain expanded mid-day to add ISBNdb + Wikidata.

### Header + dark mode
- `11ab3db` Header polish, aligned batch inputs, light-mode default, warm dark mode
- `74c564d` Header: Carnegie wordmark hits — 56px, weight 500, wider letter-spacing
- `9a97fca` Dark mode: Carnegie's robber-baron study, not a void
- `2676212` Dark mode: lighter and actually workable
- `574b899` Title Case: stop preserving false-positive acronyms

Dark-mode mood was iterated three times in one day before settling. The "robber-baron study" framing — warm, lit, leather — is preserved in the current dark surfaces.

### Per-book Location, ledger, header re-plant
- `ae579dc` Per-book Location, export-ledger duplicate detection, header replanted
- `6fe2354` Header: CARNEGIE wordmark sized to match subtitle; nav rail holds the hero

The export ledger ships here. Duplicate detection becomes a first-class feature.

### PWA + tablet camera + lookup chain expansion
- `9cc50b8` Feature 6: PWA — installable Carnegie with home-screen icon and rear-camera shortcut
- `649f2a8` Tablet camera: multi-capture loop with auto-rename and floating Done bar
- `3628424` Lookup chain: add ISBNdb (tier 3) and Wikidata (tier 5)
- `d50a1cb` Permanent JSON backup per CSV + Ledger management screen
- `5ee3e22` Camera: switch to in-app getUserMedia stream to fix Samsung Chrome

ISBNdb (paid tier 3, broadest single source) and Wikidata (free LCC gap-filler via SPARQL) join the lookup chain. The cascade is now: OL t1-t4 → Google Books → LoC SRU → ISBNdb → Wikidata. (Reordered to ISBNdb-first 6 weeks worth of git-history later — see Phase 5.)

### Docs cleanup + camera modal redesign + horizontal-spine detection
- `d9a3c56` Docs: rebrand skinsbury-library to carnegie in README and PROJECT-SPEC
- `c7b355d` Drop stale root system-prompt.md, point README at lib/system-prompt.md
- `92e7feb` Docs: archive per-session specs to lib/archive, add consolidated CHANGELOG
- `11e0270` Camera: redesign capture modal with thumbnail strip and softer controls
- `71253fb` Pass A: detect horizontal spines (laid-flat stacks), expose raw text

Pass A learns to detect spines in horizontal stacks (books lying flat), not just upright on shelves.

### Dedup philosophy + cross-device GitHub sync
- `a83e02d` Dedup: flag-only with Merge / Keep-both / Unmerge — never auto-collapse
- `7243ba6` Vocabulary: auto-commit promotions to repo via GitHub Contents API
- `fcbfe01` Ledger: sync export-ledger.json to repo via GitHub API

Two architectural shifts in adjacent commits. Dedup is now flag-only (the user always decides) — what was "auto-merge" becomes a banner with Merge / Keep-both / Unmerge buttons. Vocabulary and ledger both gain GitHub-as-database sync via the Contents API. This is where Carnegie stops being a single-device app.

- `b9a015c` Header: drop Ledger from nav rail, swap dark-mode toggle for Ledger button

### The 8-step polish series
- `ee529f1` Polish 1/8: typography hierarchy — five-level scale
- `1528597` Polish 2/8: spacing system — 8px-grid alignments
- `315d1d0` Polish 3/8: BookCard zones — A identity / B tags / C actions
- `47956f1` Polish 4/8: micro-interactions on approve, reject, tag-remove
- `8a0f7e6` Polish 5/8: Upload empty state — How it works + lifetime stats
- `390db17` Polish 6/8: Review stats tiles — left-rail accents + active highlight
- `4b08a0f` Polish 7/8: Export screen — zebra preview, sticky headers, success state
- `8858727` Polish 8/8: dark-mode card warmth + deep-amber warnings + denser tags

A deliberately-numbered eight-commit polish pass. The five-level type scale, 8px grid, and three-zone BookCard structure (identity / tags / actions) survive into v4.

### Cropping + cover art
- `3f82b21` Crop step: inline modal between camera/gallery and the queue
- `923f508` Crop: lock the data flow — cropped File replaces original end-to-end
- `c4de6ad` Dedup banner: render Merge / Keep both whenever the warning fires
- `13e88ec` Cover art: capture during lookup, render on the BookCard

Cover art lands. The 60px cover thumbnail in the Review row dates from this commit.

### v2.0 release tag
- `38fcd60` Tag v2.0.0 — bump package.json + CHANGELOG release section
- `2ac1de3` Status: archive v1.0 snapshot, add fresh STATUS-V2.0.md

### **Major architectural shift** — v3 redesign (10-commit series)
- `1e58f52` Redesign 1/10: sidebar navigation + content column
- `c5fa725` Redesign 2/10: palette swap to Carnegie navy + tartan-derived semantics
- `95a19c3` Redesign 3/10: typography swap to **Outfit + JetBrains Mono** (replaces Cormorant)
- `dde31b7` Redesign 4/10: Review screen — compact table with book covers
- `65f18b7` Redesign 5/10: Carnegie tartan logo + sidebar accent stripe
- `194a3c5` Redesign 6/10: Upload + Export restyle to v3
- `b22327f` Redesign 7/10: Vocabulary screen — domain rail, tag table, changelog
- `5c654d7` Redesign 8/10: History screen — lifetime stats, batch table, re-download
- `530c5cd` Redesign 9/10: dark mode — surfaces, lines, text via CSS variables
- `ec99f91` PWA icon: tartan match for the sidebar logo + manifest palette refresh

This is the v3 design system that's still in production. Two notable replacements:
- **Cormorant Garamond → Outfit** for the wordmark and body. The serif felt out of step with the data-density demands of the Review surface.
- **Princeton orange → Carnegie navy + gold** as primary palette, semantically anchored to the clan tartan.

The v3 redesign also splits the app from a single-page-with-tabs into a **sidebar nav + content column** structure — the desktop chrome that exists today.

### Session reset + crash fixes
- `4337d8d` Session reset: New session / Clear batch buttons in page headers
- `dd9e7c4` Sidebar: New session button moved above Workflow, under brand block

### **Reversal** — separate edit screen
- `638d339` Edit screen: per-book full-page editor at /review/[bookId]
- `aa949fb` Review crash fix: defensive render + shared Cover with placeholder
- `186b8c1` Review crash fix: sanitize at localStorage hydration + visible error boundary
- `60b1af2` Edit: drop separate edit screen, restore inline click-to-edit on Review

A dedicated `/review/[bookId]` edit page was tried and rolled back the same day in favor of inline click-to-edit fields on the Review row. The crash-fix commits in between sanitize localStorage on hydration and add a visible error boundary — both still in place.

---

## Phase 3 — Cross-device, barcode, brand panel (2026-05-02, 78 commits)

Day three is the longest, dominated by phone capture + cross-device sync + barcode scanning. Many of the 78 commits are auto-generated cross-device sync events (Pending batch unlabeled / removed) — these are listed in aggregate at the end of the phase.

### PWA icons + vocabulary curation
- `0241548` PWA icons: tartan-pattern PNGs at 192/512, manifest reference
- `4d589dc` Tartan icons: render at native resolution with crisp-edges, no upscaling
- `882d340` Vocabulary: alphabetize the whole page
- `14364a1` / `4bd3ab3` / `7896df8` / `5fe9172` Vocabulary: add/remove "Drugs" tag (vocabulary + changelog updates)

The "Drugs" tag move (from Literature → Social & political) is a representative example of the vocabulary-edit flow's two-commit pattern: one commit updates `lib/tag-vocabulary.json`, a second updates `lib/vocabulary-changelog.md`. The non-atomic write is a known infrastructure concern — see STATUS-V4.0 §10.

### Density + brand panel iteration
- `5e5eb67` Density bump: scale UI for desktop screens
- `f6f4d3d` Sidebar: 260px width + 48px tartan + bigger CARNEGIE wordmark

### **Reversal trio** — brand panel experiments
- `6f94a38` Brand: tartan panel + spine-stack logo, retire the tartan C / accent stripe
- `5426604` Brand panel: switch to a real tartan photo with dark scrim
- `372163b` Brand panel: revert to CSS-generated tartan, drop the dark photo
- `552dcef` Brand panel: square 260×260, content centered slightly above mid-height
- `871fde5` Brand panel: scale up content + radial vignette behind the text

The brand panel was tried in three forms: CSS-generated tartan → real tartan photo → back to CSS-generated. The photo version was visually nice but added asset weight and printed poorly at 1× DPI. The CSS-gradient version (still in place) recreates the clan tartan with two `repeating-linear-gradient` layers + a radial vignette over a navy ground.

### Phone capture + cross-device sync
- `bdc5c3e` Phone capture + cross-device sync via GitHub-backed pending batches
- `fe44da6` Camera modal: right-side shutter, prominent Done pill at top-right
- `e4d95cc` Phone Capture: full-width Process all + sticky bottom CTA
- `e814ef4` Phone Capture: route camera shots straight to commitFile, drop dup CTA
- `1722898` Phone header: add New session icon button on the right
- `9ab743d` Phone camera: route through CropModal, surface queue, lower min width
- `6d51b64` Phone tab bar: add Vocab tab (4 evenly spaced columns)
- `5856022` Vocabulary: phone redesign — pills row, stacked tags, sticky add bar
- `5de5f9f` Upload page: dropzone first, drop info icon
- `9c0fbcc` Vocabulary phone: hide delete action on tag rows
- `75a4581` About page: editorial spec + sidebar nav + phone header link

The phone-capture flow — point camera at shelf, snap, send to GitHub, pick up on desktop — is the workflow that justified the GitHub-as-database architecture from Phase 2. The "pending batches" file-per-batch storage at `data/pending-batches/` dates from `bdc5c3e`.

### v3.0.0 release tag
- `5f257dd` v3.0.0 — bump package.json + CHANGELOG release section

### Barcode scanning
- `8f9845b` Scan pipeline: ISBN -> lookup -> tag-infer -> BookRecord
- `a0e5cd9` BarcodeScanner UI + Capture wiring
- `a283df9` Review surfaces: 'Scanned' badge on barcode-sourced books
- `989ea5a` Barcode scanner: confirm-on-every-scan + ISBN dedup pass
- `e0aec16` BarcodeScanner: 100ms haptic pulse on ISBN lock-on

The "confirm-on-every-scan" rule (commit `989ea5a`) is foundational: the camera detects barcodes constantly, so the scanner pauses on a frozen frame and waits for an explicit "Use this ISBN" tap. Without that gate, a single shutter would create dozens of duplicates.

### LibraryThing import
- `d877944` LibraryThing import parser + preview builder
- `278a78d` LT import: dialog + History page button

User can import an existing LT export so duplicates flag correctly from day one.

### Upload flow polish
- `126985e` Upload: ETA copy under Process-all (~45s/photo baseline)
- `5452258` Upload: batch-label dropdown of past labels from the ledger
- `191d525` Upload: post-processing summary toast (books / unreadable spines)
- `ba63f3a` Upload: notification + chime + vibration on processing finish
- `4217f3a` Review: 'Approve all & export' shortcut + auto-download on /export
- `543813b` TagPicker: 'Frequently used' section ranked by ledger usage
- `5c9671d` Review: clickable column headers (Book / Conf. / Tags) cycle sort
- `4869ff1` Export: small 'Upload this file to LibraryThing' link below download
- `d7fdf1f` Vocabulary: tag search (real-time filter, both viewports)
- `19892b8` Vocabulary: rename tags + propagate to historical ledger entries

The "rename and propagate to history" feature in `19892b8` is unusual — when a vocabulary tag is renamed, the rename also retro-applies to every entry in the export ledger, so a re-download CSV reflects the corrected name.

### Mobile chrome refinement
- `290116c` MobileShell: tab bar 48px+ minimum, icons-only under 360px
- `9a5f2ea` Undo toast for destructive actions (reject / batch delete / clear)
- `2f911a1` Sidebar stats: shimmer skeleton until ledger sync resolves

The Undo toast becomes the standard treatment for destructive actions across the app.

### About page micro-iteration
- `8345c32` About: add Scanning as an alt entry point above Detection
- `aed2364` About: append Barcode scanning as supplementary note after Review
- `59a573e` About: fold barcode-scan note into Detection as a parenthetical

Three commits in a row on the About page reorganize how barcode scanning is described relative to the five-stage pipeline. The final shape: it's a parenthetical inside the Detection step.

### v3.5 — silent-merge fix + Add copy
- `733d969` v3.5: stop silent dedup auto-merge, add manual "Add copy" button

The Review-mount silent ISBN dedup pass was deleted (it was destroying legitimate duplicate-copy ownership). Replaced with an explicit "Add copy" button on the BookCard. Daily changelog `d916aad CHANGELOG-2026-05-02.md` documents this in detail.

### Tag-correction feedback loop
- `24b377d` Tag-correction feedback loop: log edits, inject as few-shots

Replaces the older "approved-tag feedback loop" from Phase 1 (Feature 3). New shape: every tag add or remove on a system-suggested tag is logged to localStorage and pushed to GitHub at `data/corrections-log.json`. The 20 most recent corrections are appended to the tag-inference system prompt as few-shot examples.

### Cleanup commit
- `d70ef82` Cleanup: port BookCard's live features into BookTableRow, archive stale planning docs

After the v3 redesign, `BookCard.tsx` was orphaned but had received recent feature work (the Add copy button + correction-logging hooks). This commit ports both into the live `BookTableRow` (desktop) — `MobileBookCard` already had the correction hooks — and deletes BookCard. 7 stale planning docs at the repo root move to `lib/archive/`.

### Reread fallback
- `2442660` Reread: enable + fall back to matchEdition when ocrImage is missing

Crucial UX fix: after a page reload, the high-res `ocrImage` is gone (stripped from localStorage to stay under quota), so the AI Reread path becomes unavailable. This commit makes Reread silently fall back to `matchEdition` mode (re-look-up using current title/author/year/publisher/ISBN) — the user gets a useful Reread instead of an error.

### Background — cross-device sync churn
The phone-capture flow committed many `Pending batch unlabeled: N book(s)` and `Pending batch removed: <id>` messages directly to the repo as part of normal operation:

- `0cac0e7` `c5f8b82` `a9a946f` `b312a5a` `c78bbbb` `5f4407c` `2497633` `4a12371` `6248676` `b6a979f` `373c3cf` `c041d42` `489511e` `b7299c8` `3c17760` `189236e` `5f20846` `e267bd1` `63defab` `3d6a46f` `16435cd` `75b2291` `598f29a` `6252455` `b803e1e`

These aren't feature work — they're the cross-device sync system functioning correctly: a phone uploads a batch, the desktop pulls it, and as the user works through review the per-batch JSON files get committed and removed. ~25 of the 78 day-three commits are this kind of churn.

---

## Phase 4 — Audit pass + Next 14→16 upgrade (2026-05-03, first half)

Day four opens with infrastructure work — error handling, dependency hygiene, the major framework upgrade.

### Build hygiene + boundary cleanup
- `5aa8878` About: import package.json as default to silence Next 15 warning
- `39b65fe` Extract lookup-utils.ts so scan-pipeline doesn't transitively pull process.env names through book-lookup

The `scan-pipeline.ts` (client-bundled via the BarcodeScanner) was importing helpers from `book-lookup.ts`, which also touches `process.env.ISBNDB_API_KEY` and `process.env.GOOGLE_BOOKS_API_KEY`. Even though Webpack should tree-shake those, the cleaner fix was extracting the env-free helpers into `lib/lookup-utils.ts` so the var-name strings can't accidentally end up in the client bundle.

### Error-handling pass
- `d4c340d` Error-handling pass: structured lookup-book errors, Anthropic retry, 45s per-spine client timeout

Three regressions caught in one commit:
- `/api/lookup-book` was returning HTML 500 pages on lookup-chain throws — wrapped in try/catch so it returns structured 502 JSON instead.
- New `lib/anthropic-retry.ts:withAnthropicRetry` retries 429 / 5xx twice with 1s/3s exponential backoff, respects `Retry-After` (capped at 10s).
- `processQueue` worker pool now races each `buildBookFromCrop` call against a 45-second wall-clock timer. On timeout the spine becomes a stub with a `Pipeline timeout — try rereading` warning and the worker continues to the next spine instead of freezing the whole batch.

### Dependency upgrades
- `1bdb7bd` deps: bump postcss to 8.5.13, pin next to 14.2.35 (latest 14.x)
- `857939f` Upgrade Next.js 14 → 16 (major) and React 18 → 19
- `54e3db7` Fix Next 16 / React 19 regressions: store hydration mismatch, pending-batches 502

Next jumped two majors (14 → 16) and React 18 → 19 in one commit. The follow-up `54e3db7` patches two regressions:
- React 19's strict-mode hydration guard threw on the `StoreProvider` because its `useReducer` lazy-initializer was reading `localStorage` synchronously during render. Refactored to a `HYDRATE` action dispatched from a mount `useEffect` so SSR + first client render produce identical empty state.
- A 502 on `/api/pending-batches` was traced to a 409 SHA-conflict from concurrent writes; added a one-shot 409-retry shim.

### CSV multi-author
- `35ab702` CSV: split multi-author strings into LibraryThing's "Last1, First1; Last2, First2"

`toAuthorLastFirst` was producing mangled output like `"Wineburg, Mike Caulfield & Sam"` for spine reads of `"Mike Caulfield & Sam Wineburg"`. The fix: detect multi-author inputs by splitting on `&`, word-bounded `and`, and `;`; flip each side independently; rejoin with `; `. Single-author flow is unchanged. Existing books in localStorage carry stale `authorLF` so the CSV writer always recomputes from `b.author`.

---

## Phase 5 — Lookup pipeline transformation (2026-05-03, second half)

The biggest single architectural shift in the project's history happened on the same day as the Next upgrade. The lookup pipeline was rebuilt twice, and a 12-commit enrichment series ran in between.

### Diagnostics + closing the ISBNdb gap
- `25b4a7c` Lookup diagnostics: per-tier trace logging, close ISBNdb-direct gap in barcode-scan path
- `d6b680d` Aggressive lookup: title-search variants, cross-tier ISBN fan-out, unconditional ISBNdb, Sonnet last-resort identifier

`25b4a7c` adds the structured per-tier trace logging that made all subsequent diagnostics tractable. It also discovered a real bug: the barcode-scan path's `lookupBookByIsbn` had been calling Open Library and Google Books but **never ISBNdb** — the most authoritative source for a known ISBN. Fixed by routing the barcode-scan flow through `/api/lookup-book` with `matchEdition: true`.

`d6b680d` added the aggressive title-search variants (full title + cleaned author → short title + cleaned author → short title + last name only → short title only → full-text q=) and the Sonnet last-resort identifier (`/api/identify-book`) that fires when every standard tier misses. The cross-tier ISBN fan-out (Phase B in the prior architecture) also dates from here.

### The 12-commit enrichment series
A deliberately staged series under the banner of `carnegie-pipeline-enrichment-stable.md`. Each commit was independently revertible.

- `7b7e0e0` enrichment commit 1: add optional enrichment fields to BookLookupResult and BookRecord
- `12e75bb` enrichment commit 2: sanitize special chars in search queries
- `25af2a0` enrichment commit 3: extract canonical title/author/allAuthors/pageCount/synopsis from Open Library
- `cadc438` enrichment commit 4: extract edition/pages/binding/synopsis/language/allAuthors from ISBNdb + cover-fallback chain seeding
- `0954d77` enrichment commit 5: lookupFullMarcByIsbn + LCSH/DDC/coAuthors/edition/pages from MARC
- `4329e96` enrichment commit 6: expand Wikidata SPARQL — genre, subject, page count, series
- `eaf503b` enrichment commit 7: render new detail-panel rows + thread enrichment fields onto BookRecord
- `12d4c14` enrichment commit 8: feed LCSH / DDC / synopsis into the infer-tags prompt
- `d5615b9` enrichment commit 9: canonical title/author override behind USE_CANONICAL_TITLES flag + multi-author authorLF
- `e6dd722` enrichment commit 10: cover URL fallback chain
- `49f92bf` enrichment commit 11: cross-tier ISBN re-queries when ISBNdb supplies a new ISBN
- `1150b67` enrichment commit 12: prefer canonical multi-author authorLF in CSV export, fall back to recompute

This series triples the data captured per book. Three structural moves stand out:
- **Commit 2 (`sanitizeForSearch`)** strips `*`, `@`, `#`, `$`, `!` from search queries. "Holy Sh*t" no longer breaks Open Library's tokenizer or Wikidata's SPARQL filter.
- **Commit 5 (`lookupFullMarcByIsbn`)** parses the LoC SRU MARC XML for fields beyond LCC: 050 (LCC), 082 (DDC), 100 (main author), 245 (title), 250 (edition), 260/264 (publisher), 300 (page count), 600/610/611/630/650/651 (LCSH headings, capped at 25), 700/710 (co-authors). The old `lookupLccByIsbn` is kept untouched — additive.
- **Commit 9 (`USE_CANONICAL_TITLES` flag)** introduces the database-canonical title override, gated behind a one-line revert flag. Multi-author authorLF builder lands here too.

### **Reversal #1** — ISBNdb to the top of the cascade
- `46c54a9` Reorder cascade: ISBNdb → OL → LoC SRU → GB → Wikidata

Moved ISBNdb from position 3 (gap-filler) to position 1 (primary). Open Library got gated behind ISBNdb's hit. This was a step in the right direction but had its own problem: ISBNdb's title-search ranking is fuzzier than OL's `pickBestDoc` scorer, so when ISBNdb returned a worse edition than OL would have picked, the cascade locked in the worse result.

### **Reversal #2** — Phase 1 / Phase 2 architecture
- `a028295` Restructure lookup pipeline: parallel candidate discovery + ISBN-keyed enrichment + cache

The user explicitly framed this commit as "the last time I want to restructure the lookup pipeline." Two-phase design:

- **Phase 1 — parallel candidate discovery.** ISBNdb and Open Library queried simultaneously. ISBNdb hits adapted into the OpenLibraryDoc shape so the existing `pickBestDoc` scorer runs across the unified pool. The single best-scored candidate wins regardless of source. Net effect: ISBNdb's coverage with OL's ranking intelligence.
- **Phase 2 — targeted ISBN enrichment.** When Phase 1's winner has an ISBN, four direct lookups fire in parallel: `lookupFullMarcByIsbn`, `gbEnrichByIsbn`, `lookupWikidataByIsbn` (new — exact P212 SPARQL), `enrichFromIsbn`. All exact, none fuzzy.
- **Cache.** Module-level `Map` keyed by both ISBN and `title|author`. Survives across requests in a warm Vercel function instance.
- **Title rule.** Levenshtein similarity ≥ 0.6 → use the shorter of spine-read vs canonical. Stops `"The Hobbit, Or, There and Back Again"` from replacing `"The Hobbit"`.

The 5-book end-to-end smoke test on this commit is preserved in the conversation history — Hobbit, Foolproof (no match), Holy Sh*t, The Stranger, American Pastoral. ISBNdb won The Stranger; OL won the other three; one fell to identify-book.

### Vercel deploy fixes + Refresh button visibility
- `972cd10` deps: pin @zxing/library to ^0.22.0 to match @zxing/browser peer dep
- `e47b2fc` Review header refresh button: also sync the export ledger
- `b832f08` Review: always render header (with Refresh from cloud button) — even on empty state

The first commit was a Vercel-deploy fix: `@zxing/browser@0.2.0` declared a peer of `@zxing/library@^0.22.0` but the local `--legacy-peer-deps` install had picked `^0.23.0`. Vercel's strict installer rejected the mismatch.

`b832f08` is a thoughtful UX bug: the Refresh button's source DID render on tablet/desktop, but the Review page was early-returning `<EmptyState />` before any local books existed — short-circuiting the header entirely. Restructured to always render the header, conditionally render the body. The Refresh button is now visible exactly when the user most needs it: before any books have synced.

### Barcode preview
- `9370c47` Barcode scanner: book preview on the frozen-frame confirm card

After a barcode lock-on, the scanner now pauses, fires `/api/preview-isbn` (ISBNdb-first → OL fallback), and shows a 60px cover + title + author + ISBN-in-monospace card with the existing Use-this-ISBN / Rescan buttons. 3-second client-side hard timeout falls back to the ISBN-only display so the flow never stalls.

---

## Phase 6 — v4.0 lands on production (2026-05-03, end of day)

The bookend of v4. Two commits and a merge.

- `a55be78` v4.0: handoff docs + bump
- (merge commit) `Merge next-16-upgrade: v4.0 lookup pipeline + Next 16 / React 19 + barcode preview`

`a55be78` bumped package.json to `4.0.0` and added two handoff docs (`STATUS-V4_0.md`, `CHANGELOG-V4_0.md`) to give the next AI picking up the project a clean entry point. The footer on the About page reads from package.json so it auto-updated to `ver. 4.0`.

The merge to `main` was the moment v4 actually became Carnegie. Until that point, every v4 commit had been sitting on `next-16-upgrade` for the entire day's work — the new Phase 1/Phase 2 lookup, the enrichment series, Next 16 / React 19, the barcode preview, all of it. The user's phone, hitting `carnegielib.vercel.app`, had been running v3.5 the whole time. The branch preview URL (where v4 actually lived) was never opened.

This was discovered by checking the About page footer on the phone: it read `ver. 3.5` instead of the expected `ver. 4.0`. The realization that weeks of perceived stagnation were actually a deployment-target mismatch — the work had been improving the app, just not the URL the user was looking at — reframed a month of frustration in a single moment.

The merge itself was a one-commit `--no-ff` because `main` had drifted ~25 commits from cross-device sync churn (auto-committed `data/pending-batches/*.json` adds/removes and ledger appends from the running app on the phone). Those commits touch only data files, not source, so the divergence was benign — but it blocked a fast-forward. The non-fast-forward merge created a single bubble in the history cleanly marking "v4.0 lands on main" without rewriting any SHAs on `next-16-upgrade` (preserved for reference, since this CHANGELOG cites commits from it).

Vercel auto-deployed `main` to production. `carnegielib.vercel.app` finally caught up to v4. The phone, refreshed, read `ver. 4.0`.

---

## Phase 7 — Audit-driven enhancement series (2026-05-03, post-merge → 2026-05-04)

Seven commits beyond the v4.0 merge, all on `main`. The throughline: a five-strategy plan (later four, after Bowker pricing killed the LibraryThing tier) for sharper LCC and tag inference — gated on a data-extraction audit that found Phase 5 had only fixed half the problem. The audit identified silent drops between API responses and the tag prompt; the leak-plug commit closed those before any new tiers landed; then four enhancement commits shipped sticker extraction, DDC→LCC fallback, author-similarity backfill, and the two-step domain-then-tag inference refactor.

### Cover-fix for scanned books

- `667fc68` Barcode scanner: carry preview cover forward + fix OL placeholder issue

Two compounding bugs caused barcode-scanned books to show no cover on the Review page. First: the preview cover URL from `/api/preview-isbn` was discarded when the user tapped "Use this ISBN" — only the ISBN string passed forward, so the slower rebuild lookup had to rediscover the cover from scratch. Second: the rebuild path's OL cover URL omitted `?default=false`, so OL returned a 1×1 grey placeholder with HTTP 200. The `<Cover>` `onError` handler only fires on real errors, so the fallback chain never engaged — the row was loading and displaying invisible nothing.

Fix: thread the preview result through `BarcodeScanner` → `app/page.tsx` → `processIsbnScan` as a typed `BarcodeScanPreview` seed. Lookup result wins the primary cover slot if present; preview cover goes into `coverUrlFallbacks` (deduped). If the lookup found no cover, the preview cover takes primary. Added `?default=false` to both OL URLs in `lib/scan-pipeline.ts`. Audit confirmed `preview-isbn` and `book-lookup` already had it; archive and doc references were left untouched.

### The data-extraction audit

- `c393352` docs: data extraction audit across all lookup tiers

Before adding new tiers, audit the existing ones. The lesson from Phase 5 — where the enrichment series persisted enrichment fields onto BookRecord but didn't deliver them to the tag prompt — was top of mind. The audit was committed as `docs/extraction-audit.md` (381 lines) and gated the rest of the four-step plan.

What it found:

1. **Persistence ≠ delivery.** The Phase 5 enrichment series put `ddc`, `lcshSubjects`, `synopsis`, `pageCount`, `edition`, `binding`, `language`, `series`, `allAuthors`, `subtitle`, `coverUrlFallbacks` on `BookRecord` and surfaced most in the Review UI — but never wired them into `/api/infer-tags`'s user-message builder. So `series` would be persisted (visible in Review) but the prompt-side rule for "Penguin Classics → form tag" was being told nothing about the series field.
2. **MARC 655 (genre/form term) never parsed.** `lookupFullMarcByIsbn` parsed 050/082/100/245/250/260/264/300/600/610/611/630/650/651/700/710 — but not 655, the field that exists specifically for cataloger-applied genre vocabulary (e.g. "Detective and mystery fiction", "Bildungsromans", "Cookbooks"). The biggest single missing signal.
3. **Wikidata title-search merge bug.** The by-ISBN path correctly merged Wikidata's `genre` (P136) and `subject` (P921) into `result.subjects`. The title-search path silently dropped them. Exactly when the title path fires (no ISBN, no LCC) is when those signals matter most.
4. **OL work-record `subjects` silently dropped.** `OpenLibraryWorkFull` typed it but no code assigned it. The search-level `subject` was the only OL signal making it through.
5. **Google Books inline interfaces too narrow.** Both GB tiers (search + by-ISBN) declared TypeScript interfaces that omitted `description`, `pageCount`, `subtitle`, `language`, `mainCategory`, `authors` — fields present in the response but invisible to the code.
6. **MARC 300 page-count regex required a trailing period.** Caught `"384 p."` but missed `"vii, 384 pages"` — a common LoC formatting variant.
7. **External-ID passthroughs unused.** OL `/search.json` exposes `id_librarything`, `id_amazon`, `id_goodreads`, `oclc`, `lccn` when requested — none were. Wikidata exposes P1085, P5331, P2969 — none were.

The audit also outlined two non-blocking recommendations: that the eventual two-step inference commit MUST also fix the prompt-side delivery gap (otherwise the architectural split runs on the same partial data) and that the Wikidata title-search merge bug was a 5-line fix worth folding into the leak-plug pass.

### Plugging the leaks

- `8885f27` lookup: plug data leaks identified in extraction audit

Five fixes in one commit, all closing audit-identified gaps. Same pattern as Phase 5's lesson: audit what's actually flowing through, don't assume the spec was implemented.

1. Wikidata title-search now merges `genre` and `subject` into `result.subjects` — mirrors the by-ISBN path.
2. OL work-record `subjects` now merge into `result.subjects` (deduped, capped 10).
3. MARC 655 parsing in `lookupFullMarcByIsbn`. New `MarcResult.marcGenres` field. Threaded through `BookLookupResult.marcGenres` → `BookRecord.marcGenres` → `infer-tags` prompt as the new `marcGenreTerms` argument. System-prompt rule 10a names it the SINGLE most authoritative signal for genre/form classification (LCC = domain; MARC 655 = form within domain).
4. Google Books interfaces widened in both tiers. `description` → `synopsis` gap-fill; `pageCount`, `subtitle`, `language` gap-fill the BookRecord fields that already existed; `mainCategory` (BISAC-ish top-level category) prepended to `result.subjects`; `authors` (gbEnrichByIsbn) deduped into `allAuthors`.
5. MARC 300 regex tightened — matches `"384 p."` and `"vii, 384 pages"` both, case-insensitive.

### The four-step post-audit plan

The original brainstorm in `lcc-and-tag-strategies.md` (project root) was a five-step plan: Pass B sticker extraction, DDC→LCC fallback, author-similarity backfill, **LibraryThing API tier**, two-step inference. Step 4 — LibraryThing — was investigated and dropped after their developer hub turned out to explicitly redirect bibliographic-data developers to Bowker (paid commercial). The old `librarything.ck.getwork` REST endpoint still partially responds but is unsupported and ISBN-10-only (anything starting with 979 fails). Bowker pricing is enterprise-tier and not cost-effective for a personal cataloging tool. Decision: drop, don't defer. Carnegie's compensating signals — MARC 655 from the leak-plug, author-similarity backfill, the sharper two-step inference — cover most of the gap LT would have filled.

The remaining four steps shipped in order:

- `44aeb8b` Pass B: extract call number stickers, edition, and series from spines. New `SpineRead` fields: `extractedCallNumber`, `extractedCallNumberSystem` (`'lcc'`/`'ddc'`/`'unknown'`), `extractedEdition`, `extractedSeries`. A sticker-extracted call number takes `'spine'` provenance — same priority as a printed-on-spine LCC, outranking every network tier. Sticker DDC gap-fills `lookup.ddc`; edition gap-fills `lookup.edition`; series feeds form-tag inference at HIGH confidence (system-prompt rule 7a). ISBN extraction was deliberately NOT added — ISBN-13s live on back-cover barcode blocks, not on spines. Earlier handoffs flagged this as a gap; this commit re-categorized it as a wrong premise.

- `bce6e62` lookup: DDC→LCC class-letter fallback for ISBN-only DDC sources. New `lib/ddc-to-lcc.json` (full DDC second-summary mapping, 100 entries). New `deriveLccFromDdc(ddc)` in `lib/lookup-utils.ts`. Fires only when network LCC is empty AND DDC is present. Writes the derived class letter to `result.lccDerivedFromDdc` — NOT `result.lcc`. System-prompt rule 11a explicitly classifies it as a domain anchor for rule-1 detection but NOT as authoritative for subgenre tagging.

- `86d7a38` lookup: author-similarity backfill from local export ledger. New `getAuthorPattern(authorLF)` in `lib/export-ledger.ts`. Reads the local ledger (no GitHub round-trip), returns `{ dominantLccLetter, frequentTags, sampleSize }`. Author normalization handles initials, middle-name variants, multi-word lastnames, multi-author independent matching. Minimum sample size 3 enforced at call sites — below that, two books prove nothing. New `BookRecord.lccDerivedFromAuthorPattern` field; new `LedgerEntry.lcc` so future exports vote on the dominant class letter. Threaded into all four orchestrators (`buildBookFromCrop`, `addManualBook`, `rereadBook`, `retagBook`). System-prompt rule 11b is sample-size-aware: ≥5 = strong pattern, 3–4 = tiebreaker. The personalization-from-your-own-data play.

- `bab5d6e` tag inference: two-step domain detection then focused tagging. The biggest architectural change of the four. `/api/infer-tags` refactored from one Sonnet call into a two-call orchestrator. Call 1 (`lib/system-prompt-domain.md`) detects primary domain(s) from the 12 in `lib/tag-domains.ts`; up to 3 domains; per-domain confidence; primary-domain LOW confidence flags `BookRecord.domainConfidence = 'low'`. Call 2 (`lib/system-prompt-tags.md` template, `{{domainName}}`/`{{domainVocabulary}}`/`{{formVocabulary}}` placeholders) runs focused per-domain tag inference IN PARALLEL — the architectural split lets each call see only its domain's vocabulary. The same commit also lands the user-message-builder fix the audit flagged (`subtitle`, `allAuthors`, `edition`, `series`, `binding`, `language`, `pageCount` now reach the prompt). Corrections-log split: new `kind: 'tag' | 'domain'` and optional `domain` context — call 1 gets `kind === 'domain'` few-shot, call 2 gets `kind === 'tag'` filtered to the current call's domain. Review row surfaces a `?domain` chip when domainConfidence is low. New BookRecord fields: `inferredDomains`, `domainConfidence`.

### What four steps moved

Sticker extraction caught the ex-library wins — books with library-sticker call numbers now get authoritative LCC/DDC straight off the physical artifact, no network round-trip needed. DDC→LCC fallback rescues books where ISBN sources only have DDC (ISBNdb's Dewey-only books were the immediate target; the crosswalk fires anywhere the network DDC tier hit but the LCC tiers missed). Author-similarity is the personalization-from-your-own-data play — once a user has exported ≥3 books by an author, the eighth book by that author benefits from the user's editorial pattern, not just generic catalog signal. Two-step inference is the architectural improvement that lets focused per-domain tagging operate on the FULL available signal — and the user-message-builder fix in the same commit ensures that "full signal" actually means the audit-flagged 7 missing fields plus everything that was already wired.

The audit was load-bearing. Each of the four enhancement commits would have been less effective — or in the two-step refactor's case, half-wasted — if they'd shipped before the leak-plug. The four-step plan is the work, but the audit is the gate.

---

## Notable patterns across the arc

### Reversals that stuck
- **Sonnet-everywhere Pass B → per-spine model selector.** Reverted within hours of attempting; replaced with a heuristic that's still in place 6 weeks of git-history later.
- **Skinsbury → Carnegie.** A few hours after the first brand shipped.
- **Cormorant → Outfit.** Day-two redesign. Cormorant felt mismatched against the data-density of the Review surface.
- **Real tartan photo → CSS tartan.** Day-three brand iteration. The CSS gradients render crisper at 1×.
- **Separate edit screen → inline edit.** Tried for one commit and rolled back the same day.
- **ISBNdb-as-third-tier → ISBNdb-first → Phase-1 unified scoring.** Three architectural visions for the lookup, each abandoning the prior. The current Phase 1 / Phase 2 design with parallel candidate discovery is meant to be terminal.
- **`/api/lookup-book` HTML 500 → structured JSON 502.** A small but high-leverage fix.
- **Five-step plan → four-step plan after LibraryThing investigation.** Phase 7's brainstorm doc proposed an LT API tier as one of five strategies for sharper LCC + tags. The investigation revealed LT's developer hub has explicitly walked away from offering bibliographic data — it now redirects developers to Bowker (paid commercial). The old `librarything.ck.getwork` endpoint still partially responds but is unsupported and ISBN-10-only. Bowker pricing was investigated and ruled out as not cost-effective for a personal tool. Decision was to drop entirely, not defer — the compensating signals from MARC 655, author-similarity, and two-step inference cover most of the gap.
- **"Spine-printed ISBN extraction" as a high-priority gap → wrong premise.** Carried for weeks across the handoff docs as the "biggest single quality + speed win available." The audit-driven Step 1 correctly re-categorized it: ISBN-13s live on back covers, not spines. The actual spine-side win that DID land is sticker call-number extraction for ex-library books.

### What survived without question
- **The two-pass spine pipeline** (Pass A detection → per-spine Pass B OCR) is from commit two and unchanged in shape.
- **The hard rule that nothing exports without explicit human approval** is a design constraint, not a feature — it's been in every revision of the spec.
- **The dedup philosophy** — flag don't auto-collapse. Users always decide.
- **The 5-level type scale + 8px grid + 3-zone BookCard** from the day-two polish series.
- **The sidebar nav + content column** layout from the v3 redesign.
- **GitHub Contents API as the cross-device backend.** Once the ledger went there, every subsequent shared resource (corrections, vocabulary, pending batches) followed.
- **The "audit before adding new tiers" principle from Phase 5 was applied again in Phase 7 and caught real bugs both times.** Phase 5's audit caught the silent-drop pattern; Phase 7's audit caught it again (still happening — Phase 5 had only fixed half) plus uncovered MARC 655 entirely missing from the parser. The pattern looks durable: every tier added without an audit pass after-the-fact loses signal somewhere on the way to the prompt.

### Notably absent from the history
- **No Google Vision experiment commits.** The repo has a `GOOGLE_VISION_API_KEY` env var lingering in `.env.local`, but no commit references Google Vision, Tesseract, OpenAI Vision, Azure Vision, or any other OCR-vision experiment. Anthropic Vision via the Claude API has been the only spine-OCR provider since the initial commit.
- **No OCLC Classify integration.** Mentioned in PROJECT-SPEC.md as a planned free LCC tier. Never built.
- **No spine-printed ISBN extraction.** Carried as an open capability gap for weeks of handoff docs. Phase 7's audit correctly re-categorized this as a wrong premise — ISBN-13s live on the back cover, not the spine — and the spine-side win was redirected to library-sticker call-number extraction.
- **No LibraryThing API integration.** Investigated in Phase 7 and decisively dropped after their developer hub redirected to paid Bowker. Compensating signals (MARC 655, author-similarity, two-step inference) cover most of the LT-shaped gap.

---

## Release tags

| Tag | Commit | Date | Marker |
|---|---|---|---|
| v1.0 | `53038c1` | 2026-04-30 | Initial pipeline + 6 features |
| v2.0 | `38fcd60` | 2026-05-01 | Polish series + cropping + cover art |
| v3.0 | `5f257dd` | 2026-05-02 | Sidebar redesign + phone capture + cross-device sync |
| v3.5 | `733d969` | 2026-05-02 | Drop silent dedup + Add copy + corrections feedback loop |
| v4.0 | `a55be78` | 2026-05-03 | Phase 1 / Phase 2 lookup + Next 16 / React 19 + barcode preview. Branch `next-16-upgrade` merged to `main` later same day via `--no-ff` merge commit. package.json bumped to 4.0.0. |
| v4.1 | `bab5d6e` | 2026-05-04 | Audit-driven enhancement series — leak plug, sticker extraction, DDC→LCC fallback, author-similarity backfill, two-step domain-then-tag inference. package.json bumped to 4.1.0. |

The package.json version is `4.1.0`. v4.1 is live in production at carnegielib.vercel.app.
