'use client';

import {
  domainForTag,
  formCategory,
  isProposedTag,
  type DomainKey,
  type FormCategory,
} from '@/lib/tag-domains';

const DOMAIN_CLASSES: Record<DomainKey, string> = {
  philosophy: 'bg-philosophy-bg text-philosophy-fg dark:bg-philosophy-fg/45 dark:text-philosophy-bg',
  religion: 'bg-religion-bg text-religion-fg dark:bg-religion-fg/45 dark:text-religion-bg',
  psychology: 'bg-psychology-bg text-psychology-fg dark:bg-psychology-fg/45 dark:text-psychology-bg',
  literature: 'bg-literature-bg text-literature-fg dark:bg-literature-fg/45 dark:text-literature-bg',
  language: 'bg-language-bg text-language-fg dark:bg-language-fg/45 dark:text-language-bg',
  history: 'bg-history-bg text-history-fg dark:bg-history-fg/45 dark:text-history-bg',
  media_tech: 'bg-media_tech-bg text-media_tech-fg dark:bg-media_tech-fg/45 dark:text-media_tech-bg',
  social_political: 'bg-social_political-bg text-social_political-fg dark:bg-social_political-fg/45 dark:text-social_political-bg',
  science: 'bg-science-bg text-science-fg dark:bg-science-fg/45 dark:text-science-bg',
  biography: 'bg-biography-bg text-biography-fg dark:bg-biography-fg/45 dark:text-biography-bg',
  arts_culture: 'bg-arts_culture-bg text-arts_culture-fg dark:bg-arts_culture-fg/45 dark:text-arts_culture-bg',
  books_libraries: 'bg-books_libraries-bg text-books_libraries-fg dark:bg-books_libraries-fg/45 dark:text-books_libraries-bg',
  _unclassified: 'bg-cream-200 text-ink dark:bg-ink-soft dark:text-cream-200',
};

const FORM_CLASSES: Record<FormCategory, string> = {
  content:
    'bg-transparent text-ink/70 dark:text-cream-200/70 border border-ink/30 dark:border-cream-300/30',
  series: 'bg-cream-200 text-ink dark:bg-ink-soft dark:text-cream-200',
  collectible: 'bg-gold-bg text-gold-fg dark:bg-gold-fg/45 dark:text-gold-bg',
};

interface TagChipProps {
  tag: string;
  variant: 'genre' | 'form';
  onRemove?: () => void;
  size?: 'sm' | 'md';
}

export function TagChip({ tag, variant, onRemove, size = 'md' }: TagChipProps) {
  const proposed = isProposedTag(tag);
  let classes = '';
  if (variant === 'genre') {
    const domain = domainForTag(tag) ?? '_unclassified';
    classes = DOMAIN_CLASSES[domain];
  } else {
    const cat = formCategory(tag) ?? 'content';
    classes = FORM_CLASSES[cat];
  }

  const sizeClass = size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1';

  return (
    <span
      className={`group inline-flex items-center gap-1 rounded-full transition-all duration-150 ease-gentle ${classes} ${sizeClass} ${
        proposed ? 'border border-dashed' : ''
      }`}
    >
      {proposed && <span className="opacity-60 italic">[Proposed]</span>}
      <span className="font-medium">
        {proposed ? tag.replace(/^\[Proposed\]\s*/i, '') : tag}
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${tag}`}
          onClick={onRemove}
          className="opacity-0 scale-90 group-hover:opacity-70 group-hover:scale-100 hover:!opacity-100 transition-all duration-100 ease-out w-3.5 h-3.5 leading-none flex items-center justify-center text-[14px]"
        >
          ×
        </button>
      )}
    </span>
  );
}
