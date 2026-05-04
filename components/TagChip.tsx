'use client';

import {
  domainForTag,
  formCategory,
  isProposedTag,
  type DomainKey,
  type FormCategory,
} from '@/lib/tag-domains';

const DOMAIN_CLASSES: Record<DomainKey, string> = {
  general_works: 'bg-general_works-bg text-general_works-fg dark:bg-general_works-fg/45 dark:text-general_works-bg',
  philosophy_psychology_religion: 'bg-philosophy_psychology_religion-bg text-philosophy_psychology_religion-fg dark:bg-philosophy_psychology_religion-fg/45 dark:text-philosophy_psychology_religion-bg',
  auxiliary_history: 'bg-auxiliary_history-bg text-auxiliary_history-fg dark:bg-auxiliary_history-fg/45 dark:text-auxiliary_history-bg',
  world_history: 'bg-world_history-bg text-world_history-fg dark:bg-world_history-fg/45 dark:text-world_history-bg',
  american_history: 'bg-american_history-bg text-american_history-fg dark:bg-american_history-fg/45 dark:text-american_history-bg',
  local_american_history: 'bg-local_american_history-bg text-local_american_history-fg dark:bg-local_american_history-fg/45 dark:text-local_american_history-bg',
  geography_recreation: 'bg-geography_recreation-bg text-geography_recreation-fg dark:bg-geography_recreation-fg/45 dark:text-geography_recreation-bg',
  social_sciences: 'bg-social_sciences-bg text-social_sciences-fg dark:bg-social_sciences-fg/45 dark:text-social_sciences-bg',
  political_science: 'bg-political_science-bg text-political_science-fg dark:bg-political_science-fg/45 dark:text-political_science-bg',
  law: 'bg-law-bg text-law-fg dark:bg-law-fg/45 dark:text-law-bg',
  education: 'bg-education-bg text-education-fg dark:bg-education-fg/45 dark:text-education-bg',
  music: 'bg-music-bg text-music-fg dark:bg-music-fg/45 dark:text-music-bg',
  fine_arts: 'bg-fine_arts-bg text-fine_arts-fg dark:bg-fine_arts-fg/45 dark:text-fine_arts-bg',
  language_literature: 'bg-language_literature-bg text-language_literature-fg dark:bg-language_literature-fg/45 dark:text-language_literature-bg',
  science: 'bg-science-bg text-science-fg dark:bg-science-fg/45 dark:text-science-bg',
  medicine: 'bg-medicine-bg text-medicine-fg dark:bg-medicine-fg/45 dark:text-medicine-bg',
  agriculture: 'bg-agriculture-bg text-agriculture-fg dark:bg-agriculture-fg/45 dark:text-agriculture-bg',
  technology: 'bg-technology-bg text-technology-fg dark:bg-technology-fg/45 dark:text-technology-bg',
  military_science: 'bg-military_science-bg text-military_science-fg dark:bg-military_science-fg/45 dark:text-military_science-bg',
  naval_science: 'bg-naval_science-bg text-naval_science-fg dark:bg-naval_science-fg/45 dark:text-naval_science-bg',
  books_libraries: 'bg-books_libraries-bg text-books_libraries-fg dark:bg-books_libraries-fg/45 dark:text-books_libraries-bg',
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
    const domain = domainForTag(tag) ?? 'general_works';
    classes = DOMAIN_CLASSES[domain];
  } else {
    const cat = formCategory(tag) ?? 'content';
    classes = FORM_CLASSES[cat];
  }

  // Bumped from 10/12px to 12/13px text and 4px×10px padding so tag
  // pills read at the same density as the rest of the v3 app.
  const sizeClass =
    size === 'sm'
      ? 'text-[12px] px-2.5 py-[3px]'
      : 'text-[13px] px-[10px] py-1';

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
