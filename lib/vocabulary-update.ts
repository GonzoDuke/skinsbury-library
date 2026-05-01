import { VOCAB, domainForTag, type DomainKey } from './tag-domains';
import type { BookRecord } from './types';

export interface ProposedTagPromotion {
  /** The tag with the `[Proposed]` prefix stripped. */
  tag: string;
  /** Which vocabulary domain this tag should be filed under. */
  domain: DomainKey;
  /** Display label for the domain (e.g., "Literature"). */
  domainLabel: string;
  /** First book the proposed tag was seen on — used in the changelog. */
  sourceBook: { title: string; author: string; batchLabel?: string };
}

/**
 * Scan a set of books for `[Proposed] X` tags, dedupe by tag string,
 * and assign each one to a domain using:
 *   1. The book's LCC code against domain LCC prefixes (most reliable)
 *   2. Majority-vote of the book's other non-proposed tags' domains
 *   3. `_unclassified` as a last resort
 */
export function findProposedTagsToPromote(books: BookRecord[]): ProposedTagPromotion[] {
  const map = new Map<string, ProposedTagPromotion>();
  for (const book of books) {
    for (const tag of [...book.genreTags, ...book.formTags]) {
      const m = tag.match(/^\[Proposed\]\s*(.+)$/i);
      if (!m) continue;
      const cleanTag = m[1].trim();
      if (!cleanTag) continue;
      // Dedupe — first sighting wins.
      if (map.has(cleanTag.toLowerCase())) continue;
      const domain = inferDomainForTag(book);
      map.set(cleanTag.toLowerCase(), {
        tag: cleanTag,
        domain,
        domainLabel: VOCAB.domains[domain].label,
        sourceBook: {
          title: book.title,
          author: book.author,
          batchLabel: book.batchLabel,
        },
      });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.domainLabel === b.domainLabel
      ? a.tag.localeCompare(b.tag)
      : a.domainLabel.localeCompare(b.domainLabel)
  );
}

function inferDomainForTag(book: BookRecord): DomainKey {
  // 1) LCC prefix match — most reliable when available.
  if (book.lcc) {
    const lccPrefix = book.lcc
      .toUpperCase()
      .match(/^[A-Z]{1,3}/)?.[0];
    if (lccPrefix) {
      for (const [key, def] of Object.entries(VOCAB.domains) as [DomainKey, typeof VOCAB.domains[DomainKey]][]) {
        if (key === '_unclassified') continue;
        for (const prefix of def.lcc_prefixes) {
          if (lccPrefix.startsWith(prefix)) return key;
        }
      }
    }
  }

  // 2) Majority vote of the book's existing (non-proposed) tags.
  const counts = new Map<DomainKey, number>();
  for (const t of book.genreTags) {
    if (/^\[Proposed\]/i.test(t)) continue;
    const d = domainForTag(t);
    if (d && d !== '_unclassified') counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: DomainKey | null = null;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  if (best) return best;

  // 3) Fallback.
  return '_unclassified';
}

/**
 * Produce a JSON string for the updated tag-vocabulary.json with the new
 * tags merged in. Pretty-printed at 2 spaces to match the repo format.
 */
export function buildUpdatedVocabularyJson(promotions: ProposedTagPromotion[]): string {
  // Deep clone the source vocabulary so we don't mutate the imported one.
  const updated = JSON.parse(JSON.stringify(VOCAB)) as typeof VOCAB;
  for (const p of promotions) {
    const tags = updated.domains[p.domain].tags;
    if (!tags.some((t) => t.toLowerCase() === p.tag.toLowerCase())) {
      tags.push(p.tag);
    }
  }
  // Bump the schema's `updated` field to today.
  (updated as unknown as { updated: string }).updated = new Date()
    .toISOString()
    .slice(0, 10);
  return JSON.stringify(updated, null, 2) + '\n';
}

/**
 * Produce the changelog markdown additions for these promotions. Designed
 * to be appended to the existing vocabulary-changelog.md.
 */
export function buildChangelogEntries(
  promotions: ProposedTagPromotion[],
  date: Date = new Date()
): string {
  const dateStr = date.toISOString().slice(0, 10);
  const lines: string[] = [`## ${dateStr}`, ''];
  for (const p of promotions) {
    const src = p.sourceBook.batchLabel ? ` (batch "${p.sourceBook.batchLabel}")` : '';
    lines.push(
      `- Added \`${p.tag}\` to **${p.domainLabel}**${src} — first seen on "${p.sourceBook.title}" by ${p.sourceBook.author || '(unknown)'}`
    );
  }
  lines.push('');
  return lines.join('\n');
}
