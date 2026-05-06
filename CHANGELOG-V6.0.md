# Carnegie v6.0.0 — pipeline correctness audit + observability

**Released:** 2026-05-06
**Predecessor:** v5.0.0 (2026-05-05)

A single-day release covering the pipeline correctness audit captured
in `CARNEGIE-AUDIT-CC-PROMPTS.md`. The work clusters into four
themes: targeted fixes for wrong-edition picks, Phase 1 scoring
discipline, structural cleanup of the four pipeline entry points,
and API observability so the next production debugging session
doesn't start from a generic 502 body.

The release is mostly invisible to end users — same UI, same input
shapes, same display. The wins land in the pipeline trace and the
correctness of Phase 1 winners on under-described queries.

---

## Pipeline correctness fixes

- **Open Library edition endpoint for ISBN-direct lookups.**
  `lookupSpecificEdition` tier 1 now uses
  `/api/books?bibkeys=ISBN:...&jscmd=data` instead of work-level
  `search.json?isbn=...`, which fixes wrong-edition publisher pickup
  (Cymbeline → Folger Shakespeare instead of Signet Classics). The
  edition endpoint returns the publisher of the specific ISBN's
  edition rather than a union-of-editions array; the work-level
  endpoint stays as a fallback when the edition endpoint has no doc.

- **Editor-attributed lookups query by title alone.** When the spine
  attributes a book to an editor (`ed. Michael Schumacher`), the
  lookup pipeline drops the author parameter from API queries
  entirely. Anthologies now find their canonical records — the
  source databases don't index editors as authors, and including the
  editor as `&author=...` was silently zeroing out otherwise-good
  hits.

- **Spine-read extracted fields wired into the pipeline.**
  `extractedCallNumber` feeds LCC/DDC fallback with don't-downgrade
  rule so a partial spine LCC won't displace a complete one from a
  more authoritative source. `extractedSeries` and `extractedEdition`
  feed Phase 1 candidate scoring as additive bonuses (+1 / +2). All
  spine-derived values are stamped with `provenance.source =
  'spine-read'` so the audit trail keeps the origin.

- **Subtitle splitting in `sanitizeForSearch`.** API search queries
  (ISBNdb, Open Library, Google Books) now strip subtitles before
  query construction. The four canonical separators (`: `, ` — `,
  ` -- `, ` – `) trigger a base-title-only query. Earliest separator
  wins when multiple appear. `BookRecord` display preserves the full
  title-plus-subtitle.

## Phase 1 candidate scoring

- **Top-3 candidate trace logging.** Every Phase 1 winner selection
  now emits a multi-line trace block showing the top 3 candidates
  with per-rule score breakdowns:

  ```
  phase-1  top candidates considered:
  phase-1    [1] score=12 source=isbndb title="The Folger ..." — isbn:2 lcc:3 publisher:1 year:1 title:2 author:3 kdp:0 spine:0
  phase-1    [2] score=8 ...
  phase-1    [3] score=6 ...
  phase-1  winner [1] source=isbndb score=12
  ```

  Wrong-candidate diagnoses (`why did THIS book win?`) are now a
  trace read instead of a code read.

- **Minimum-score threshold (`MIN_PHASE1_SCORE = 6`).** Candidates
  scoring below the threshold no longer win Phase 1. The pipeline
  returns no-match (`source: 'none'`) instead of confidently saving
  a low-scoring weak match. Calibrated so genuinely-good matches
  (full author + exact title + at least one of isbn/lcc/publisher)
  always clear; the floor catches pathological under-described
  queries.

- **Relevance signal requirement.** Even when a candidate scores
  above the threshold, it must have either `title > 0` or
  `author > 0` to be considered a winner. Pure-metadata candidates
  (where score comes entirely from isbn/lcc/publisher/year presence
  with no title or author overlap) bail to no-match. Locked in by
  the production failure where `"The Portable"` with empty author
  saved Dorothy Parker as a confident pick.

## Structural refactor

- **Entry-point unification — `assembleBookRecord` shared assembly
  function.** The four pipeline entry points (`buildBookFromCrop`,
  `rereadBook`, `addManualBook`, `retagBook`) now call a shared
  `lib/assemble.ts` function for record assembly. The "Reread
  blind-spot" pattern — where a fix to LCC resolution or provenance
  attribution applied to one entry point but not the others — is
  eliminated. Future fixes apply to all four paths automatically.

## API observability

- **Structured error responses across all `/api` routes.** Error
  response bodies now include `model`, `requestShape`, `timestamp`,
  and `retryAttempts` (when applicable) alongside the existing
  `error` and `details` fields. The next production-trace debugger
  reading a 502 body sees which model was called, what the route was
  trying to do, when it failed, and how many times we tried.

- **`RetryExhaustedError` + retry attempt visibility.** Routes that
  exhaust retries now distinguish "instant 4xx failure" (retry
  attempts omitted from response body) from "tried 3 times over 4
  seconds and gave up" (`retryAttempts: 3`). Implemented via a
  proper Error subclass thrown only on actual exhaustion;
  non-retryable errors rethrow unchanged.

- **Case-insensitive confidence parsing.** Pass B and identify-book
  confidence strings (`HIGH`, `MEDIUM`, `LOW`, plus variants like
  `Very High`, `Med`) are normalized correctly. Unexpected values
  default to `LOW` with a `console.warn` for visibility — the prior
  silent-collapse-to-LOW corrupted any downstream code that uses
  confidence as load-bearing input.

## Infrastructure

- **Branch-first development workflow.** Code changes go to feature
  branches; Vercel preview deploys generate per-branch preview URLs;
  merges to main only after manual verification on preview. The
  workflow caught one regression this release (the temperature: 0
  attempt — see "Reverted" below) before it shipped to production.

- **GitHub Actions CI gate.** Vitest test suite runs on every push
  and pull request. 35 tests covering: lookup pipeline (smoke +
  edition endpoint + scoring threshold + relevance check + subtitle
  splitting), retry behavior, confidence normalization, and shared
  `assembleBookRecord`.

## Reverted / dropped

- **Temperature determinism (originally planned).** An attempt to
  set `temperature: 0` across all Anthropic API calls — combined
  with a Sonnet model ID bump from `claude-sonnet-4-20250514` to
  `claude-sonnet-4-6` — caused 502 regressions on the
  `/api/read-spine` upload path during preview verification. Camera-
  capture path returned 200 successfully; only the upload path
  failed. Reverted; root cause not yet diagnosed (the upload-vs-
  camera differential is a real signal to investigate later).
  Pipeline continues to run with SDK default temperature.

- **Edition reconciliation (originally planned).** Post-hoc
  reconciliation pass with static source priority
  (`marc > loc-sru > wikidata-isbn > isbndb > openlibrary >
  googlebooks`). Superseded by the OL edition endpoint fix, which
  addresses the worst wrong-edition cases directly. Reconciliation
  rarely fires in practice once the right edition is picked at the
  Phase 1 ISBN-direct boundary; shipping invisible defensive
  infrastructure was worse than not shipping it.

## Known limitations

- ISBNdb / OL / MARC coverage gaps mean some books still pick wrong
  editions, particularly when the canonical edition is an audiobook
  record or an obscure reprint.
- Camera-capture spine photos sometimes produce unreadable crops;
  vision model returns LOW confidence with empty title/author.
  Workaround: retry with a clearer photo, or use manual entry.
- `pipeline.ts` is still ~1873 LOC after the entry-point
  unification; further restructuring queued in the audit document
  (Items 10–11) but not in this release.

## Audit progress (`CARNEGIE-AUDIT-CC-PROMPTS.md`)

| Item | Title                                                | Status   |
| ---- | ---------------------------------------------------- | -------- |
| 1    | Phase 1 scoring observability + min-score threshold  | shipped  |
| 2    | Temperature determinism                              | reverted |
| 3    | Subtitle splitting in `sanitizeForSearch`            | shipped  |
| 4    | Edition reconciliation                               | dropped  |
| 5    | Spine-printed ISBN extraction                        | open     |
| 6    | Error context on API responses                       | shipped  |
| 7    | Confidence string collapse fix                       | shipped  |
| 8    | Provenance gaps                                      | open     |
| 9    | Retry attempt count in error responses               | shipped  |
