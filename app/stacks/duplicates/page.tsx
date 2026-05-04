import Link from 'next/link';

export default function DuplicatesPage() {
  return (
    <div className="max-w-2xl mx-auto py-16 text-center">
      <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-2">
        Duplicates &amp; editions
      </div>
      <h1 className="typo-page-title">Coming soon</h1>
      <p className="text-text-secondary mt-3 mb-8 leading-relaxed">
        Multiple copies and editions of the same work in your library. The
        Stacks dashboard already detects works that appear more than once;
        this view will let you mark each as &quot;keep both&quot; or merge
        editions while preserving the export-ledger history.
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
