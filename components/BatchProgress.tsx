interface Props {
  total: number;
  done: number;
  label: string;
  /** When true, an indeterminate stripe animates over the bar fill so the
      user knows work is still happening between determinate updates. */
  active?: boolean;
}

export function BatchProgress({ total, done, label, active = true }: Props) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="bg-cream-50 dark:bg-ink-soft/60 border border-cream-300 dark:border-ink-soft rounded-lg p-5">
      <div className="flex items-center justify-between text-sm mb-3">
        <span className="text-ink/80 dark:text-cream-300/80 font-medium">{label}</span>
        <span className="font-mono text-ink/70 dark:text-cream-300/70">
          {done} / {total} <span className="text-ink/40 dark:text-cream-300/40">·</span>{' '}
          <span className="text-brass-deep dark:text-brass font-semibold">{pct}%</span>
        </span>
      </div>
      <div className="relative h-3 bg-limestone dark:bg-ink rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-brass transition-all duration-500 ease-gentle rounded-full"
          style={{ width: `${pct}%` }}
        />
        {active && pct < 100 && (
          <div
            className="absolute inset-0 opacity-40 animate-stripe"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, rgba(255,255,255,0.35) 0 10px, transparent 10px 20px)',
              backgroundSize: '28px 28px',
            }}
          />
        )}
      </div>
    </div>
  );
}
