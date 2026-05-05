# Carnegie — handoff context

This document is for whichever AI picks up this project next. The STATUS and CHANGELOG cover the technical state. This covers everything else.

---

## Who you're working with

The user is a librarian with a D.Litt in Creative Writing. He's technically capable — he uses VS Code, Claude Code, Git, GitHub, Vercel, and the terminal — but he is not a developer. He doesn't write code. He uses AI to build. His workflow is: he describes what he wants to you (the strategist/architect), you write specs and prompts, he hands those to Claude Code (the builder), Claude Code implements.

He has strong opinions about design and UX. He knows when something looks wrong even if he can't articulate exactly why. He'll push back hard when things don't look right, and he's usually right. Don't try to design by committee — build him a visual mockup, let him react, iterate.

He gets frustrated — justifiably — when things break, when work is wasted, or when he discovers problems that should have been caught earlier. He's direct about it. Don't get defensive. Own mistakes, fix them, move on.

He prefers casual conversation over professional-sounding responses. He has a doctorate in creative writing, so language matters to him, but in the opposite direction you'd expect — he wants you to sound human, not corporate.

---

## How this project works

There are two AIs in this workflow:

1. **You (Opus/the conversational AI)** — strategy, architecture, specs, prompts, design mockups, competitive research, copy. You do NOT write production code. Your deliverables are markdown spec files and HTML mockups that get handed to Claude Code.

2. **Claude Code** — the builder. It reads specs, writes code, runs the dev server, pushes to GitHub. It works inside VS Code. The user pastes your specs to Claude Code as prompts.

The critical lesson from this project's history: **never assume Claude Code implemented your spec correctly.** Every major spec that went to Claude Code came back with something missing, broken, or half-implemented. The pipeline was ignoring 70% of API response data. The cascade order was wrong. The tiers weren't feeding each other. These problems were only discovered when the user tested and brought back results.

After every spec you write, include a verification checklist with specific test cases and expected outputs. "Process this ISBN and confirm these exact fields are populated." Not "test it and see."

---

## Lessons learned the hard way

### The Google Vision detour
The previous AI (me) recommended replacing Claude Opus spine OCR with Google Cloud Vision API to save money. The user set up a Google Cloud project, enabled the API, got a key, and Claude Code rebuilt the pipeline. The result was catastrophically worse — Vision extracted raw text, then Sonnet hallucinated book titles from the garbled output ("Macbeth" from a "Cultish" spine). Hours wasted. Reverted to Opus. 

**Lesson:** Don't recommend architectural changes based on theoretical cost savings without testing first. Opus at $0.40/photo was working at 95% accuracy. The cheaper option produced garbage.

### The OCLC Classify dead end
The previous AI spec'd OCLC Classify as a free LCC lookup tier. It was discontinued January 2024. The spec went to Claude Code, was partially built, and had to be scrapped.

**Lesson:** Verify that external services actually exist and are accessible before spec'ing integrations.

### The data extraction gap
The biggest failure of this project: for weeks, the app was calling ISBNdb (paid), Library of Congress, Open Library, Google Books, and Wikidata — and throwing away 70% of the data each API returned. ISBNdb returns synopsis, pages, binding, edition, cover images, all authors — most were ignored. LoC MARC returns LCSH subject headings (the gold standard for tagging) — completely ignored. The BookLookupResult type didn't even have fields for title or author from the database, so the spine-read text was never corrected.

This wasn't discovered until the user demanded an audit after months of incomplete records. A data extraction audit prompt finally revealed the full extent of the waste.

**Lesson:** After building a pipeline, audit what data is actually flowing through it. Don't assume the spec was implemented completely. Ask Claude Code to show you exactly what each API returns and what's being extracted.

### The cascade ordering
The lookup chain initially had Open Library first (free) and ISBNdb third (paid). This meant OL's lower-quality data filled fields first, and ISBNdb's better data was blocked by the "only fill if empty" rule. The user was paying for ISBNdb and barely using it.

The eventual fix: parallel candidate discovery (ISBNdb AND Open Library queried simultaneously), unified scoring across both, then targeted enrichment with the winner's ISBN.

**Lesson:** "Free first, paid as fallback" is a cost optimization that undermines quality. Put the best source first, or query in parallel and pick the best result.

### Design specs don't work without visual targets
Multiple design specs were written with hex codes, pixel values, and spacing rules. Every implementation looked mediocre. The breakthrough was building actual interactive HTML mockups and iterating visually with the user until he said "that's it" — then handing the mockup file to Claude Code as the visual target.

**Lesson:** Don't write CSS specs. Build mockups. The user has taste; let him react to visuals, not descriptions.

### The ISBN-on-spine mistake
Both the previous AI and Claude Code suggested reading ISBN barcodes from spine photos as a pipeline improvement. ISBNs are printed on the BACK COVER, not the spine. When books are on a shelf, the back cover faces the wall. This revealed a fundamental gap in understanding what a book on a shelf actually looks like.

**Lesson:** The user is a librarian. Trust his domain knowledge over your assumptions about physical objects.

---

## Architecture decisions and why

**No database.** State lives in localStorage + GitHub repo sync. This was a deliberate choice for a personal tool — no server costs, no database management, cross-device sync through a mechanism the user already understands (git). The tradeoff is that localStorage is device-specific and can be cleared accidentally.

**GitHub as backend.** The export ledger, corrections log, pending batches, and vocabulary all sync to the GitHub repo via the Contents API. This works because it's a single-user app. The sha-based optimistic concurrency handles rare conflicts adequately.

**Opus for OCR, Sonnet for everything else.** This split was discovered through trial and error. Sonnet hallucinates on hard spines (narrow, vertical, stylized fonts). Opus is 5x the cost but doesn't hallucinate. The per-spine model selector (Sonnet for easy spines, Opus for hard ones) was built to cut costs while preserving accuracy.

**Two-pass spine detection.** Pass A (Sonnet, full image) detects bounding boxes. Pass B (Opus, cropped per-spine) reads text. This split happened because single-pass detection+OCR produced too many errors — the model was doing three jobs at once (detection, OCR, structured output) and failing at all of them.

**Parallel candidate discovery.** ISBNdb and Open Library are queried simultaneously in Phase 1. A scoring algorithm picks the best match across both result sets. Phase 2 does targeted ISBN-direct enrichment from LoC MARC, Google Books, and Wikidata. This architecture was the third attempt — serial cascade and ISBNdb-first cascade both had worse results.

**The hard review rule.** Nothing exports without explicit human approval. This is a design constraint, not a feature. It exists because AI spine reading is imperfect and the user's LibraryThing catalog is his permanent record. Bad data in LT is worse than slow data entry.

---

## The feature brainstorm list

These have been discussed but not built:

1. Demo video (screen record + AI edit, script, voiceover)
2. Direct LibraryThing API push — BLOCKED, LT API has been disabled
3. Collection analytics/dashboard (breakdown by domain, tag frequency, author depth, timeline)
4. Multiple export formats (Goodreads CSV, generic CSV, JSON)
5. Condition/inscription photo logging (deprioritized — use Notes field instead)
6. Shelf location search ("where is my copy of X?")
7. Lending tracker — BUILT (v3.5)
8. LT catalog import — BUILT
9. Self-learning tag corrections feedback loop — BUILT
10. Vinyl record cataloging via Discogs integration — discussed for user's brother's collection
11. Bring-your-own-API-key mode for public release

---

## What's working well

- The two-pass vision pipeline (when photos are good quality)
- The barcode scanner with ISBN preview
- Cross-device sync via GitHub
- The tag inference system with correction feedback
- The sidebar navigation and overall UI structure
- Dark mode
- The PWA on tablet and phone
- The export-to-LibraryThing flow

## What's still fragile

- The lookup pipeline cascade — it's been restructured multiple times and may still have issues with tier interaction and cross-referencing
- Canonical title override (`USE_CANONICAL_TITLES` flag) — this can produce ugly long titles; the "shorter of the two" rule helps but isn't perfect
- Phone layout — features frequently break on mobile when desktop changes are made
- Spine reading accuracy drops significantly with poor lighting, plastic cover glare, narrow spines, or stylized fonts
- The app crashes occasionally on the Review screen due to React 19 hydration mismatches that haven't been fully resolved

---

## The user's priorities right now

He wants the pipeline to work reliably. That's it. Every feature request, every design polish, every new integration has been in service of one goal: photograph a shelf, get accurate records, export clean data to LibraryThing. When the pipeline works well, he's happy. When it doesn't, nothing else matters.

Don't get distracted by new features until the core pipeline is solid. He's told you this directly, multiple times, in increasingly colorful language.
