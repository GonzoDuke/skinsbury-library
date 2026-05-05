'use client';

import Link from 'next/link';

/**
 * Outlined link-chip for a single LCSH subject heading. Routes to
 * /lcsh?h={encoded} so the user can browse other books carrying the
 * same heading.
 *
 * Visually distinct from TagChip — TagChip is filled and reserved for
 * the controlled genre/form vocabulary; LCSHs are free-text cataloger
 * metadata and read as outlined external-reference links. Mono font
 * preserved because LCSH punctuation (commas, em-dashes, parens, dates)
 * reads better in mono.
 */
export function LcshChipLink({ heading }: { heading: string }) {
  return (
    <Link
      href={`/lcsh?h=${encodeURIComponent(heading)}`}
      aria-label={`Browse books with the heading: ${heading}`}
      className="inline-flex items-center rounded-md border border-line text-text-secondary hover:border-navy hover:text-navy hover:bg-navy-soft focus:outline-none focus:border-navy focus:bg-navy-soft transition-colors px-2 py-0.5 text-[11.5px] font-mono leading-snug cursor-pointer max-w-full"
    >
      <span className="break-words">{heading}</span>
    </Link>
  );
}
