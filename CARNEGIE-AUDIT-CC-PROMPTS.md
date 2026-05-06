# Carnegie Audit — Progressive Implementation

This file contains the remaining audit items as ready-to-implement prompts. Work through them ONE AT A TIME in the order they appear.

## How to use this file

1. Read item 1.
2. Implement item 1 on its named branch.
3. Push the branch. CI runs automatically. Vercel produces a preview URL.
4. **Stop.** Report back to the user with: branch name, preview URL, test results, and any notes about scope deviations.
5. Wait for the user to verify on the preview URL and explicitly confirm.
6. Only after the user confirms, merge item 1 to main, then proceed to item 2.
7. Repeat for each subsequent item.

**Do NOT batch items. Do NOT proceed to the next item without explicit user confirmation. Do NOT push anything to main directly — every item goes to its own feature branch.**

If the user says "skip this item," move to the next one. If the user says "stop," stop entirely.

If during implementation an item turns out to be larger than scoped, smaller, or dependent on something not yet shipped, stop and report back to the user before committing partial work.

---

## Project context

- Repo: github.com/GonzoDuke/carnegie
- Production: carnegielib.vercel.app
- Stack: Next.js 16, React 19, deployed on Vercel
- Branch-first workflow: every code change goes to a feature branch first; preview deploy verifies it; user merges to main only after manual verification
- CI: GitHub Actions runs Vitest on every push; tests must pass before merge
- Test files: `lib/__tests__/book-lookup.test.ts`, `lib/__tests__/assemble.test.ts`
- The four pipeline entry points (`buildBookFromCrop`, `rereadBook`, `addManualBook`, `retagBook`) all use shared `assembleBookRecord` from `lib/assemble.ts`. Behavior changes that affect assembly should consider all four paths.

---

## Item 1 — Phase 1 scoring observability + minimum-score threshold

Branch: `phase1-scoring-trace`

```
Add observability to Phase 1 candidate scoring, plus a minimum-score threshold that bails to "no match" when the winning candidate scores below confidence.

Background: when Phase 1 picks a wrong candidate (the Kerouac → Rabelais mis-ID this morning, where score=4 was the winner from 30 weakly-matching candidates), the trace currently shows only the winner. There's no way to see WHY the winner won or what the other candidates were. Adding visibility once makes every future wrong-edition diagnosis a 30-second trace read.

Pairs naturally with a minimum-score threshold: when no candidate scores above the threshold, return null (no winner) rather than confidently saving the highest of a low-scoring pool.

Two changes, one commit:

Change 1 — top-3 candidate trace logging:

In lib/book-lookup.ts, modify pickBestCandidate to return a richer result that includes the top 3 candidates with their score breakdowns. Logger emits a multi-line block:

  phase-1          top candidates considered:
  phase-1            [1] score=8 source=isbndb title="The Folger Shakespeare: Cymbeline" — author:3 title:3 isbn:1 publisher:1 spine:0
  phase-1            [2] score=4 source=openlibrary title="Cymbeline (Signet Classics)" — author:3 title:1 publisher:0 spine:0
  phase-1            [3] score=3 source=openlibrary title="Cymbeline (No Fear Shakespeare)" — author:3 title:0 publisher:0 spine:0
  phase-1          winner [1] source=isbndb score=8

Per-rule breakdown should reflect each rule's actual contribution. If a rule didn't fire (e.g., no spine bonus because extractedSeries was empty), show 0.

Change 2 — minimum-score threshold:

Add a constant near the top of book-lookup.ts:

  const MIN_PHASE1_SCORE = 6;

In pickBestCandidate, when the highest-scoring candidate's total is below MIN_PHASE1_SCORE, return null. The trace logs the bail-out:

  phase-1          highest score=4 below threshold=6 — returning no-match (fallbacks will run)

Apply this threshold to BOTH lookupBook (fresh-lookup) AND lookupSpecificEdition tier 2 (year-scoped scoring). Tier 1 (ISBN-direct) bypasses scoring entirely so the threshold doesn't apply there.

Tests to add (lib/__tests__/book-lookup.test.ts):

Test: "Below-threshold winner returns no match"
- Mock OL to return 5 candidates with low title-match scores
- Mock ISBNdb to return same
- Set up so the highest combined score is 4 (below threshold)
- Call lookupBook("Some Title", "Some Author")
- Assert: result.source === 'none' OR (depending on existing semantics) the result reflects a fall-through to fallbacks rather than a confident pick

Test: "Above-threshold winner returns normally"
- Same shape but candidates score 8+
- Assert: winner is selected as before; behavior unchanged for high-scoring matches

Verification:
- npx tsc --noEmit clean
- npm run build clean
- npm test all green
- Manual on preview: process any book and pull /api/process-photo or /api/lookup-book trace from Vercel logs. Confirm trace shows top-3 candidate breakdown lines.
- Manual on preview: process a low-quality spine photo (or one with deliberately bad title input). Confirm pipeline returns no match instead of a low-scoring confident pick.

Out of scope:
- Don't change the scoring rules themselves
- Don't add observability to gap-fill, reconciliation, or other phases
- Don't make the threshold user-configurable in UI
- Don't bump package.json

Constraints:
- Make all implementation calls
- Both lookupBook and lookupSpecificEdition tier 2 must use the threshold
- Tier 1 (ISBN-direct) is unaffected — it doesn't go through scoring

Commit message: "Pipeline: Phase 1 top-3 candidate trace logging + min-score threshold (returns no-match below 6)"

Push to phase1-scoring-trace branch. Report back with: branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Item 2 — Re-enable temperature determinism with verified model names

Branch: `temperature-determinism-redux`

```
Re-enable temperature: 0 across all Anthropic API calls, with verified current model identifiers.

Background: an earlier commit set temperature: 0 across all Anthropic calls and broke production with 502s on /api/read-spine. Reverted (commit 20e2a60). Root cause never definitively diagnosed; leading hypothesis is the older Sonnet model ID (claude-sonnet-4-20250514) handling temperature: 0 differently than current model versions.

Two changes, one commit:

Change 1 — model identifier updates:

Update Sonnet model ID from claude-sonnet-4-20250514 to claude-sonnet-4-6 (current alias). The locations are:
- app/api/read-spine/route.ts (Sonnet branch)
- app/api/process-photo/route.ts
- app/api/identify-book/route.ts  
- app/api/infer-tags/route.ts (if it uses Sonnet)
- app/api/infer-lcc/route.ts (if it uses Sonnet)
- Any other route file calling client.messages.create with the old ID

Verify Opus identifier is claude-opus-4-7 (already verified correct). Don't change Opus references.

Change 2 — temperature: 0:

Add temperature: 0 to every client.messages.create() call across all routes. Same files as above. Pass it as a parameter alongside model and max_tokens.

Verification (CRITICAL):
- npx tsc --noEmit clean
- npm run build clean  
- npm test all green
- After preview deploy: process a single test book on the preview URL. Confirm /api/read-spine returns 200, NOT 502.
- Reread the same book a second time. Confirm Pass B output is byte-for-byte identical to the first run (this verifies temperature: 0 is actually doing what it should).
- Tag inference: confirm same book gets same tags across two runs.

Out of scope:
- Don't change prompts
- Don't change retry logic
- Don't change which model goes on which route (Sonnet vs Opus selection logic stays)
- Don't bump package.json

Constraints:
- Make all implementation calls
- Every Anthropic call across the codebase gets temperature: 0
- Every Sonnet model ID gets bumped
- If the deploy returns 502 on /api/read-spine after this commit, REVERT IMMEDIATELY and report back with the trace before pushing anything else

Commit message: "Pipeline: temperature: 0 on all Anthropic calls + bump Sonnet to claude-sonnet-4-6"

Push to temperature-determinism-redux branch. Report back with branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Item 3 — Subtitle splitting in `sanitizeForSearch`

Branch: `sanitize-subtitles`

```
Strip subtitles from API search queries to improve fuzzy match ranking.

Background: books with long titles like "Survive! Essential Skills and Tactics to Get You Out of Anywhere—Alive" send the full title-plus-subtitle to lookup APIs. ISBNdb's title-search ranking heavily prefers exact matches, so the long-form query ranks edition-specific records (with the exact subtitle) higher than the original printing's record. Stripping the subtitle for the query fixes this. The full title is preserved in BookRecord.

Implementation in lib/lookup-utils.ts, in sanitizeForSearch:

When the title contains a subtitle separator (`:` or ` — ` (em-dash) or ` -- ` or ` – ` (en-dash)), split on the first occurrence and use only the base title as the query. Preserve the full title-plus-subtitle in the BookRecord (this function is for query construction only, not display).

Add a constant:

  const SUBTITLE_SEPARATORS = [': ', ' — ', ' -- ', ' – '];

Iterate the list, split on first match, take the first chunk. If no separator matches, return the input unchanged.

Apply the same subtitle-stripping to author when author contains a separator (uncommon but happens — e.g., "Bell Hooks: Pseudonym for...").

Tests to add:

Test: "Long title with subtitle searches base title only"
- Input: "Survive! Essential Skills and Tactics to Get You Out of Anywhere—Alive"
- Expected query: "Survive!"

Test: "Title with no subtitle returns unchanged"
- Input: "The Great Gatsby"
- Expected query: "The Great Gatsby"

Test: "Em-dash, en-dash, hyphen-hyphen, colon all work"
- Four input variants, all should split correctly

Verification:
- npx tsc --noEmit clean
- npm run build clean
- npm test all green
- Manual on preview: re-process a book with a long title-plus-subtitle (e.g., the Survive! example). Confirm Phase 1 trace shows the API queries using only the base title.
- Manual: confirm the BookRecord still displays the full title (with subtitle preserved).

Out of scope:
- Don't split on every punctuation mark; use only canonical subtitle separators
- Don't change BookRecord display logic

Constraints:
- Make all implementation calls  
- Display title untouched
- Query title stripped only at sanitizeForSearch boundary

Commit message: "Pipeline: strip subtitles from search queries; preserve in BookRecord display"

Push to sanitize-subtitles branch. Report back with branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Item 4 — Edition reconciliation. Dropped 2026-05-06: superseded by OL edition endpoint fix; reconciliation rarely fires in practice.

---

## Item 5 — Spine-printed ISBN extraction

Branch: `spine-isbn-extraction`

```
Extract ISBN from spine when visibly printed; feed it to the lookup pipeline as a hint.

Background: many trade paperbacks (Random House US, Penguin US, others) print ISBN-13 along the bottom of the spine, just below the publisher imprint. The current spine-read prompt rules ISBNs out entirely on the (mostly correct) basis that ISBNs print on back covers, not spines. The "mostly" is the bug — when ISBN IS on the spine and visible, extracting it lets the pipeline use ISBN as ground truth on first-time captures.

Implementation in app/api/read-spine/route.ts:

Update the SpineRead schema and prompt to add extractedSpineIsbn?: string field. Update the prompt instructions to say:

"If the bottom of the spine shows an ISBN-13 (13 digits, sometimes with a leading 978 or 979, possibly with hyphens, possibly with 'ISBN' prefix), extract it as extractedSpineIsbn. Only extract when ALL 13 digits are clearly visible and you have HIGH confidence in the read. If any digit is ambiguous or partially obscured, return empty string for extractedSpineIsbn."

Wire extractedSpineIsbn through lib/pipeline.ts buildBookFromCrop into lookupBookClient as a hint:
- If extractedSpineIsbn is non-empty AND passes basic validation (13 digits or 13 digits with hyphens), include it in lookupBookClient hints.isbn
- This routes through lookupSpecificEdition's tier 1 (ISBN-direct), which we just verified works correctly with the OL edition endpoint

Add validation helper:

  function isValidIsbn13(s: string): boolean {
    const digits = s.replace(/[^\d]/g, '');
    if (digits.length !== 13) return false;
    if (!digits.startsWith('978') && !digits.startsWith('979')) return false;
    // Optionally: validate ISBN-13 checksum digit
    return true;
  }

When extractedSpineIsbn is invalid (wrong length, wrong prefix), log a trace line and ignore it — fall through to title/author lookup. Don't fail the spine read.

Tests:

Test: "spine ISBN extraction populates lookup hint"
- Mock SpineRead with extractedSpineIsbn="9781982156916" 
- Verify lookupBookClient is called with hints.isbn populated
- Result is the Folger edition (already verified by OL endpoint fix)

Test: "invalid spine ISBN ignored, falls through to title lookup"
- Mock SpineRead with extractedSpineIsbn="123456" (invalid)
- Verify lookupBookClient is called WITHOUT isbn hint
- Result comes from title-search

Verification:
- npx tsc --noEmit clean
- npm run build clean
- npm test all green
- Manual on preview: process a trade paperback with a visible spine ISBN. Confirm trace shows extractedSpineIsbn populated and lookup used it. Confirm BookRecord lands with correct edition data.
- Manual: process a book whose spine has no visible ISBN. Confirm extractedSpineIsbn is empty string and pipeline uses title-search as before.

Out of scope:
- Don't extract partial ISBNs (less than 13 digits visible)
- Don't extract ISBN-10 (rare on modern books and the fallback to title-search is fine)
- Don't change the OL endpoint — that's already done

Constraints:
- Make all implementation calls
- HIGH confidence required to extract
- Invalid extracted ISBNs gracefully ignored, not fatal

Commit message: "Pipeline: extract ISBN from spine when visible; feed to lookup pipeline as hint"

Push to spine-isbn-extraction branch. Report back with branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Item 6 — Error context on API responses

Branch: `error-context`

```
Add structured error context to API route response bodies.

Background: when a route returns 502 or 500, the response body is currently a generic error message. This morning's temperature-commit 502 debugging was harder because the response didn't include model name, request shape, or retry attempt count. Adding context makes future production debugging significantly faster.

Implementation in each route file:

In every /app/api/*/route.ts file's catch block, the error response body should include:
- error: short error type (e.g., "Vision API error", "Lookup failed")
- details: the actual error message
- model: the model name used for this call (when applicable)
- requestShape: brief description of what was being requested (e.g., "spine read with 1 image", "lookup-book title='X' isbn='Y'")
- timestamp: ISO timestamp

Routes to update:
- app/api/process-photo/route.ts
- app/api/read-spine/route.ts
- app/api/identify-book/route.ts
- app/api/lookup-book/route.ts (already has some structure, extend it)
- app/api/infer-tags/route.ts
- app/api/infer-lcc/route.ts
- Any other /app/api/*/route.ts that calls Anthropic or external APIs

The error response shape should be consistent across all routes. Define an error helper:

  function structuredErrorResponse(err: unknown, context: { model?: string; requestShape: string }): NextResponse {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      error: 'Internal error',
      details: message,
      model: context.model,
      requestShape: context.requestShape,
      timestamp: new Date().toISOString(),
    }, { status: 502 });
  }

Tests: minimal — error responses are integration-level, not unit-test targets. Verify by triggering known error conditions on the preview.

Verification:
- npx tsc --noEmit clean
- npm run build clean
- npm test all green
- Manual on preview: trigger a known 502 condition (e.g., empty image base64 to /api/read-spine). Confirm response body now includes model, requestShape, timestamp.
- Manual: trigger /api/lookup-book with invalid input. Confirm response body has structured error.

Out of scope:
- Don't change the routes' happy-path response shapes
- Don't add error tracking infrastructure (Sentry, LogRocket, etc.)
- Don't change retry logic

Constraints:
- Make all implementation calls
- Every route's catch block gets the helper
- Helper is shared across routes (don't reimplement per-route)

Commit message: "API: structured error responses across all /api routes (model, requestShape, timestamp)"

Push to error-context branch. Report back with branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Item 7 — Confidence string collapse fix

Branch: `confidence-collapse-fix`

```
Stop silently collapsing non-canonical confidence strings to LOW.

Background: app/api/read-spine/route.ts currently expects confidence to be exactly "HIGH", "MEDIUM", or "LOW". Anything else (lowercase "high", "Very High", "very high", etc.) silently collapses to LOW. Downstream code uses confidence as a load-bearing signal for whether to retry, whether to flag for review, etc. — silent collapse to LOW corrupts that signal.

Implementation in app/api/read-spine/route.ts:

Locate the confidence parsing code. Replace silent collapse with case-insensitive matching:

  function normalizeConfidence(input: unknown): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (typeof input !== 'string') return 'LOW';
    const normalized = input.trim().toUpperCase();
    if (normalized === 'HIGH' || normalized === 'VERY HIGH') return 'HIGH';
    if (normalized === 'MEDIUM' || normalized === 'MED') return 'MEDIUM';
    if (normalized === 'LOW' || normalized === 'VERY LOW') return 'LOW';
    // Unexpected value — log and default to LOW
    console.warn(`[read-spine] unexpected confidence value: "${input}", defaulting to LOW`);
    return 'LOW';
  }

Apply this same helper anywhere else confidence is parsed (process-photo route, identify-book route, etc.).

Tests:
- Unit test: lowercase "high" returns "HIGH"
- Unit test: "Very High" returns "HIGH"  
- Unit test: random string returns "LOW" with a warning logged
- Unit test: undefined returns "LOW"

Verification:
- npx tsc --noEmit clean
- npm run build clean
- npm test all green
- Manual: not strictly required (this is a defensive fix). If desired, deliberately mock a Sonnet response with lowercase "high" and confirm Pass B captures HIGH.

Out of scope:
- Don't add new confidence levels beyond HIGH/MEDIUM/LOW
- Don't change how confidence is used downstream

Constraints:
- Make all implementation calls
- Helper is shared across routes
- Warnings on collapse, not silent

Commit message: "API: case-insensitive confidence parsing; warn on unexpected values"

Push to confidence-collapse-fix branch. Report back with branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Item 8 — Provenance gaps

Branch: `provenance-completeness`

```
Fill provenance gaps for spine-extracted, derived, and Reread-merged values.

Background: provenance is captured for fields that flow through the lookup pipeline. It's NOT consistently captured for:
- Values pulled from extractedCallNumber / extractedSeries / extractedEdition (consumed but not stamped with source: "spine-read")
- Values preserved through Reread merges (the original-time spine-read attribution gets lost when a fresh lookup overrides)
- Derived values like authorLF (gets source: "derived" but no derivedFrom attribution showing what they were derived from)

Implementation in lib/assemble.ts and lib/pipeline.ts:

Step 1 — extractedCallNumber / extractedSeries / extractedEdition:

In assembleBookRecord, when these fields are consumed (extractedCallNumber feeding LCC fallback, extractedSeries/Edition feeding scoring), the resulting BookRecord field's provenance should include:

  provenance.lcc = { source: 'spine-read', timestamp: ..., extractedFrom: 'extractedCallNumber' }
  provenance.series = { source: 'spine-read', timestamp: ..., extractedFrom: 'extractedSeries' }
  provenance.edition = { source: 'spine-read', timestamp: ..., extractedFrom: 'extractedEdition' }

Add the optional extractedFrom field to the provenance entry type if it doesn't exist.

Step 2 — derived fields:

For derived fields (authorLF, formattedTitle from Title Case, etc.), provenance should record:

  provenance.authorLF = { source: 'derived', derivedFrom: 'author', timestamp: ... }
  provenance.formattedTitle = { source: 'derived', derivedFrom: 'title', timestamp: ... }

Add derivedFrom to provenance entry type.

Step 3 — Reread merge attribution:

When Reread merges a fresh lookup result with priorRecord, fields preserved from priorRecord (because of user-edit provenance) keep their original provenance. Fields refreshed from the lookup get new lookup provenance. This is mostly already correct from Step 3 work — verify and add a test.

Add fields to BookRecordProvenance type:
  - extractedFrom?: string (which spineRead field)
  - derivedFrom?: string (which BookRecord field)

Tests to add (lib/__tests__/assemble.test.ts):

Test: "Spine-extracted LCC has spine-read provenance with extractedFrom"
- Input SpineRead with extractedCallNumber="HV5825 .T67 2005"
- Lookup returns no LCC
- Expected: result.lcc === extractedCallNumber, provenance.lcc.source === 'spine-read', provenance.lcc.extractedFrom === 'extractedCallNumber'

Test: "Derived authorLF has derived provenance with derivedFrom"
- Input with author="John Smith"
- Expected: result.authorLF === "Smith, John", provenance.authorLF.source === 'derived', provenance.authorLF.derivedFrom === 'author'

Test: "Reread preserves user-edit provenance, gets fresh lookup provenance for non-edited fields"
- Mock priorRecord with provenance.title.source === 'user-edit'
- Mock fresh lookup with new title and new publisher
- Expected: result.title from priorRecord (preserved); result.publisher from lookup with provenance.publisher.source === 'openlibrary'

Verification:
- npx tsc --noEmit clean
- npm run build clean
- npm test all green
- Manual on preview: process a book with a spine sticker. Inspect provenance.lcc via console — confirm source is 'spine-read' and extractedFrom is set.

Out of scope:
- Don't add new provenance fields beyond extractedFrom and derivedFrom
- Don't restructure provenance shape

Constraints:
- Make all implementation calls
- BookRecordProvenance type extended additively (existing entries still valid)
- Tests cover all three provenance cases

Commit message: "Provenance: capture extractedFrom for spine fields, derivedFrom for computed fields"

Push to provenance-completeness branch. Report back with branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Item 9 — Retry attempt count in error responses

Branch: `retry-visibility`

```
Surface retry attempt count in error responses.

Background: withAnthropicRetry retries up to N times with backoff. When all retries fail, the route returns an error but the response body doesn't indicate how many attempts happened. That distinction matters for understanding "instant failure" vs "long wait then failure."

Implementation:

Step 1 — instrument withAnthropicRetry to track attempts:

Modify withAnthropicRetry (location varies — check lib/anthropic-retry.ts or similar) to either:
- Return a result tuple with attempts count: { result, attempts } when successful
- Throw an error with attempts attached: throw new RetryExhaustedError({ message, attempts, originalError }) when all retries fail

Approach 2 is cleaner — define RetryExhaustedError class with attempts field and last underlying error.

Step 2 — surface in error responses:

In each route's catch block, when the caught error is RetryExhaustedError, include the attempts count in the structured error response from Item 6:

  return structuredErrorResponse(err, {
    model: ...,
    requestShape: ...,
    retryAttempts: err instanceof RetryExhaustedError ? err.attempts : undefined,
  });

Update structuredErrorResponse helper to accept and emit retryAttempts.

This depends on Item 6 (error-context) having shipped. If Item 6 is NOT yet shipped: STOP. Report back to user that this item is blocked on Item 6.

If Item 6 IS shipped:

Tests:
- Unit test: withAnthropicRetry that fails 3 times then succeeds returns result with attempts: 4
- Unit test: withAnthropicRetry that fails 3 times throws RetryExhaustedError with attempts: 3 (or however the spec defines)
- Integration: route receives a forced-failure scenario, error response includes retryAttempts

Verification:
- npx tsc --noEmit clean
- npm run build clean
- npm test all green
- Manual on preview: trigger a retry-exhausted error. Confirm response body includes retryAttempts.

Out of scope:
- Don't change retry count or backoff strategy
- Don't change which routes use retry

Constraints:
- Make all implementation calls
- RetryExhaustedError is a proper Error subclass
- Backwards compatible — existing callers of withAnthropicRetry don't break

Commit message: "API: surface retry attempt count in error responses (RetryExhaustedError)"

Push to retry-visibility branch. Report back with branch name, preview URL, test results. Wait for user verification before merging.
```

---

## Items 10, 11 — Out of scope for routine implementation

These are large refactors that should not be done as routine audit items. They require dedicated planning sessions:

- pipeline.ts file structure refactor (~1873 LOC into multiple modules)  
- Comprehensive test coverage beyond smoke tests

When the user requests one of these specifically, treat it as a fresh planning conversation, not as part of this todo file.

---

## After all items are complete

Once items 1-9 are shipped, report back to the user:

1. Confirm all 9 items merged to main
2. Production deploy state
3. Test count (was 12 at start; should be roughly 20+ after all items)
4. Any items deferred or scope-deviated

Then wait for further instruction. Do not proactively start new work.
