/**
 * About Carnegie — static editorial page. No state, no API calls, no
 * interactivity beyond the link styling. Layout per spec:
 *   - 80px tartan bar at the top (same pattern as the sidebar brand
 *     panel) anchoring the page visually
 *   - 640px max-width text column, 48px top padding
 *   - Outfit typography stack, with the five "How it works" stages
 *     styled as weight-600 name + em-dash + body
 *   - Footer pulls the version number from package.json so a single
 *     bump in package.json keeps everything in sync (no separate
 *     constant to forget about).
 */

import pkg from '../../package.json';

const PKG_VERSION = pkg.version;

const NAVY = '#1B3A5C';

// Trim a 3.5.0 → 3.5 for display. Anything that doesn't end in .0 is
// shown verbatim so a real patch release surfaces correctly.
const SHORT_VERSION = PKG_VERSION.endsWith('.0')
  ? PKG_VERSION.slice(0, PKG_VERSION.lastIndexOf('.'))
  : PKG_VERSION;

// Same repeating-linear-gradient layers used by the sidebar BrandPanel,
// minus the radial vignette (which is keyed to wordmark placement and
// would just darken the bar uselessly here).
const tartanLayers = [
  'repeating-linear-gradient(180deg,' +
    'rgba(196,163,90,0.55) 0px 4px,' +
    'transparent 4px 14px,' +
    'rgba(45,90,58,0.50) 14px 20px,' +
    'transparent 20px 26px,' +
    'rgba(20,20,20,0.55) 26px 36px,' +
    'transparent 36px 42px,' +
    'rgba(184,50,50,0.55) 42px 48px,' +
    'transparent 48px 54px,' +
    'rgba(196,163,90,0.55) 54px 58px,' +
    'transparent 58px 64px)',
  'repeating-linear-gradient(90deg,' +
    'rgba(196,163,90,0.40) 0px 4px,' +
    'transparent 4px 18px,' +
    'rgba(45,90,58,0.40) 18px 24px,' +
    'transparent 24px 30px,' +
    'rgba(20,20,20,0.45) 30px 40px,' +
    'transparent 40px 46px,' +
    'rgba(184,50,50,0.40) 46px 52px,' +
    'transparent 52px 58px,' +
    'rgba(196,163,90,0.40) 58px 62px,' +
    'transparent 62px 64px)',
].join(',');

interface Stage {
  name: string;
  body: string;
}

const STAGES: Stage[] = [
  {
    name: 'Detection',
    body: "Claude identifies individual book spines in a shelf photo and draws bounding boxes around each one (for spines the camera can't read, scan the ISBN barcode directly — it skips straight to lookup and tagging, filling in what the photo pipeline missed).",
  },
  {
    name: 'Reading',
    body: 'each spine is cropped and sent to Claude Opus, which reads the title, author, and any other visible text at full resolution.',
  },
  {
    name: 'Lookup',
    body: 'the extracted text is searched across Open Library, the Library of Congress, ISBNdb, Google Books, Wikidata, and OCLC Classify to fill in ISBN, publisher, publication year, and LCC classification.',
  },
  {
    name: 'Tagging',
    body: "Claude infers genre and form tags from a controlled vocabulary based on the book's classification, subject headings, and author profile.",
  },
  {
    name: 'Review',
    body: 'every result is presented for human approval. Nothing exports without a person confirming it.',
  },
];

export default function AboutPage() {
  return (
    <div
      className="mx-auto pt-12 font-[Outfit,system-ui,sans-serif]"
      style={{ maxWidth: 640 }}
    >
      {/* Tartan bar — anchors the page like the sidebar brand panel.
          Navy base so the gradient layers read against a known color
          in dark mode and light. */}
      <div
        aria-hidden
        className="rounded-lg"
        style={{
          height: 80,
          backgroundColor: NAVY,
          backgroundImage: tartanLayers,
        }}
      />

      <h1
        className="mt-8 text-text-primary"
        style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}
      >
        About <CarnegieName>Carnegie</CarnegieName>
      </h1>

      <SectionLabel>What this is</SectionLabel>
      <Body>
        <CarnegieName>Carnegie</CarnegieName> is a personal cataloging system that
        photographs bookshelves and turns spines into library records. You take a
        picture, the app reads the spines, looks up each book across six
        bibliographic databases, infers subject tags from classification data, and
        exports everything as a clean CSV for LibraryThing.
      </Body>
      <Body>
        It was built to solve a specific problem: hundreds of books in boxes with
        no catalog connecting them. Typing each one into LibraryThing by hand
        wasn&rsquo;t going to happen. So this happened instead.
      </Body>

      <SectionLabel>Why the name</SectionLabel>
      <Body>
        Andrew Carnegie funded 2,509 free public libraries between 1883 and 1929.
        More than any individual in history. He believed that access to books was
        the foundation of a self-educated life. His father was a handloom weaver
        in Dunfermline, Scotland, and the tartan pattern in this app is the
        Carnegie clan tartan.
      </Body>

      <SectionLabel>How it works</SectionLabel>
      <Body>The pipeline has five stages:</Body>
      <ul className="list-none p-0 mt-3 mb-0">
        {STAGES.map((s) => (
          <li
            key={s.name}
            className="text-text-secondary mb-3"
            style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.7 }}
          >
            <span className="text-text-primary" style={{ fontWeight: 600 }}>
              {s.name}
            </span>{' '}
            — {s.body}
          </li>
        ))}
      </ul>

      <SectionLabel>Built with</SectionLabel>
      <Body>
        Claude by Anthropic (spine reading, tag inference) · Next.js · Vercel ·
        Open Library · Library of Congress SRU · ISBNdb · Google Books · Wikidata
        · OCLC Classify · LibraryThing
      </Body>

      <SectionLabel>Built by</SectionLabel>
      <Body className="!mt-2">
        A librarian with too many books and not enough shelves.
      </Body>

      <div
        className="text-center"
        style={{
          marginTop: 32,
          fontFamily: 'Outfit, system-ui, sans-serif',
          fontSize: 11,
          color: 'var(--text-4)',
        }}
      >
        ver. {SHORT_VERSION}
      </div>

      <div className="h-12" aria-hidden />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-text-tertiary mt-8 mb-2"
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '1px',
      }}
    >
      {children}
    </div>
  );
}

function Body({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`text-text-secondary mb-3 ${className ?? ''}`}
      style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.7 }}
    >
      {children}
    </p>
  );
}

function CarnegieName({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-text-primary" style={{ fontWeight: 600 }}>
      {children}
    </span>
  );
}
