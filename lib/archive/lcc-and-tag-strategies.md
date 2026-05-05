# Carnegie — strategies for stronger LCC and tags

Written: 2026-05-03

This is a brainstorm of ways to improve LCC hit rate and tag quality, validated against what's actually available. I started with a wide net (ten-plus ideas), checked each against current API state, and culled to the five that are real, workable, and meaningfully additive to what Carnegie already does.

Carnegie's current state for LCC and tags (from STATUS-V4_0):

- LCC sources: spine read (Pass B), Open Library search.json + works, LoC SRU MARC by ISBN, LoC SRU title+author search, Wikidata SPARQL by ISBN and by title, Sonnet `/api/infer-lcc` model fallback. ISBNdb does NOT contribute LCC (it returns DDC only in the v2 API).
- Tag sources: LCC + LCSH from MARC (capped at 25), OL `subjects`, ISBNdb `subjects`, Wikidata P136/P921, DDC, synopsis, last 20 user corrections as few-shot.

What's already strong: the per-tier diversity, the LCSH feed into the prompt, the corrections feedback loop. What's still missing: any community-tagged signal, any use of the user's own approved books as a personalization vector, and any fallback when an ISBN returns DDC but no LCC.

---

## What I considered and rejected

**OCLC Classify API.** Discontinued January 31, 2024. The replacement is the WorldCat Metadata API, which requires a paid OCLC Cataloging and Metadata subscription. Out of reach for personal use. Already noted as a dead end in the handoff doc but worth restating.

**Goodreads API.** Closed in 2020. Still dead.

**Open Library `/api/books?jscmd=data`.** Returns `lc_classifications`, `subjects`, `genres`. I thought this might be richer than the `/search.json` endpoint already in use. It isn't — same fields, different shape. Marginal. Not worth the integration cost.

**Crossref for books.** Returns DOI metadata for academic works. Coverage for trade fiction is essentially zero, and the academic-book LCC signal it provides duplicates what LoC MARC already gives. Skip.

**HathiTrust Bibliographic API.** Real, free, returns enriched bib records. But the OL Read API is already modeled on it and returns broadly similar data. Adds complexity without unique signal.

**National library catalogs (British Library, DNB, BnF).** They use their own classification systems primarily, not LCC. The few records that include LCC are duplicative with what LoC SRU already returns.

**Z39.50 against LoC.** The SRU endpoint Carnegie uses IS the modern face of Z39.50. Going to raw Z39.50 doesn't surface different data — it just makes the integration uglier.

**Amazon BISAC scraping.** Amazon book pages have rich BISAC breadcrumbs but no clean API. Scraping is brittle and ethically grey. Also addressed by the LibraryThing strategy below (LT exposes BISAC for many works).

---

## Five validated strategies

Ordered by my confidence in the payoff, not by implementation difficulty.

### 1. Add the LibraryThing Web Services API as a Phase 2 enrichment tier

**What it is.** LibraryThing exposes a REST API at `librarything.com/services/rest/1.1/` with a `librarything.ck.getwork` method that takes ISBN, LCCN, or OCLC number and returns work-level metadata. Free developer key. 1000 requests/day rate limit on the free tier. Returns: LCC, DDC, BISAC, member-applied tags (including the canonical "approved" tag form), publication metadata, and work-level cross-references.

**Why it works.** Three reasons:

First, LT data is *qualitatively different* from every other source Carnegie currently uses. LCC and LCSH from MARC are cataloger-applied and authoritative-but-bureaucratic. OL/Wikidata subjects are sparse. LT tags are *crowd-applied by readers* — they capture genre, mood, era, period, theme, and trope information that no cataloger writes. For trade fiction especially, this fills a gap nothing else covers. "Domestic suspense," "unreliable narrator," "epistolary" — these are LT-tag native, not LCSH native.

Second, LT exposes BISAC, which no other tier currently provides. BISAC is the publishing industry's classification system — what publishers actually assign to their own books for retail. It's strong signal for contemporary trade books where LCSH is sometimes thin.

Third, the user is already exporting *to* LibraryThing. Pulling FROM LibraryThing closes the loop — books cataloged in Carnegie inherit the same vocabulary they'll be filed under after export.

**Cost.** Free dev key (`librarything.com/services/keys.php`). 1000 req/day cap is fine — Carnegie processes maybe 50-200 books per session, well under the limit even with retries. New env var: `LIBRARYTHING_API_KEY`.

**Caveats.** API uses XML by default; there's also a JSON workinfo endpoint. Some books have sparse LT records (less popular titles). The XML response has been known to have malformed entities historically — needs a forgiving parser.

**Effort.** Medium. New tier function in `lib/book-lookup.ts` (`fetchLibraryThingByIsbn`), new env var, schema additions to `BookLookupResult` (`ltTags`, `ltBisac`), prompt update to incorporate `ltTags` into the inference few-shot. Probably 200-300 lines of code total.

---

### 2. Backfill from the user's own approved-book ledger when LCC or tags are uncertain

**What it is.** Before falling back to the Sonnet model-guess `/api/infer-lcc`, check the export ledger: does the user already own approved books by this same author? If three or more books by the same author exist with the same LCC class letter (e.g. "B" for Sam Harris), that's a strong personalized signal. Use it as either a hard fallback for missing LCC or as a confidence boost for an uncertain match. Same idea for tags — if all eight Susan Sontag books in the user's library carry "essays" + "criticism," propose those for the ninth.

**Why it works.** A personal library is not random. A librarian's collection clusters around their interests. If the user has eight philosophy books, the ninth is probably philosophy too. This is a free, zero-API signal that no external source can match — it's tuned to one specific person's actual collection.

It also addresses a known fragility: when a book gets a LOW-confidence LCC from the model fallback (which happens a lot for narrow spines and stylized fonts), the user's own data is often a better tiebreaker than another model guess.

**Cost.** Zero new infrastructure. The export ledger already lives in localStorage + GitHub. The lookup is a synchronous filter over an in-memory array. Add a single helper function in `lib/export-ledger.ts` (`getAuthorPattern(authorLF)`) that returns `{ dominantLccLetter, frequentTags, sampleSize }`. Wire that into `pipeline.ts:buildBookFromCrop` as a fallback layer between the network tiers and the Sonnet model-guess.

**Caveats.** Needs a minimum sample size (probably 3 books by the same author) before kicking in — two books prove nothing. Should NOT override an explicit LCC from a network tier; only fills gaps and breaks ties. Author name matching is fuzzy in real ledgers (different transliterations, with/without middle initials) — needs a normalized author key.

**Effort.** Small. Maybe 100 lines, mostly in `lib/export-ledger.ts` and one threading change in `lib/pipeline.ts`. No new APIs. No new env vars.

---

### 3. Two-step tag inference: domain detection, then domain-focused tagging

**What it is.** Replace the single `/api/infer-tags` Sonnet call with two calls. First call: given the book's metadata, what's the *primary domain*? (philosophy, religion, science, literature, etc. — the 12 domains already defined in `lib/tag-domains.ts`.) Second call: given the domain identified in step one, propose tags using a focused prompt that loads ONLY that domain's full vocabulary into context, plus form tags.

**Why it works.** The current single-call prompt has to juggle the entire vocabulary (all 12 domains, dozens of tags each, plus form tags) AND figure out which subset to draw from. That's a lot of cognitive overhead for one call. Splitting it lets the second call focus exclusively on relevant tags, which tends to produce sharper proposals and fewer "scattershot" inferences across irrelevant domains.

This also surfaces ambiguity better. If the first-pass domain detection returns LOW confidence, that's diagnostic — you know to flag the book for human attention before tags ever get inferred. Currently a low-confidence book just gets weak tags silently.

This is on the brainstorm list in STATUS-V4_0 §16 already, so the user has been thinking about it.

**Cost.** Two Sonnet calls per book instead of one — roughly 2× the inference cost per spine. For a 50-book session that's negligible. Latency goes up by roughly the time of one Sonnet call (a few seconds).

**Caveats.** Some books legitimately span domains (a music+neuroscience book hits both literature/arts and science). The first-pass prompt needs to allow multi-domain output, and the second pass needs to do one focused call per domain. That can push it to three or four calls in genuine cross-domain cases. Worth it.

**Effort.** Medium. Refactor `app/api/infer-tags/route.ts` into a two-call orchestrator. Add a new system prompt for domain detection. Adjust the existing `lib/system-prompt.md` to be domain-conditional. Maybe 200 lines.

---

### 4. DDC-to-LCC class-letter fallback

**What it is.** When ISBNdb returns a DDC (`dewey_decimal: "968.05/092/4"`) but no source returned an LCC, derive the LCC *class letter* from a static DDC→LCC mapping table. The mapping isn't 1:1 at the call-number level (no static table can give you "HV4708 .R83 2011" from a Dewey number), but it's perfectly serviceable at the class-letter level — and class-letter is what `lib/tag-domains.ts` already keys off of for domain assignment.

**Why it works.** ISBNdb has DDC for "a few million titles" (per their own docs) but no LCC. Currently when ISBNdb is the only tier with a hit, Carnegie falls all the way through to Wikidata and the Sonnet model-guess to get LCC. With a DDC→LCC mapping, ISBNdb's existing DDC payload becomes a usable LCC class signal — without a single new API call.

The QuestionPoint mapping table (used by professional librarians) provides a public-domain DDC-class to LCC-class crosswalk. The mapping covers all 99 second-level DDC classes and all 21 LCC class letters. It's about 200 rows of static data.

**Why it works specifically for tag inference.** The tag prompt's primary domain anchor is the LCC class letter. Going from "DDC 940.54" (military history WWII) to LCC "D" (history) gives the inference engine the same domain bucket it would have gotten from a real LCC lookup. The detail (D810 vs D811 vs D820) doesn't change which tags get proposed.

**Cost.** Zero — it's a static JSON mapping shipped with the code. No new API, no env var, no rate limit. New file: `lib/ddc-to-lcc.json`. Add `deriveLccFromDdc(ddc: string): string | null` to `lib/lookup-utils.ts` and call it as a lookup-chain fallback in `lib/book-lookup.ts` after the network tiers but before the Sonnet model-guess.

**Caveats.** Class-letter only, not call-number. Carnegie shouldn't write a derived LCC into the `lcc` field as if it were authoritative — better to put it in a new `lccDerivedFromDdc` field with a flag, OR write it to the regular `lcc` field with a confidence marker so the Review surface can distinguish derived from sourced. The mapping is also imperfect at the edges (some DDC ranges genuinely span multiple LCC classes); for those, the table should encode the most common mapping and accept the occasional miss.

**Effort.** Small. The hardest part is sourcing and cleaning the mapping table. Maybe 50 lines of code plus the JSON.

---

### 5. Extend Pass B to extract visible call number stickers and bibliographic markings

**What it is.** The current `/api/read-spine` prompt extracts title, author, publisher, LCC (only when "actually printed/stickered on the spine"), and confidence. Extend it to also look for:

- **Library call number stickers** — affixed to the bottom of the spine on ex-library and used books. They're rectangular, usually printed in monospace, and contain LCC or DDC notation that's directly extractable.
- **ISBN-13 printed at the spine foot** — present on a non-trivial number of trade paperbacks.
- **Edition statements visible on the spine** — "1st ed.," "Penguin Classics," "rev. ed."
- **Series indicators** — "Library of America," "Folio Society" — these are tag signal, not just metadata.

**Why it works.** This is a one-prompt-change capability gain that costs nothing per book (the Pass B call is already being made). For ex-library books — which a librarian's personal library often contains a meaningful percentage of, especially from sales and discards — call number stickers are a *gift*: machine-printed, high-contrast, unambiguous LCC right there on the spine. No lookup needed.

ISBN-13 extraction is the long-deferred "spine ISBN" capability gap from STATUS §10 and the handoff doc. The handoff doc correctly noted that ISBN-13 is generally on the back cover, not the spine — and that's true for new trade books. But it's printed at the spine foot on enough paperbacks (especially academic, mass-market, and reissues) to be worth asking the model to look.

Series indicators are a tag-quality win: "Penguin Classics" is already a form tag in the vocabulary but currently has to be inferred from publisher metadata. Reading it directly from the spine is more reliable.

**Cost.** Effectively zero per-book — same Pass B call, slightly larger output. Marginally more output tokens. The Sonnet/Opus cost difference is probably under 1% per spine.

**Caveats.** Adding fields to the prompt always risks hallucination — the model might "see" a call number sticker that isn't there. Counter that with strict instructions: only extract what's actually visible, return null if uncertain. Also: the data needs a place to live. Add `extractedIsbn?`, `extractedCallNumber?`, `extractedSeries?` to the `SpineRead` type. The lookup pipeline should TRUST a sticker-extracted LCC over a database-derived one (it's the actual physical artifact).

**Effort.** Small. Prompt change in `app/api/read-spine/route.ts`, type additions in `lib/types.ts`, plumbing in `lib/pipeline.ts:buildBookFromCrop` to pass extracted ISBN forward into the lookup as the strongest tier. Maybe 100 lines.

---

## How they stack

Each of these is independently shippable. They don't conflict. If I had to order them by value-per-effort:

1. **Pass B sticker extraction** — smallest change, immediate quality bump for any ex-library book. Ship first.
2. **DDC→LCC fallback** — small change, fills a real gap with no external dependencies. Ship second.
3. **Author-similarity backfill** — small-to-medium change, personalizes the pipeline to the user's actual collection. Ship third.
4. **LibraryThing API tier** — medium change, biggest single source addition, qualitatively new signal. Ship fourth.
5. **Two-step tag inference** — biggest architectural change, biggest quality lift on tags specifically. Save for last so the previous four feed into it.

A meta-recommendation borrowed from the handoff doc's hard-learned lessons: **before building any of these, audit what the existing pipeline is actually extracting from each tier.** The "70% of API data thrown away" problem from the project's history is the kind of thing that recurs whenever new fields get added without verifying the old ones flow through. A 30-minute audit (Claude Code can produce a report showing exactly which response fields each tier reads vs. ignores) saves implementing #4 only to discover that field X from ISBNdb has been silently dropped this whole time.
