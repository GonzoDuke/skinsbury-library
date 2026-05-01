# Carnegie — brand and UI update

This is a visual rebrand and UX tightening pass. No new features — just making the existing app look and feel better.

## Project identity

- **Project name:** Carnegie (developer-facing, repo, package.json, README)
- **User-facing name:** The T.L. Skinsbury Library (AppShell header, page titles, PWA manifest, CSV filenames)
- **Tagline/subtitle:** "Personal catalog" stays

## Color palette — replace Princeton orange

The entire Princeton orange (#C85A12) accent system gets replaced with a library-inspired palette:

### Primary colors
- **Library green** `#1E3A2F` — primary accent, buttons, active nav, header background
- **Brass** `#C9A96E` — secondary accent, highlights, active states, progress indicators
- **Fern** `#2D5A4A` — hover states, secondary buttons

### Backgrounds
- **Marble** `#F5F2EB` — page background (light mode), replaces #FAFAF7
- **Limestone** `#E8E2D4` — card backgrounds, surfaces (light mode)
- **Warm dark** `#1A1A18` — page background (dark mode, keep as-is)
- **Dark surface** `#242422` — card backgrounds (dark mode, keep as-is)

### Accent for warnings/errors
- **Mahogany** `#8B4513` — warm alternative to pure red for warnings and low-confidence badges
- Keep existing semantic colors (red for reject, green for approve) but warm them slightly

### Tag domain colors
- Keep the existing domain color system — it already works well. No changes to tag pill colors.

### Where to apply
- `tailwind.config.ts` — update the accent color from `#C85A12` to `#1E3A2F`. Add brass as a secondary accent.
- `app/globals.css` — update any hardcoded orange values
- `components/AppShell.tsx` — header background becomes library green, with brass accent for the active nav pill
- `components/BatchProgress.tsx` — progress bar fill becomes brass instead of orange
- `components/PhotoUploader.tsx` — dropzone hover border becomes library green
- All buttons currently using orange → library green primary, brass for secondary/highlight actions
- "Approve remaining" and "Approve all HIGH confidence" buttons → brass background with dark text (these are positive actions, brass reads as warm/affirmative)
- Reject buttons stay red-toned but use a warmer red

## Typography — keep what works, refine

- **Book titles** on BookCards: keep Source Serif 4 — it's perfect for the literary feel
- **Wordmark** in the AppShell header: switch from Source Serif 4 to **Cormorant Garamond** (import from Google Fonts), displayed in regular weight with `letter-spacing: 2px`. "The T.L. Skinsbury Library" in Cormorant feels more institutional.
- **UI text**: keep Inter — no change needed
- **Monospace** (ISBN, LCC, CSV preview): keep JetBrains Mono — no change
- **Page headings** ("Review & approve", "Export"): switch to Cormorant Garamond to match the header. These are the "architectural inscription" moments.

## AppShell header redesign

Current: orange "S" square icon + "The T.L. Skinsbury Library" + nav pills + Light/Dark toggle

New:
- Background: library green `#1E3A2F`
- Text: limestone `#E8E2D4` for the library name, brass `#C9A96E` for "Personal catalog" subtitle
- Library name in Cormorant Garamond, regular weight, slightly letterspaced
- No icon/logo — just the text wordmark. Clean and institutional.
- Nav pills: brass background for active tab, transparent with limestone text for inactive
- Light/Dark toggle: limestone colored, same position
- Drop the badge count from the nav pill (the "Review 13" currently) — move the count into the Review page header instead. The nav should be clean.

## Upload page (homepage) cleanup

Current layout is functional but could guide the user better. Changes:

### Hero section
- Add a brief welcome line above the dropzone in Cormorant Garamond: "Photograph your shelves. We'll handle the rest."
- This replaces any generic heading. One line, sets the tone.

### Dropzone
- Border color on hover: library green instead of orange
- The photography hints should be more prominent — not hidden below the dropzone. Put them INSIDE the dropzone as a secondary line: "Landscape · fill the frame · 2–3 feet away · flash off"
- Drop the "JPG, PNG, or HEIC" format text — nobody needs to see this. If they upload the wrong format, show an error then.

### Batch label section
- Move the batch label and notes inputs ABOVE the dropzone, not below. The mental flow is: "I'm about to catalog Shelf 3" → label it → then upload photos. Currently the label comes after, which is backwards.
- Style the batch label input with a subtle brass underline instead of a full border. Feels like writing on an index card.

### Processing panel
- Progress bar: brass fill on limestone track
- The pulsing dot: brass instead of orange
- "Current step" text: keep as-is, it works well

## Review page cleanup

### Stats tiles
- Slightly round the corners more (border-radius-lg)
- "Pending" count in brass instead of orange
- "Low confidence" count in mahogany instead of red

### Filter/sort row
- Active filter pill: brass background with dark text instead of orange
- Active sort button: same treatment

### BookCard refinements
- The spine thumbnail on the left should have a subtle limestone border, not a hard edge
- The "from spine" / "from LoC" / "from OCLC" badges next to LCC: style in small caps, brass text
- The confidence badge: keep HIGH as green, MEDIUM as brass (not amber), LOW as mahogany
- Warning banners: mahogany background tint instead of bright orange/red
- The "Reread / Reject / Approve" action row: Approve gets a brass accent on hover, Reject gets warm red

### Floating "Approve remaining" button
- Brass background with library green text — this is the primary CTA on the page, it should feel warm and inviting, not alarming

## Export page

- Download button: library green background, limestone text
- CSV preview: keep the monospace styling, but use a limestone background instead of the current gray

## Dark mode adjustments

- Library green becomes slightly lighter in dark mode for contrast: `#2D5A4A` (fern)
- Brass stays the same — gold tones read well on dark backgrounds
- Limestone text on dark backgrounds: use `#E8E2D4`
- Card borders: keep the existing warm dark borders

## Fonts to import

Add to `app/layout.tsx` or `tailwind.config.ts`:

```
Cormorant Garamond — weights 400, 500 — from Google Fonts
```

Source Serif 4, Inter, and JetBrains Mono should already be loaded.

## Files to change

- `tailwind.config.ts` — accent colors, font family additions
- `app/layout.tsx` — Cormorant Garamond import
- `app/globals.css` — any hardcoded colors, background gradient
- `app/page.tsx` — homepage layout changes (hero line, input reorder, dropzone copy)
- `app/review/page.tsx` — filter/sort pill colors, stat tile colors
- `app/export/page.tsx` — button colors, preview background
- `components/AppShell.tsx` — header redesign
- `components/BookCard.tsx` — badge colors, warning banner colors, action button colors
- `components/BatchProgress.tsx` — progress bar colors
- `components/PhotoUploader.tsx` — dropzone border, photography hints placement
- `components/ConfidenceBadge.tsx` — MEDIUM becomes brass, LOW becomes mahogany
- `components/TagChip.tsx` — no changes (domain colors stay)

## Do not change

- Tag domain color system — it works, leave it alone
- The three-screen flow (Upload → Review → Export) — no structural changes
- BookCard layout and information hierarchy — just color and type refinements
- Any feature logic — this is purely visual
