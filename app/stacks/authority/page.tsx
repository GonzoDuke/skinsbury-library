import Link from 'next/link';

export default function AuthorityPage() {
  return (
    <div className="max-w-2xl mx-auto py-16 text-center">
      <div className="text-[11px] uppercase tracking-wider text-text-tertiary mb-2">
        Authority check
      </div>
      <h1 className="typo-page-title">Coming soon</h1>
      <p className="text-text-secondary mt-3 mb-8 leading-relaxed">
        Author-name normalization across your library — merge variants like
        &quot;Solnit, R.&quot; and &quot;Solnit, Rebecca&quot; or keep them
        separate. The Stacks dashboard already detects conflicts; this view
        will surface them with one-click merge controls.
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
