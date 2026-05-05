# Carnegie

A web application for cataloging a home library from shelf photographs. Carnegie reads book spines, identifies each book against multiple bibliographic sources, infers genre and form tags from a controlled vocabulary, and exports LibraryThing-compatible CSV files. Built by a librarian, for librarians and serious collectors handling physical book collections.

- **Live:** [carnegielib.vercel.app](https://carnegielib.vercel.app)
- **Repo:** [github.com/GonzoDuke/carnegie](https://github.com/GonzoDuke/carnegie)
- **Version:** v5.0.0 ([STATUS-V5.md](STATUS-V5.md))

## How it works

A user photographs a shelf. Carnegie's pipeline runs five stages — every stage between Detection and Export is automated, but **nothing leaves Carnegie without explicit human approval on the Review screen**. The pipeline has a stop there by design.

1. **Detection.** Claude Vision identifies every visible spine in the photograph and returns bounding-box coordinates. Vertical and horizontal spines both detected. Books reachable directly via barcode skip this step entirely.
2. **Reading.** Each detected spine is cropped and sent to Claude (Sonnet for easy spines, Opus for narrow / vertical / hard ones — picked per-spine) for full-resolution OCR. The model returns title, author, publisher, and (when stickered or printed on the spine) an LCC call number.
3. **Lookup.** The extracted text is searched in parallel across Open Library, the Library of Congress (MARC XML), ISBNdb, Google Books, and Wikidata. The single best-scored candidate wins, then four parallel exact-by-ISBN lookups enrich the result with LCSH subject headings, MARC genre/form terms, DDC, page count, edition, and cover art.
4. **Tagging.** A two-call Claude Sonnet orchestrator first identifies the book's primary domain(s) from the 21-domain LCC-aligned vocabulary, then runs focused per-domain tag inference. The Fiction tag is derived deterministically from LCC + LCSH after the model returns. Every Anthropic call runs at `temperature: 0` for reproducible reads.
5. **Review and Export.** Each result lands on a Review surface — sortable table on desktop, card list on phone — for human approve/reject. Approved books export to a LibraryThing-compatible CSV; a permanent JSON backup of every export commits atomically to `data/export-backups/` so the run is reconstructible later.

## Tech stack

- **Framework:** Next.js 16.2.4 (App Router, Turbopack) with TypeScript 5.5 in strict mode.
- **UI:** React 19.2, Tailwind CSS 3.4, custom Carnegie palette anchored on the clan tartan.
- **Hosting:** Vercel. Pushes to `main` deploy production; PRs get preview URLs.
- **Database:** None. State lives in localStorage; cross-device sync (export ledger, corrections log, vocabulary, export backups) goes through the GitHub Contents and Git Trees APIs against this repo.
- **AI:** Anthropic Claude (Sonnet for most calls, Opus for hard spines).
- **External lookup:** Open Library, Library of Congress SRU, ISBNdb, Google Books, Wikidata.
- **Barcode scanning:** native `BarcodeDetector` API where available, with a `@zxing/browser` fallback for older browsers.

## Key features

- **Photo capture and barcode scanning.** Drag-drop on desktop, in-app camera with multi-shot loop on tablet, and a native barcode scanner with ISBN preview confirmation. Manual entry is also supported as a first-class capture path.
- **Two-phase metadata lookup.** Phase 1 fires Open Library and ISBNdb in parallel and runs unified scoring. Phase 2 — when an ISBN is in hand — fires four direct-by-ISBN lookups (LoC MARC, GB, Wikidata, OL) in parallel for enrichment. Results merge with strict gap-fill.
- **21-domain strict-LCC taxonomy.** One domain per LCC class letter (A through Z, skipping I/O/W/X/Y per LCC). Every domain stays visible everywhere it's enumerated, even when empty (open-world principle).
- **Two-call tag inference.** Domain detection then focused per-domain tagging in parallel; the prompt sees only the relevant domain's vocabulary on each call. Both calls run at `temperature: 0`.
- **Multi-copy handling with format awareness.** Hardcover, Paperback, Audiobook, and other physical copies of one work render as separate rows linked by a shared `work_group_id`, with an `X of N · {format}` indicator and a gold left-edge connector. Dedup exempts shared-work groups so legitimate copies don't false-positive. CSV export populates a BINDING column from the format field.
- **Shelflist** at `/shelflist`. Two-level LCC accordion view of the cataloged collection. All 21 LCC class letters always visible, sub-classes only when populated, books listed by full LCC ascending.
- **LCSH browse** at `/lcsh`. Index of every Library of Congress Subject Heading drawn from approved books, filterable and sortable. Click any heading to drill into a per-heading book list. LCSH chips on book detail panels are clickable shortcuts into the same browse.
- **Cross-device sync via GitHub.** Export ledger, corrections log, vocabulary, and export backups all sync through the repo. A duplicate flagged on one device flags on every device. A vocabulary tag added on one device is available on every device. Backups for every export commit atomically to `data/export-backups/` paired with the matching ledger update.
- **Local-only mode.** Sidebar / gear-menu toggle that suppresses every GitHub write for fast iteration without filling commit history with debug data. CSV downloads still work; JSON backups fall back to client download. A 2px gold bar pinned to the top of the viewport indicates the mode is active.
- **Auto-default batch labels.** New batches get `Shelf {date}` / `Scans {date}` / `Manual {date}` defaults depending on origin; labels are inline-editable on Review and Export.
- **Vocabulary curation with feedback loop.** Tag corrections (the user's add/remove on system-suggested tags) inject into the next inference run as few-shot context. Proposed-tag promotions go through an atomic Git Trees commit that updates both the vocabulary file and its changelog in a single commit.

## Local development

```bash
git clone https://github.com/GonzoDuke/carnegie.git
cd carnegie

# Install (Vercel uses plain `npm install`; do the same locally to catch peer-dep issues early)
npm install

# Create .env.local — see Environment variables below
cp .env.local.example .env.local
# … then edit and fill in keys

# Run dev server (Turbopack)
npm run dev
# → http://localhost:3000

# Verify before pushing
npx tsc --noEmit
npm run build
```

Don't use `--legacy-peer-deps` locally. Vercel's installer rejects mismatched peers, and you'll catch the error earlier this way.

## Environment variables

Set in `.env.local` for local dev, in Vercel project settings for production. See [STATUS-V5.md §5](STATUS-V5.md#5-environment-variables) for the full reference.

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required.** | Pipeline non-functional without it. |
| `ISBNDB_API_KEY` | Strongly recommended. | Without it, Phase 1 ISBNdb candidates skip silently. |
| `GOOGLE_BOOKS_API_KEY` | Optional. | Falls back to the unauth'd GB endpoint when absent. |
| `GITHUB_TOKEN` | Required for cross-device sync. | Without it, sync routes return 501 and the client falls back to localStorage-only flow. The export page falls back to client-side JSON downloads for backups. |
| `GITHUB_REPO` | Optional. | Defaults to `GonzoDuke/carnegie`. Override only if forking. |
| `GITHUB_BRANCH` | Optional. | Defaults to `main`. |
| `VERBOSE_LOOKUP` | Optional. | Set to `0` to silence per-tier lookup trace logging. |
| `NEXT_PUBLIC_GOOGLE_BOOKS_API_KEY` | Optional. | Used for client-side GB lookups during barcode scan. |

## Architecture

[STATUS-V5.md](STATUS-V5.md) is the canonical handoff document — read it linearly if you're picking the project up cold. It covers pipeline, API dependencies, frontend, state management, tag system, design system, file structure, dependency versions, build and deploy, and known issues. The [CHANGELOG.md](CHANGELOG.md) summarizes major releases; [CHANGELOG-V5.0.md](CHANGELOG-V5.0.md) is the development retrospective for the v4 → v5 arc.

## Deployment

Pushing to `main` triggers a Vercel production deploy. Pull requests and other branches get preview URLs automatically. There's no `vercel.json` — `next.config.js` is the source of truth.

## License

Carnegie is the personal work of Jonathan M. Kelly. All rights reserved. See [LICENSE](LICENSE) for details.

## Author

Jonathan M. Kelly — librarian, D.Litt. in Creative Writing. GitHub: [@GonzoDuke](https://github.com/GonzoDuke).

Carnegie was built to catalog the author's own collection without typing each book into LibraryThing manually. The hard rule that nothing exports without human approval is, and will remain, the design center.
