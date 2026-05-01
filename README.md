# Carnegie

> **Project codename / dev-facing:** `carnegie`
> **User-facing brand:** *The T.L. Skinsbury Library*

## Overview

A Claude Code pipeline that processes spine photos of bookshelves, identifies books, infers genre tags using a controlled vocabulary, and produces LibraryThing-compatible CSV files for import.

## Pipeline architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Spine photo │ ──▶ │  Spine read  │ ──▶ │  API lookup  │ ──▶ │ Tag inference│ ──▶ │ Draft XLSX   │
│  (input/)    │     │  (Claude     │     │  (Open       │     │  (Claude API │     │  (drafts/)   │
│              │     │   Vision)    │     │   Library /  │     │   + system   │     │              │
│              │     │              │     │   Google     │     │   prompt +   │     │  ⛔ STOP     │
│              │     │              │     │   Books)     │     │   vocab)     │     │  Human review│
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                                          │
                                                                                          ▼
                                                                                   ┌──────────────┐
                                                                                   │ Approved CSV │
                                                                                   │ (approved/)  │
                                                                                   │              │
                                                                                   │ Upload to LT │
                                                                                   └──────────────┘
```

## Directory structure

```
skinsbury-library/
├── tag-vocabulary.json      # Tag domains, tags, form tags, inference rules
├── vocabulary-changelog.md  # Auto-generated log of new tags added per batch
├── system-prompt.md         # Claude API system prompt with few-shot examples
├── sample-lt-import.csv     # Reference format for LibraryThing CSV import
├── README.md                # This file
├── input/                   # Drop spine photos here
├── drafts/                  # Draft spreadsheets for review (DO NOT UPLOAD THESE)
└── approved/                # Final LT-ready CSVs (upload these)
```

## Commands

### 1. Process photos → draft spreadsheet

```
claude "Process all photos in input/ — read spines, look up each book, infer tags, and output a draft spreadsheet to drafts/"
```

This command:
- Reads spine text from each photo using Claude Vision
- Looks up each identified book via Open Library API (ISBN, LCC, publisher, year)
- Falls back to Google Books API if Open Library has no match
- Runs tag inference using system-prompt.md and tag-vocabulary.json
- Outputs a draft XLSX to drafts/ with columns:
  - Confidence (HIGH / MEDIUM / LOW)
  - Title
  - Author
  - ISBN
  - Publisher
  - Year
  - LCC
  - Proposed tags (comma-separated)
  - Approved (empty — you fill this in)
  - Notes (any flags or proposed new tags)

### 2. Review

Open the draft XLSX. For each row:
- Check the spine read is correct (especially LOW confidence rows)
- Review proposed tags — add, remove, or rename as needed
- Mark the Approved column: Y to approve, N to skip, E to flag for later
- If a [Proposed] tag appears, either approve it (remove the [Proposed] prefix) or rename it

### 3. Approve and export

```
claude "Approve drafts/[filename].xlsx — export LT CSV to approved/ and update tag vocabulary"
```

This command does three things:
1. **Exports**: Reads only rows marked Y in the Approved column. Formats output as LibraryThing CSV (see sample-lt-import.csv for schema). Tags go in a single comma-separated TAGS column. Saves to approved/ with timestamp in filename.
2. **Updates vocabulary**: Scans approved rows for any tags prefixed with [Proposed]. Strips the prefix and appends the new tag to the matching domain in tag-vocabulary.json. If no domain matches, appends to an "unclassified" section for manual filing later.
3. **Logs changes**: Appends a line to vocabulary-changelog.md recording the new tag, which batch it came from, and the date. This gives you a history of how the vocabulary has grown.

The vocabulary feedback loop is automatic. Every approved batch teaches the engine new tags for future batches.

### 4. Upload to LibraryThing

Go to LibraryThing > More > Import/Export > Import
Upload the CSV from approved/

## Tag vocabulary maintenance

The tag vocabulary in tag-vocabulary.json is a living document. When you approve a [Proposed] tag during review, add it to the relevant domain in the JSON file so future books can use it.

To add a new tag:
```
claude "Add 'Japanese literature' to the Literature domain in tag-vocabulary.json"
```

To add a new domain:
```
claude "Add a new domain 'Education' with tags ['Pedagogy', 'Curriculum', 'Higher education'] and LCC prefix 'L' to tag-vocabulary.json"
```

## API dependencies

- **Anthropic API**: Used for spine reading (Vision) and tag inference. Requires ANTHROPIC_API_KEY.
- **Open Library API**: https://openlibrary.org/api — free, no key needed. Primary lookup for ISBN, LCC, publisher.
- **Google Books API**: https://www.googleapis.com/books/v1/volumes — fallback lookup. Free tier is sufficient.

## Notes

- The pipeline never auto-uploads to LibraryThing. Every batch requires human review.
- Spine photos work best with 10-15 books, upright, even lighting.
- Dark-on-dark spines are the most common failure mode. When a spine can't be read, it's flagged as LOW confidence with a note.
- The system prompt includes 8 few-shot examples from the owner's existing collection to calibrate tag inference for this specific library's intellectual profile.
