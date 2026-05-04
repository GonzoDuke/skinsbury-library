import Link from 'next/link';

export default function SeriesPage() {
  return (
    <div className="max-w-2xl mx-auto py-16 text-center">
      <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-2">
        Series tracking
      </div>
      <h1 className="typo-page-title">Coming soon</h1>
      <p className="text-text-secondary mt-3 mb-8 leading-relaxed">
        Gaps in series you collect — when book 1, 2, and 4 are present but
        book 3 is missing. Series-aware data is partially wired (Wikidata
        and ISBNdb both surface series fields); this view will detect gaps
        once series detection is reliable enough to act on.
      </p>
      <Link
        href="/stacks"
        className="inline-block px-4 py-2 rounded-md bg-surface-card border border-line text-text-secondary hover:bg-surface-page transition text-[13px]"
      >
        ← Back to Stacks
      </Link>
    </div>
  );
}
