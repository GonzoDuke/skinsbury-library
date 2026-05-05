/**
 * Two-letter (occasionally one-letter) LCC sub-class labels for the
 * Shelflist view. Short conventional labels, NOT the full LCC schedule
 * names — the goal is human-scannable browsing, not authoritative
 * cataloging text.
 *
 * The seed below comes from the spec; additional sub-classes can be
 * appended over time. Where a sub-class isn't in the map, the UI falls
 * back to showing just the letters with no label (acceptable
 * degradation per spec).
 *
 * `subclassFor(lcc)` extracts the leading run of letters from a call
 * number; e.g. "PR6063.U7 N56" → "PR", "P327" → "P", "BX1763 .R4" → "BX".
 */

export const SUBCLASS_LABELS: Record<string, string> = {
  // B — Philosophy, psychology, religion
  BC: 'Logic',
  BD: 'Speculative philosophy',
  BF: 'Psychology',
  BH: 'Aesthetics',
  BJ: 'Ethics',
  BL: 'Religions',
  BM: 'Judaism',
  BP: 'Islam',
  BR: 'Christianity (general)',
  BS: 'Bible',
  BT: 'Doctrinal theology',
  BV: 'Practical theology',
  BX: 'Christian denominations',

  // D — World history (excluding the Americas)
  DA: 'Great Britain',
  DB: 'Austria, Liechtenstein, Hungary, Czechoslovakia',
  DC: 'France',
  DD: 'Germany',
  DE: 'Greco-Roman world',
  DF: 'Greece',
  DG: 'Italy',
  // Spec lists DH-DJ as "Low Countries"; expanded into separate keys
  // so the 2-letter extractor finds either form.
  DH: 'Low Countries',
  DJ: 'Low Countries',
  DK: 'Russia, former Soviet Union',
  DL: 'Northern Europe, Scandinavia',
  DP: 'Spain, Portugal',
  DQ: 'Switzerland',
  DR: 'Balkan Peninsula',
  DS: 'Asia',
  DT: 'Africa',
  DU: 'Oceania',

  // H — Social sciences
  HM: 'Sociology',
  HQ: 'Family, marriage, women',
  HV: 'Social pathology, social welfare',

  // M — Music
  ML: 'Music history and biography',
  MT: 'Music instruction',

  // N — Fine arts (one-letter "N" is general; two-letter sub-classes
  // are the finer-grained ones).
  N: 'Visual arts (general)',
  NA: 'Architecture',
  NB: 'Sculpture',
  NC: 'Drawing, design, illustration',
  ND: 'Painting',
  NE: 'Print media',
  NK: 'Decorative arts',
  NX: 'Arts in general',

  // P — Language and literature
  PA: 'Greek and Latin',
  PB: 'Modern languages, Celtic',
  PC: 'Romance languages',
  PD: 'Germanic languages',
  PE: 'English language',
  PF: 'West Germanic languages',
  PG: 'Slavic, Baltic, Albanian languages',
  PH: 'Uralic, Basque',
  PJ: 'Oriental languages',
  PK: 'Indo-Iranian',
  PL: 'Eastern Asia, Africa, Oceania',
  PM: 'Hyperborean, Indian, Artificial languages',
  PN: 'Literature, general',
  PQ: 'Romance literatures',
  PR: 'English literature',
  PS: 'American literature',
  PT: 'Germanic literatures',
  PZ: "Children's literature, fiction in foreign languages",

  // T — Technology
  TA: 'General engineering',
  TC: 'Hydraulic engineering',
  TD: 'Environmental technology',
  TE: 'Highway engineering',
  TF: 'Railroad engineering',
  TG: 'Bridge engineering',
  TH: 'Building construction',
  TJ: 'Mechanical engineering',
  TK: 'Electrical engineering',
  TL: 'Motor vehicles, aeronautics',
  TN: 'Mining engineering',
  TP: 'Chemical technology',
  TR: 'Photography',
  TS: 'Manufacturing',
  TT: 'Handicrafts, arts and crafts',
  TX: 'Home economics',

  // Z — Bibliography, library science
  Z: 'Books, libraries, information',
};

/**
 * Extract the leading-letters run from a call number. Used both to
 * group books into sub-classes for the Shelflist accordion and to
 * key into SUBCLASS_LABELS for display. Returns the empty string when
 * the LCC is missing or doesn't start with a letter — caller should
 * treat empty as "couldn't classify" and surface in the unclassified
 * count.
 */
export function subclassFor(lcc: string | undefined | null): string {
  if (!lcc) return '';
  const m = lcc.trim().match(/^([A-Za-z]+)/);
  if (!m) return '';
  return m[1].toUpperCase();
}

export function subclassLabel(subclass: string): string {
  return SUBCLASS_LABELS[subclass] ?? '';
}
