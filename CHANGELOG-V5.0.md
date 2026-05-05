# Carnegie — retrospective changelog (v5.0)

**Window:** 2026-05-04 (post-`bab5d6e`, the v4.1 cap) → 2026-05-05 (`24ddef3`, v5.0.0)
**Total commits in window:** 36 source/data commits + ~120 auto-generated cross-device sync commits
**Generated from:** `git log --pretty=format:'%h %ad %s' --date=short --reverse bab5d6e..HEAD`

This is the development arc that turned v4.1 into v5.0. Two days of work, organized into chronological phases and grouped by feature area within each phase. Where the path took a detour or a previously-shipped approach was reversed, those moments are called out explicitly. Auto-generated cross-device sync commits (`Pending batch unlabeled/removed: …`, `Ledger:`, `Corrections:`, `Vocabulary: promote …`) are present in the history as background noise but are aggregated rather than listed individually here.

---

## Phase 1 — Manual entry, sync hardening, taxonomy refactor (2026-05-04, first half)

The first half of the v5 window was a cluster of medium-sized improvements layered on the v4.1 base, plus the biggest single behavioral change in the project's history: the 21-domain LCC-aligned taxonomy refactor.

### Manual entry + per-edit sync

- `bd8daec` Manual entry modal — 2x2 upload grid (desktop + mobile), shared component for upload + Review surfaces
- `2eb80dd` sync: push manually-entered and individually-scanned books to GitHub on success
- `999e0df` sync: debounced post-mutation push for all BookRecord edits

The 2×2 grid replaced the older inline manual-entry-form-on-upload-page pattern and became a shared modal that surfaces the same control on both Upload (capture path) and Review ("Add missing book" path). The two follow-up sync commits closed a real gap: a manually-entered book wouldn't propagate cross-device until the user explicitly exported, because the existing pending-batches sync only fired on photo-pipeline completion. Manual books got their own push-on-success; subsequent edits became debounced.

The debounced post-mutation push (`999e0df`) was the move that made cross-device editing actually feel live — change a tag on the desktop, the phone picks it up on next pull. This will become important context later in this phase when pending-batches sync gets removed entirely (Phase 3) and the export-ledger + corrections + vocabulary syncs become the only cross-device channels.

### **The taxonomy refactor** — 12 → 21 domains, LCC-aligned

- `4fd58be` domains: refactor to strict 21-class LCC-aligned open-world taxonomy
- `18e46f0` domains: re-route 6 tags to better LCC alignment (Counterculture, Music biography, Sports, Travel, Comedy & humor, Social criticism)

The single most consequential commit in v5. The v4 taxonomy had 12 domains (`philosophy`, `religion`, `psychology`, `literature`, `language`, `history`, `media_tech`, `social_political`, `science`, `biography`, `arts_culture`, `books_libraries`) — which were a working compromise but didn't map cleanly to LCC class letters. Several inference failures traced to this misalignment: a music biography wanted to land in both `arts_culture` (because it's an arts book) AND `biography` (because it's a biography), and the model would oscillate. Sports books lived nowhere natural. Travel writing was scattered across `history` and `arts_culture` depending on subject.

The refactor flattened these into 21 domains, one per LCC class letter:

| LCC | Domain |
|---|---|
| A | general_works |
| B | philosophy_psychology_religion |
| C | auxiliary_history |
| D | world_history |
| E | american_history |
| F | local_american_history |
| G | geography_recreation |
| H | social_sciences |
| J | political_science |
| K | law |
| L | education |
| M | music |
| N | fine_arts |
| P | language_literature |
| Q | science |
| R | medicine |
| S | agriculture |
| T | technology |
| U | military_science |
| V | naval_science |
| Z | books_libraries |

Three structural decisions came with this:

1. **No biography promotion.** Biographies live in their subject's domain — a music biography lands in `music` (M), a presidential biography in `american_history` (E), etc. The vocabulary doesn't have a separate `biography` domain to fragment the signal.
2. **No E + F combine.** American history splits into `american_history` (general E-class) and `local_american_history` (F-class state-and-local). LCC keeps them separate; the vocabulary follows.
3. **Open-world principle.** Every domain stays visible everywhere it's enumerated, even when empty. New domains added in this refactor (Law, Medicine, Education, Agriculture, Technology, Military science, Naval science) start with hand-written starter vocabularies for Law / Medicine / Education only; the rest start empty and grow organically. Empty domains render at reduced opacity.

The follow-up commit (`18e46f0`) re-routed six previously-misclassified tags: Counterculture → social_sciences, Music biography → music, Sports → geography_recreation, Travel → geography_recreation, Comedy & humor → language_literature, Social criticism → social_sciences. These were tags that had specific classification homes the old 12-domain taxonomy couldn't express.

System prompts (`lib/system-prompt-domain.md`, `lib/system-prompt-tags.md`) updated to reflect the new domain list. The Tailwind config gained 21 domain-color classes (one `bg` + `fg` pair per domain), all safelisted for Tailwind purge.

### Lookup pipeline polish

- `390b3e4` lookup: populate title, author, cover at all lookupSpecificEdition branches

A small but useful cleanup. `lookupSpecificEdition`'s three branches (OL-by-ISBN, year-scoped, ISBNdb-direct) had been silently dropping `canonicalTitle`, `canonicalAuthor`, `coverUrl`, and `coverUrlFallbacks` when constructing the `BookLookupResult` — the audit found this in the data-extraction series for v4 but the fix didn't ship there. The Reread path picks up these fields now.

(This commit is also indirectly the prerequisite for the bigger Reread fix in Phase 5 — the BookLookupResult shape needed to be complete before the Phase 2 fan-out could merge into it.)

---

## Phase 2 — Stacks experiment, atomic vocab, design pass (2026-05-04, second half)

The middle-day work introduced a new library-management surface called "Stacks", iterated on it twice, and reverted it. Alongside ran the atomic vocabulary commit refactor and a typography pass.

### Stacks landing page

- `6494b43` stacks: new library landing page with search, collection overview, and tool entry points
- `123ff04` stacks: implement duplicates & editions tool
- `dee738a` stacks: drop series tracking, implement authority check tool

Stacks was an attempt to build a library-management hub: search across the cataloged collection, see collection-level stats, jump into power-user tools. Two tools landed inside it:

- **Duplicates & editions** — surfaces possible-duplicate clusters from the export ledger with confirm-same-work / mark-as-different-works actions. Writes `dedupe_dismissed` and `work_group_id` to the ledger.
- **Authority check** — surfaces author-name variants (e.g. "C. S. Lewis" / "C.S. Lewis" / "Clive Staples Lewis") and lets the user pick a canonical form that propagates across the ledger.

A series-tracking tool was started and dropped — series data was too sparse and inconsistent across LoC / ISBNdb / Wikidata to support a useful UI.

### Vocabulary atomic Git Trees commit

- `a6f4d65` vocabulary-changelog: backfill 2026-05-04 entry missed by transient GitHub 500
- `28a80f3` vocab commit: refactor to atomic Git Trees API write

The transient 500 (`a6f4d65`) was the immediate provocation. The old `/api/commit-vocabulary` route did two sequential PUTs against the GitHub Contents API: one for `lib/tag-vocabulary.json`, then one for `lib/vocabulary-changelog.md`. If the second PUT failed (server-side flake, network jitter, rate-limit hit), the vocabulary was updated in production but the changelog stayed stale. This had been a known concern carried through v4's STATUS doc.

The atomic refactor (`28a80f3`) rebuilt the route to use the lower-level Git Trees API: build blobs, build a tree referencing both files, create a commit on top of the parent ref, fast-forward the branch ref onto the new commit. Blobs and trees are dangling-but-unreferenced until the final ref PATCH lands, so any pre-PATCH failure is a no-op on the visible repo state. Single retry on 422 fast-forward conflict (concurrent writer between ref-read and ref-update). Since both files always land in the same commit now, the drift window is gone.

This refactor also became the **template** for the export-backup route in Phase 5 — same Git Trees flow, same retry semantics, same dangling-blobs-until-PATCH atomicity.

### Design pass

- `b3afb67` design: typography pass — larger and weightier scale across all surfaces
- `18d4e23` design: bump sidebar nav and section headers (14→16, 11→12)
- `97d8e3f` design: layout density pass — Upload and Stacks

Typography scaled up modestly across the app — page titles to 28px, page-desc to 15px, sidebar nav from 14→16px, section headers from 11→12px. The layout-density pass tightened margins on Upload and Stacks. The upshot was a more confident-looking app at desktop scale; the v4-era proportions had been a touch on the slight side for the data-density of the Review surface.

### **Reversal** — Stacks redesign and revert

- `c7b1597` stacks → collection: homepage redesign with bold hero and asymmetric layout
- `7c78ec7` collection: mobile responsive fixes — hero padding, stats layout, utility cluster
- `f0b28f9` collection: revert homepage redesign, keep functional layout from layout-density pass

Stacks was renamed to "Collection" and rebuilt with a bold hero and asymmetric layout. Within hours it was reverted in favor of the more functional layout from the prior density pass. Two iterations of mobile polish ran in between (`7c78ec7`).

The revert acknowledged that the bold-hero direction conflicted with what the page actually needed to do — surface library-level stats and tool entry points without taking over the visual hierarchy on a phone. The v4-era simpler approach won out.

### Local-only mode

- `f615dca` feat: local-only mode toggle for iteration without remote writes

A lifetime-of-session toggle in the sidebar footer (desktop) and gear menu (phone) that suppresses every GitHub write. When ON: ledger pushes, corrections pushes, vocabulary commits, and (later in this arc) export-backup commits all early-return with a `logSkippedWrite` trace. The CSV download still works; the local cache still updates; the visible-state of the app is identical to non-local-only mode. Built for fast iteration without filling commit history with debug data, and for working offline (or on flaky-airport-Wi-Fi).

A 2px gold bar pinned to the top of the viewport indicates the mode is active. Survives across page reloads via localStorage; broadcasts in-tab + cross-tab via a custom event so every consumer (sidebar toggle, mobile gear, top-bar gold bar) stays in sync.

### Stacks / Collection / History demotion

- `14cc706` nav: remove Collection page, demote History to utility surface from Export

The Collection page was removed entirely. History — which had been a top-level nav entry — was demoted to a "Past exports →" link from the Export page. The reasoning: with the Shelflist (coming Phase 4) and LCSH browse (coming Phase 5) about to land, two more library-surface entries was too many. History is a utility for re-downloading old CSVs; it doesn't earn its own nav slot.

The Stacks/Collection arc as a whole was a useful "what's missing in the library-management story" exploration. The right answer turned out not to be "a unified hub" but "two specialized surfaces" — Shelflist for browsing-by-call-number, LCSH for browsing-by-subject. Both ship in Phases 4 and 5.

---

## Phase 3 — Pending-batches removal + auto-default labels + Fiction (2026-05-05 morning)

Day two opens with the cross-device-sync simplification and two smaller polish features.

### Pending-batches removal

- `001fa05` remove pending-batches cross-device sync; keep ledger + corrections + vocabulary sync

The phone-capture-then-desktop-pickup workflow built in v3 (`bdc5c3e` from Phase 3 of the v4 retrospective) gets removed in v5. Three reasons:

1. **Commit churn was severe.** Each phone session committed `Pending batch unlabeled: N book(s)` plus `Pending batch removed: <id>` for every batch processed. A single user-session would produce 30–60 of these commits, drowning out the meaningful changes in the git log.
2. **The use case had shifted.** Once the Phase 1 sync hardening (`2eb80dd`/`999e0df`) made manually-entered and individually-edited books propagate live, the original pending-batches use case (capture on phone, process on desktop later) became a niche path. Single-device-per-session was the dominant pattern.
3. **The export-ledger + corrections + vocabulary sync paths cover what's actually used cross-device.** A book exported on the desktop flags as duplicate when seen again on the phone via the ledger. Corrections trained on either device feed both devices' tag inference. Vocabulary additions are visible on every device. The pending-batches channel was the only one carrying mid-flow (pre-approve) state — and mid-flow state turned out to be tied to a single device's session almost always.

Code removed: `lib/pending-batches.ts`, `app/api/pending-batches/route.ts`, and all the store-action wiring (`pushBatchToRepo`, `syncPendingBatchesFromRepo`, `deletePendingBatchFromRepo`). Orphan JSON files at `data/pending-batches/` were deliberately not cleaned up; the directory and its contents are inert and a future cleanup commit can sweep them.

This is a significant simplification. The architectural surface area for cross-device sync drops from four channels (ledger, corrections, vocabulary, pending-batches) to three.

### Auto-default batch labels

- `8cdfc83` feat: auto-default batch labels + inline label editing on Review and Export

A batch without a user-supplied label gets a sensible default: `Shelf {date}` (photo capture), `Scans {date}` (barcode capture), or `Manual {date}` (manual entry). Labels are inline-editable on Review (`EditableBatchLabel` component shared between rows of the same batch) and Export (one editor per batch row in the export preview).

The motivation: most users don't supply a label at upload time, so books pile up under "Uncategorized" until export — at which point assigning labels is tedious and the user often doesn't remember which capture session was which. Auto-defaults give every batch an identifiable name from creation.

### Fiction tag — auto-derived

- `f1c5feb` form tags: add Fiction tag auto-derived from LCC and LCSH

The `Fiction` form tag was previously asked of Sonnet at call 2 of the two-step inference. Two problems: it was inconsistent across reruns (Sonnet's "is this fiction?" judgement on edge cases like memoirs-as-novels would vary), and it was the form tag with the cleanest deterministic derivation rule available — books in the language/literature LCC range (P-class) with no Drama/Poetry LCSH signal are almost certainly fiction.

The derivation runs post-inference: given `lcc` and `lcshSubjects`, derive `Fiction` deterministically and merge into the form tags. Plays (`Drama` LCSH) and verse (`Poetry` LCSH) are excluded. The call-2 prompt no longer mentions Fiction — one fewer form tag to reason about, deterministic application across reruns.

This is a small but representative move: every form tag that has a deterministic derivation rule is a candidate to lift out of the Sonnet prompt.

---

## Phase 4 — Splash, Shelflist, multi-copy (2026-05-05 midday)

The day's first multi-feature push lands here. Three commits in a row, plus a layout cleanup, plus a splash-page detour.

### Layout slim-down + about fix

- `65621e3` homepage: slim down (app)/ group layout, fix about's package.json import path

The `(app)/` route group's `layout.tsx` was carrying boilerplate from earlier route experiments. This commit slimmed it down and fixed a stale relative import path in `about/page.tsx` that was reaching for the wrong package.json after the route-group restructure.

### **Reversal** — splash page lived for ~30 minutes

- `c974023` homepage: chrome-free splash establishing Jonathan M. Kelly authorship
- `c46c838` homepage: revert splash, restore /upload redirect

A chrome-free splash page replaced the bare-domain redirect to `/upload`. The splash carried Jonathan M. Kelly's authorship statement, a project description, and a repo link, on a navy ground. It was live in production for roughly 30 minutes before being reverted.

The reasoning for ship: Carnegie was about to be shared more visibly (LinkedIn post pending), and the bare domain hitting `/upload` immediately gave no context for a first-time visitor about who built the project or what it was. The reasoning for revert: the splash was a friction point for the actual user — every session opening the app had to navigate through a splash they'd already seen. Cleanest to have the redirect for personal use and figure out the public-facing front page separately.

The original redirect logic is preserved as a commented-out block at the top of `app/page.tsx`. The splash component is also preserved in commented form in case the public-facing version gets revisited.

### Shelflist

- `5e00dfc` feat: shelflist view with two-level LCC accordions

A new `/shelflist` route. Two-level LCC accordion:

- **Top level**: all 21 LCC class letters always visible (open-world principle from Phase 1's taxonomy refactor). Empty classes render at reduced opacity with a `—` placeholder; expanding an empty class reveals an empty-state message.
- **Sub-level**: only sub-classes with books appear. Sub-class is the leading letter run of the LCC string (`PR6063.U7` → `PR`, `P327` → `P`). Sub-classes sorted alphabetically.
- **Third level**: books listed by full LCC ascending, each row links to `/review`.

Data source is the export ledger via `loadLedger()` — in-flight batches not yet exported are NOT shown. SessionStorage-persistent expand state means navigating to /review and back preserves which classes the user had open.

### Multi-copy handling with format awareness

- `430977d` feat: multi-copy handling with format awareness

A real librarian feature. Real libraries (and real personal collections) frequently hold multiple physical copies of one work — Hardcover plus Paperback plus Audiobook is common, and at the rare-book end the same title in three printings is normal. The v4 dedup flow treated these as duplicates and silently auto-merged one until a v3.5 commit (`733d969`) added the "Add copy" button. v5 generalizes that into proper multi-copy support:

- **`work_group_id` field** on `BookRecord`. Records sharing a non-empty `work_group_id` are siblings — same work, different physical copies.
- **`format` field** on `BookRecord`. Tags the copy: Hardcover, Paperback, Mass-market, Audiobook, Ebook, etc.
- **AddCopyModal** (`components/AddCopyModal.tsx`) — the primary path for creating linked copies. Pick a format, get a fresh record with the same title/author/lookup metadata but its own status, ISBN, and editorial state.
- **Review surface treatment**: sibling rows render with an `X of N · {format}` badge (e.g. `1 of 2 · Paperback`) and a 2px gold left-edge connector grouping them visually. Mobile cards get the same.
- **Dedup exemption**: `detectDuplicates` exempts groups where every entry shares the same non-empty `work_group_id`. Different physical copies don't false-positive as duplicates.
- **CSV export**: new BINDING column populated from `book.format` only (not from `book.binding`, which is lookup-derived). Matches LibraryThing's import shape.

This solves a class of real-world reader bug — owning two paperback editions of Hobbit (1965 and 1984 say) and having them collapsed into one row, with no way to distinguish them at export.

---

## Phase 5 — LCSH browse + Phase 2 fan-out fix + determinism (2026-05-05 afternoon)

The peak architectural intensity of v5 lives here. Three commits ship in deliberate sequence: LCSH browse v1, the Phase 2 fan-out fix that unblocks LCSH on a real library, LCSH chips making the entry point usable.

### LCSH browse — commit 1 of 2

- `523b864` LCSH browse: index of subject headings + per-heading book list at /lcsh

A new `/lcsh` route. Two views, one route, query-param-keyed:

- **Index** (no `?h`): every unique LCSH heading drawn from approved books, with a count column. Filter input (case-insensitive substring), sort toggle (A→Z / By book count). Each row links to `/lcsh?h={encodeURIComponent(heading)}`. Empty states for "no approved books yet" and "approved books exist but none have LCSH".
- **Detail** (`?h={encoded}`): heading rendered as the page title, count line, book list sorted by author last name then title. New components — `BookBrowseRow.tsx` (desktop/tablet) and `BookBrowseCard.tsx` (phone) — render read-only book entries with an expand-on-click panel showing synopsis, page count, edition, and the full LCSH list. No edit, no approve/reject, no reread — those belong to Review.

Headings treated as opaque atoms — no subdivision splitting. `"World War, 1939-1945 -- Fiction"` and `"World War, 1939-1945"` are distinct entries. Subdivision splitting was discussed and deferred to a follow-up; the value of the v1 surface is that each heading reflects a real LoC vocabulary string the cataloger chose.

URL query-param rather than path segment because LCSH headings carry punctuation that path segments don't survive cleanly: commas, em-dashes, parens, dates, apostrophes. `encodeURIComponent`/`decodeURIComponent` handle the round-trip.

The route is wrapped in `<Suspense fallback={null}>` because Next 16 requires it for `useSearchParams` at build time. Hydration gate (`hydrated` state) prevents the empty-state flash on first paint while the store reads localStorage.

Sidebar nav gains an LCSH entry between Shelflist and Vocabulary in the Library section. Mobile nav intentionally **not** updated — the bottom tab bar is already at `grid-cols-5` (Upload, Review, Export, Shelflist, Vocab) and a sixth column would compress every existing tab past legibility. LCSH is reachable on phone via direct URL, and shortly after this commit, via clickable LCSH chips in book detail panels.

### **The Phase 2 fan-out fix**

- `d272284` fix: run Phase 2 ISBN-direct fan-out on Reread / matchEdition path

An on-the-fly fix that landed between LCSH commit 1 and LCSH commit 2. The LCSH browse looked broken on a real library: every approved book had an empty `lcshSubjects` array. Diagnostic Reread on a known-good test ISBN (Agnotology, 9780804759014) showed the trace stopping at OL-by-isbn:

```
[lookup edition:Agnotology]   ol-by-isbn       … filled=[isbn,publisher,year,lcc]
[lookup edition:Agnotology] result source=openlibrary tier=ol-by-isbn …
```

No MARC. No Wikidata-by-ISBN. No GB-by-ISBN. The Phase 2 ISBN-direct fan-out — which is the SOLE source of LCSH (via MARC parsing) — wasn't firing on the Reread path.

Root cause: `lookupSpecificEdition` (the Reread / matchEdition path in `lib/book-lookup.ts`) had three early-return branches (OL-by-ISBN, year-scoped, ISBNdb-direct), each of which built a partial `BookLookupResult` and `return`ed immediately on the first match. The Phase 2 parallel fan-out (`Promise.all([lookupFullMarcByIsbn, gbEnrichByIsbn, lookupWikidataByIsbn, enrichFromIsbn])`) lived only in `lookupBook`'s code path. So `lookupBook` (fresh title/author lookups) ran the fan-out correctly, but every book Reread'd (or processed via `matchEdition: true` from the barcode-scan flow) skipped it.

Two compounding facts made this look library-wide rather than path-specific:
- Books cataloged BEFORE MARC was wired in (most of v4) never had `lcshSubjects` because no source had populated them yet.
- Any book Reread'd to refresh metadata silently overwrote with the post-fanout-skip result, even if it had previously had LCSH from a fresh lookup.

The fix extracted Phase 2's fan-out + gap-fill merge from inline-in-`lookupBook` (~135 lines) into a shared helper `enrichWithIsbnFanout(result, log, prevLccSource)`. The helper:
- Reads `result.isbn`, returns no-op when empty.
- Runs the four-way `Promise.all` for MARC + GB + Wikidata + OL-by-ISBN.
- Gap-fills onto the passed-in `result` (only fills empty fields, never overwrites Phase 1 values).
- Returns the updated `lccSource` provenance and the GB cover URL (so the caller can fold it into `buildCoverChain` correctly).

`lookupBook` became a thin caller. `lookupSpecificEdition`'s three branches each now call the helper before `return out`, with a post-fanout `buildCoverChain` rebuild so the GB thumbnail lands in the right fallback position.

Verification: Reread on Agnotology after the fix produced the expected trace — `phase-2 marc no record` (LoC genuinely doesn't have MARC for that ISBN), `wikidata-isbn → 0 bindings` (Wikidata genuinely has no entry), but the GB-by-ISBN merge fired silently and added the second author (Schiebinger) that OL had missed. Other books in the library produced filled `lcshSubjects` arrays. The LCSH browse went from empty to populated.

The architectural lesson: **wherever a code path constructs a `BookLookupResult` from an ISBN-bearing source, that path needs the Phase 2 fan-out**. The fix solidified this as a shared helper that any future entry path will use.

### LCSH browse — commit 2 of 2

- `dc3a8bb` LCSH chips: clickable headings in book detail panels link to /lcsh browse

The entry point users actually want. The LCSH list in book detail panels (`BookTableRow` desktop + `MobileBookCard` phone) was a single semicolon-joined mono-font string up through this commit. Replaced with individual `LcshChipLink` components — outlined mono link-chips, each routing to `/lcsh?h={encoded}` so the user can browse other books carrying the heading they just saw.

`LcshChipLink` styling is deliberately distinct from `TagChip`. TagChip is filled and reserved for the controlled genre/form vocabulary; LCSHs are free-text cataloger metadata and read as outlined external-reference links. Mono font preserved because LCSH punctuation (commas, em-dashes, parens, dates) reads better in mono.

`TagChip` already supported a static (no-`onRemove`) variant from earlier work — used by `BookBrowseRow` and `BookBrowseCard` so the read-only browse surface doesn't show a remove × on chips.

### Pipeline determinism

- `4940187` Pipeline: set temperature 0 on all Anthropic calls for deterministic reads

Six call sites, five routes:

| Route | Purpose |
|---|---|
| `/api/process-photo` | Pass A spine detection |
| `/api/read-spine` | Pass B per-spine OCR |
| `/api/infer-tags` | Per-domain tag inference (call 2) |
| `/api/infer-tags` | Domain detection (call 1) |
| `/api/infer-lcc` | LCC inference fallback |
| `/api/identify-book` | Last-resort book identification |

Each `client.messages.create()` call gained `temperature: 0` after `max_tokens`. None previously set a temperature explicitly. The motivation was diagnostic: when chasing the Phase 2 fan-out bug above, the inference outputs were varying enough across reruns that "did the fix work?" required two or three Rereads to be sure. With temperature 0, same input → same output, every time.

This is also the right setting for production quality. The Carnegie pipeline is doing classification (does this spine read into a title? what tags apply?), not generation. Temperature 0 is the textbook setting for classification.

---

## Phase 6 — Export backups + v5.0.0 release (2026-05-05 evening)

The bookend of v5. One feature commit, one verification commit, one version bump.

### Export backups via atomic commit

- `5bee972` Export backups: write to data/export-backups/ via atomic commit instead of client download

The CSV download flow stayed exactly as is. The companion JSON backup — which captures the full `BookRecord` shape per export run for permanent reconstruction-later capability — moved from "downloads to the user's machine alongside the CSV" to "writes to the repo at `data/export-backups/{filename}.json` via atomic Git Trees commit, bundled with the matching ledger update".

Three motivations:
1. **Cross-device durability.** A JSON backup downloaded to one machine isn't visible on another. The repo is.
2. **Atomic ledger update.** Previously the ledger delta was a fire-and-forget POST to `/api/ledger` that ran in parallel with the CSV download. That meant two writes per export (ledger + JSON, the JSON being a client download), no atomicity. Now there's one atomic commit per export containing both.
3. **Audit trail.** Each export's commit is a permanent record of exactly what shipped, with a descriptive commit message: `"Export backup: {batch label} ({N} books)"`. `git log data/export-backups/` becomes a structured shipment history.

The new `/api/export-backup` route mirrors the `/api/commit-vocabulary` pattern from Phase 2: build blobs, build a tree, create a commit on top of the parent ref, fast-forward the branch ref, single retry on 422 conflict. The route reads the current ledger off the parent tree before merging additions (so concurrent writers don't get stomped), writes the merged ledger back to `lib/export-ledger.json`, and stages each backup file under `data/export-backups/`.

`pushExportCommit` (in `lib/export-ledger.ts`) wraps the route with the same local-only-mode + remote-availability semantics as `pushLedgerDelta`. Local-only mode short-circuits with `available: true`. GITHUB_TOKEN missing → 501 → client falls back to per-file JSON download. Network failure → client falls back to per-file JSON download. Repo write failure → client falls back to per-file JSON download. The user never loses a backup.

The export-page handler (`app/(app)/export/page.tsx:downloadCsv`) was refactored: each pass through `exportOne` now downloads the CSV (sacred, unchanged) and **returns** the JSON envelope to the caller. The caller collects all envelopes from all batches in the export run, then dispatches them to `pushExportCommit` in a single bundled call (or to per-file client downloads in local-only mode).

Spec contained one minor inversion (`splitByBatch` produces N JSON files, but the spec's commit message format was singular). Resolved by listing labels for ≤3 batches, capping at "+N more" beyond.

### End-to-end verification

- `742a552` Export backup: unlabeled (9 books)

Not actually a code commit — this is the verification commit produced by running the new flow end-to-end. The user's running dev server (with the new code path loaded via Turbopack) ran an actual export with 9 books and an unlabeled batch; the new `/api/export-backup` route fired against the live repo; the resulting commit landed on `origin/main` with exactly the spec'd commit message format. This is the "the change works in production" confirmation, captured in the git log.

The fact that this commit landed on `main` BEFORE the code commit (`5bee972`) was pushed reflects the verification flow — the user's local dev server had the code, ran the test, the route committed to `origin/main`, the user reported success, the local code commit was then pushed. `5bee972` rebases cleanly on top of `742a552`.

### v5.0.0 release tag

- `24ddef3` v5.0.0

Single-line bump from `4.1.0` to `5.0.0` in `package.json`. Lockfile regenerates. About-page footer formatter (`5.0.0`.endsWith('.0') → trim → `5.0`) renders "ver. 5.0" on next deploy. No source code touched. Spec said current was `3.5.0` — actual was `4.1.0`; bumped to target regardless.

(Stale comment in `about/page.tsx`: "Trim a 3.5.0 → 3.5 for display". Comment hasn't been updated as version bumped — flagged but left alone since the formatter logic itself is correct for any `X.Y.0`.)

---

## Notable patterns across the v4 → v5 arc

### Reversals that stuck
- **Splash page → /upload redirect.** Lived for ~30 minutes.
- **Stacks landing page → no library hub, two specialized surfaces (Shelflist + LCSH).** A direction worth ruling out by trying.
- **Stacks bold-hero redesign → functional layout from density pass.** Retried in a single commit and reverted.
- **Pending-batches cross-device sync → removed entirely.** Used to be load-bearing; got obsoleted by the live edit-sync from Phase 1.

### Reversals that didn't apply
- **No revert of the 21-domain refactor.** Despite being the biggest behavioral change in v5, the new taxonomy was right on the first try and stuck. The follow-up commit (`18e46f0`) re-routed six tags but didn't revert any of the 21 → smaller domains.

### What the audit pattern from v4 is doing in v5
The v4 retrospective opened a recurring observation: every lookup tier added without an audit pass loses signal somewhere on the way to the prompt. The v5 Phase 5 fan-out fix is the same pattern reapplied — `lookupSpecificEdition` was a "tier" (a code path that constructs a `BookLookupResult`) added without verifying it ran the Phase 2 enrichment that any other tier would. Same root cause, different surface. The fix-by-extraction-into-shared-helper pattern (mirroring how Phase 5 of v4 extracted the leak-plug merges) is the closure.

### Atomic commits as a generalizable pattern
Phase 2's `commit-vocabulary` refactor became the template for Phase 6's `export-backup` route. Both routes use the Git Trees flow: blobs → tree → commit → ref-PATCH with single retry on 422. The next multi-file write that needs to happen atomically (no candidates yet — corrections is a single-file write) will follow the same pattern. The two-PUT pattern from v3-era cross-device sync is officially deprecated.

### What survived without question (continued from v4)
- **Two-pass spine pipeline** — still unchanged in shape. Sonnet for easy spines, Opus for hard, sticker extraction layered on top, all dating from v1.
- **Hard rule: nothing exports without explicit human approval.** Design constraint.
- **Dedup philosophy** — flag don't auto-collapse. v5's multi-copy handling extends rather than contradicts this: the auto-flag for legitimate copies is exempted via `work_group_id`, but the user is still in charge of confirming groups.
- **Sidebar nav + content column** layout from v3.
- **GitHub Contents API + Git Trees API as the cross-device backend.** Now with the commit pattern split: simple deltas → Contents API; multi-file atomic writes → Git Trees API.
- **Audit-before-add discipline.** Phase 5's Reread fix came from a diagnostic Reread that surfaced silent-skip behavior; the fix was the same shape as the Phase 5 leak-plug from v4 — extract shared logic so every code path inherits it.

### Cross-device sync: from four channels to three
v4 closed with four cross-device-sync channels: ledger, corrections, vocabulary, pending-batches. v5 closes with three (ledger, corrections, vocabulary, plus the export-backup atomic commit which is technically a per-export specialization of ledger). The simplification reflects what the user actually relies on cross-device, not what could theoretically be useful.

---

## Release tags

| Tag | Commit | Date | Marker |
|---|---|---|---|
| v4.0 | `a55be78` | 2026-05-03 | Phase 1 / Phase 2 lookup + Next 16 / React 19 + barcode preview |
| v4.1 | `bab5d6e` | 2026-05-04 | Audit-driven enhancement series — leak plug, sticker extraction, DDC→LCC fallback, author-similarity backfill, two-step domain-then-tag inference |
| v5.0 | `24ddef3` | 2026-05-05 | 21-domain LCC-aligned taxonomy + multi-copy handling + Shelflist + LCSH browse + Phase 2 fan-out fix + temperature 0 + atomic export commits + Local-only mode + pending-batches sync removed |

The package.json version is `5.0.0`. v5.0 is live in production at carnegielib.vercel.app.
