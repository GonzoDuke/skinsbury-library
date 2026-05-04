import vocab from './tag-vocabulary.json';

/**
 * The 21 LCC-aligned domain keys. These mirror the Library of
 * Congress Classification's top-level class letters one-to-one — no
 * splits, no promotions, no personal preferences. The taxonomy is
 * fixed and universal; the user's collection populates whatever
 * subset of it they happen to own. Empty domains are de-emphasized
 * in the UI but never hidden.
 */
export type DomainKey =
  | 'general_works'                  // A
  | 'philosophy_psychology_religion' // B
  | 'auxiliary_history'              // C (incl. CT biography subclass)
  | 'world_history'                  // D
  | 'american_history'               // E
  | 'local_american_history'         // F
  | 'geography_recreation'           // G
  | 'social_sciences'                // H
  | 'political_science'              // J
  | 'law'                            // K
  | 'education'                      // L
  | 'music'                          // M
  | 'fine_arts'                      // N
  | 'language_literature'            // P
  | 'science'                        // Q
  | 'medicine'                       // R
  | 'agriculture'                    // S
  | 'technology'                     // T
  | 'military_science'               // U
  | 'naval_science'                  // V
  | 'books_libraries';               // Z

interface DomainEntry {
  label: string;
  lcc_letter: string;
  description?: string;
  tags: string[];
}

export const VOCAB = vocab as {
  domains: Record<DomainKey, DomainEntry>;
  form_tags: {
    content_forms: string[];
    series: string[];
    collectible: string[];
  };
};

/**
 * Map from LCC class letter to domain key. Built once at module load
 * by walking VOCAB.domains. The matcher is dead-simple: take the first
 * letter of book.lcc and look it up in this map.
 */
const LETTER_TO_DOMAIN: Record<string, DomainKey> = {};
for (const key of Object.keys(VOCAB.domains) as DomainKey[]) {
  const letter = VOCAB.domains[key].lcc_letter;
  if (letter) LETTER_TO_DOMAIN[letter.toUpperCase()] = key;
}

/**
 * Domain-from-LCC matcher. Trivial by design — the first uppercase
 * letter of the LCC call number IS the domain. No second-letter
 * inspection, no carve-outs.
 *
 * Returns `general_works` (A's domain) when the LCC is empty or starts
 * with a character that isn't in the LCC class-letter map. The user
 * re-files via Review.
 */
export function domainForLcc(lcc: string | undefined | null): DomainKey {
  if (!lcc) return 'general_works';
  const m = lcc.trim().match(/^([A-Za-z])/);
  if (!m) return 'general_works';
  const hit = LETTER_TO_DOMAIN[m[1].toUpperCase()];
  return hit ?? 'general_works';
}

const tagToDomain = new Map<string, DomainKey>();
for (const key of Object.keys(VOCAB.domains) as DomainKey[]) {
  for (const tag of VOCAB.domains[key].tags) {
    tagToDomain.set(tag, key);
  }
}

export function domainForTag(tag: string): DomainKey | null {
  if (!tag) return null;
  const cleaned = tag.replace(/^\[Proposed\]\s*/i, '');
  return tagToDomain.get(cleaned) ?? null;
}

export function isProposedTag(tag: string): boolean {
  return /^\[Proposed\]/i.test(tag);
}

export const FORM_CONTENT = new Set(VOCAB.form_tags.content_forms);
export const FORM_SERIES = new Set(VOCAB.form_tags.series);
export const FORM_COLLECTIBLE = new Set(VOCAB.form_tags.collectible);

export type FormCategory = 'content' | 'series' | 'collectible';

export function formCategory(tag: string): FormCategory | null {
  const cleaned = tag.replace(/^\[Proposed\]\s*/i, '');
  if (FORM_CONTENT.has(cleaned)) return 'content';
  if (FORM_SERIES.has(cleaned)) return 'series';
  if (FORM_COLLECTIBLE.has(cleaned)) return 'collectible';
  return null;
}

export const ALL_GENRE_TAGS: { domain: DomainKey; label: string; tag: string }[] = [];
for (const key of Object.keys(VOCAB.domains) as DomainKey[]) {
  for (const tag of VOCAB.domains[key].tags) {
    ALL_GENRE_TAGS.push({ domain: key, label: VOCAB.domains[key].label, tag });
  }
}

export const ALL_FORM_TAGS: string[] = [
  ...VOCAB.form_tags.content_forms,
  ...VOCAB.form_tags.series,
  ...VOCAB.form_tags.collectible,
];

/**
 * Migration map from schema-1.0 domain keys (the 12-domain closed-world
 * taxonomy) to schema-2.0 domain keys (the 21-domain LCC-aligned
 * taxonomy). Used at hydration time to translate any persisted domain
 * strings (BookRecord.inferredDomains, CorrectionEntry.domain) so they
 * point at the new domain set.
 *
 * The mapping loses information in three places (history → world_history
 * could have been american_history; social_political → social_sciences
 * could have been political_science; arts_culture → fine_arts could have
 * been music). The user can re-tag those books from Review if the
 * mis-routing matters.
 */
export const LEGACY_DOMAIN_MIGRATION: Record<string, DomainKey> = {
  philosophy: 'philosophy_psychology_religion',
  religion: 'philosophy_psychology_religion',
  psychology: 'philosophy_psychology_religion',
  literature: 'language_literature',
  language: 'language_literature',
  history: 'world_history',
  media_tech: 'technology',
  social_political: 'social_sciences',
  science: 'science',
  biography: 'auxiliary_history',
  arts_culture: 'fine_arts',
  books_libraries: 'books_libraries',
  _unclassified: 'general_works',
};

/**
 * Translate a stored domain string to its current-schema equivalent.
 * Returns the input unchanged when it's already a valid current key.
 * Returns `general_works` for unrecognized strings (defensive default).
 */
export function migrateLegacyDomain(stored: string): DomainKey {
  if ((stored as DomainKey) in VOCAB.domains) return stored as DomainKey;
  return LEGACY_DOMAIN_MIGRATION[stored] ?? 'general_works';
}
