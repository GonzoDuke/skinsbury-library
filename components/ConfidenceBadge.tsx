import type { Confidence } from '@/lib/types';

const STYLES: Record<Confidence, string> = {
  HIGH: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-900',
  MEDIUM: 'bg-brass-soft text-brass-deep dark:bg-brass/20 dark:text-brass border-brass/40',
  LOW: 'bg-mahogany/15 text-mahogany dark:bg-mahogany/30 dark:text-orange-200 border-mahogany/40',
};

export function ConfidenceBadge({ level }: { level: Confidence }) {
  return (
    <span
      className={`inline-flex items-center text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded border ${STYLES[level]}`}
    >
      {level}
    </span>
  );
}
