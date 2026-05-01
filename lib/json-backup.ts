import type { BookRecord } from './types';

/**
 * Companion JSON written next to every CSV download. Captures the full
 * BookRecord shape (not just LibraryThing's flat columns) so the user
 * has a permanent, portable backup independent of localStorage. Image
 * data URIs are stripped — the same trade-off lib/store.tsx already
 * makes when persisting state — so files stay small (KB, not MB).
 */
export interface BackupEnvelope {
  schemaVersion: '1.0';
  app: 'Carnegie';
  /** ISO 8601 timestamp of when the backup was generated. */
  exportedAt: string;
  /** Filename of the CSV this backup pairs with. Lets restore tools rejoin pairs. */
  csvCompanion: string;
  /** Present when the user picked "Separate CSV per batch". */
  batchLabel?: string;
  bookCount: number;
  books: BookRecord[];
}

function stripImageData(book: BookRecord): BookRecord {
  // Mirror the slim-down in lib/store.tsx — drop the data URIs, keep
  // everything else. ocrImage is intentionally undefined (not '') so
  // restore tooling can distinguish "we had no crop" from "we stripped
  // a crop"; spineThumbnail is '' for the same reason store.tsx uses ''.
  return { ...book, spineThumbnail: '', ocrImage: undefined };
}

export function generateBackupJson(
  books: BookRecord[],
  options: { csvCompanion: string; batchLabel?: string; date?: Date }
): string {
  const date = options.date ?? new Date();
  const envelope: BackupEnvelope = {
    schemaVersion: '1.0',
    app: 'Carnegie',
    exportedAt: date.toISOString(),
    csvCompanion: options.csvCompanion,
    batchLabel: options.batchLabel,
    bookCount: books.length,
    books: books.map(stripImageData),
  };
  return JSON.stringify(envelope, null, 2);
}
