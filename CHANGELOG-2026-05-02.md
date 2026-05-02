# Changelog — 2026-05-02

A long shipping day. The 56 commits below run from a brand polish pass through
the v3.0 mobile-first release into two new features (barcode scanning,
LibraryThing import) and a 14-item UX pass. Auto-generated cross-device sync
commits (`Pending batch …`) are noted but not described — they're side
effects of the day's manual exercise of the new sync flow, not user-facing
changes.

---

## Brand & visual identity

- `0241548` PWA icons: tartan-pattern PNGs at 192/512, manifest reference
- `4d589dc` Tartan icons: render at native resolution with crisp-edges, no upscaling
- `5e5eb67` Density bump: scale UI for desktop screens
- `f6f4d3d` Sidebar: 260px width + 48px tartan + bigger CARNEGIE wordmark
- `6f94a38` Brand: tartan panel + spine-stack logo, retire the tartan C / accent stripe
- `5426604` Brand panel: switch to a real tartan photo with dark scrim
- `372163b` Brand panel: revert to CSS-generated tartan, drop the dark photo
- `552dcef` Brand panel: square 260×260, content centered slightly above mid-height
- `871fde5` Brand panel: scale up content + radial vignette behind the text

## v3.0 mobile-first release — phone shell + cross-device sync

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
- `5f257dd` v3.0.0 — bump package.json + CHANGELOG release section

## Vocabulary curation (data, not code)

- `882d340` Vocabulary: alphabetize the whole page
- `14364a1` Vocabulary: add "Drugs" to Social & political (vocabulary)
- `4bd3ab3` Vocabulary: add "Drugs" to Social & political (changelog)
- `7896df8` Vocabulary: remove "drugs" from Literature (vocabulary)
- `5fe9172` Vocabulary: remove "drugs" from Literature (changelog)

## Feature: ISBN barcode scanning

- `8f9845b` Scan pipeline: ISBN → lookup → tag-infer → BookRecord (`lib/scan-pipeline.ts`, OL/GB cascade, LoC SRU LCC fill, empty-result path)
- `a0e5cd9` BarcodeScanner UI + Capture wiring (native `BarcodeDetector` + `@zxing/browser` fallback, viewfinder modal, lazy "Barcode scans" batch)
- `a283df9` Review surfaces: "Scanned" badge on barcode-sourced books
- `989ea5a` Barcode scanner: confirm-on-every-scan + ISBN dedup pass (rewrites the auto-loop into an explicit state machine: scanning → confirm → dup-confirm → between-scans; Review-mount cleanup pass collapses dupe ISBNs that the old loop produced)
- `e0aec16` BarcodeScanner: 100ms haptic pulse on ISBN lock-on

## Feature: LibraryThing catalog import

- `d877944` LibraryThing import parser + preview builder (JSON / CSV / TSV, RFC 4180 streaming scanner, field map, dedup preview)
- `278a78d` LT import: dialog + History page button (5-state dialog, reuses `pushLedgerDelta` for server-side dedup)

## UX pass — 14 small improvements

- `126985e` #1 Upload: ETA copy under Process-all (~45s/photo baseline)
- `5452258` #2 Upload: batch-label dropdown of past labels from the ledger
- `191d525` #3 Upload: post-processing summary toast (books / unreadable spines)
- `ba63f3a` #4 Upload: notification + chime + vibration on processing finish
- `4217f3a` #5 Review: "Approve all & export" shortcut + auto-download on /export
- `543813b` #6 TagPicker: "Frequently used" section ranked by ledger usage
- `5c9671d` #7 Review: clickable column headers (Book / Conf. / Tags) cycle sort
- `4869ff1` #8 Export: small "Upload this file to LibraryThing" link below download
- `d7fdf1f` #9 Vocabulary: tag search (real-time filter, both viewports)
- `19892b8` #10 Vocabulary: rename tags + propagate to historical ledger entries (new `renameTag` op on `/api/ledger`)
- `e0aec16` #11 BarcodeScanner: 100ms haptic pulse on ISBN lock-on (cross-listed under barcode scanner)
- `290116c` #12 MobileShell: tab bar 48px+ minimum, icons-only under 360px
- `9a5f2ea` #13 Undo toast for destructive actions (reject / batch delete / clear)
- `2f911a1` #14 Sidebar stats: shimmer skeleton until ledger sync resolves

## Auto-generated sync commits

The cross-device pending-batches sync writes a commit each time a batch is
pushed or removed. These are not user-facing changes — they're artifacts of
manually exercising the sync flow during the day:

- `0cac0e7`, `c5f8b82`, `a9a946f`, `b312a5a`, `c78bbbb`, `5f4407c`,
  `2497633`, `4a12371`, `6248676`, `b6a979f`

---

**Total: 56 commits, ~16 user-facing features / changes, two new features
shipped end-to-end, one major release tag (v3.0.0).**
