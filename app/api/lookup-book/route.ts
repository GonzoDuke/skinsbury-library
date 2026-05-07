import { NextRequest, NextResponse } from 'next/server';
import { lookupBook, lookupSpecificEdition } from '@/lib/book-lookup';
import { structuredErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';

interface LookupRequest {
  title?: string;
  author?: string;
  /** When true, scope the lookup to the user's specific edition using the hints below. */
  matchEdition?: boolean;
  hints?: {
    year?: number;
    publisher?: string;
    isbn?: string;
  };
  /** Spine-extracted edition / series strings forwarded from Pass-B
   *  OCR. The lookup pipeline uses them as Phase-1 candidate-scoring
   *  tie-breakers — never as authoritative metadata.  */
  extractedEdition?: string;
  extractedSeries?: string;
  /** Spine-extracted call number + system from a sticker. When the
   *  system is 'lcc', the lookup pipeline derives an LCC class hint
   *  from this and uses it as a decisive Phase-1 differentiator. */
  extractedCallNumber?: string;
  extractedCallNumberSystem?: string;
}

export async function POST(req: NextRequest) {
  let body: LookupRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const title = (body.title ?? '').trim();
  const author = (body.author ?? '').trim();
  const isbnHint = (body.hints?.isbn ?? '').trim();

  // matchEdition + an ISBN hint is enough on its own — barcode-scan
  // callers go this route with no title/author. The non-edition path
  // still requires a title because the title-driven cascade has
  // nothing to query without one.
  if (!title && !(body.matchEdition && isbnHint)) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  // Wrap the lookup chain in a try/catch so a thrown error from any
  // tier (network, parse, third-party 5xx) returns structured JSON
  // instead of bubbling to Next's default HTML 500 page. The client
  // pipeline expects a JSON body either way.
  try {
    const t0 = Date.now();
    const lookupOpts =
      body.extractedEdition ||
      body.extractedSeries ||
      body.extractedCallNumber
        ? {
            extractedEdition: body.extractedEdition || undefined,
            extractedSeries: body.extractedSeries || undefined,
            extractedCallNumber: body.extractedCallNumber || undefined,
            extractedCallNumberSystem: body.extractedCallNumberSystem || undefined,
          }
        : undefined;
    const result = body.matchEdition
      ? await lookupSpecificEdition(
          title,
          author,
          {
            year: body.hints?.year,
            publisher: body.hints?.publisher,
            isbn: body.hints?.isbn,
          },
          lookupOpts
        )
      : await lookupBook(title, author, lookupOpts);
    const ms = Date.now() - t0;
    const tier = (result as { tier?: string }).tier;
    console.log(
      `[lookup-book${body.matchEdition ? ' edition' : ''}] "${title}"${author ? ` / ${author}` : ''} → ${result.source}` +
        `${tier && tier !== 'none' ? ` ${tier}` : ''}` +
        `${result.isbn ? ` isbn=${result.isbn}` : ''}` +
        `${result.lcc ? ` lcc=${result.lcc}` : ''}` +
        ` (${ms}ms)`
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[lookup-book] failed:', message);
    return structuredErrorResponse(err, {
      error: 'Lookup failed',
      // No `model` — lookup-book calls external APIs (OL, ISBNdb,
      // MARC), not Anthropic.
      requestShape:
        `lookup-book${body.matchEdition ? ' edition' : ''}: ` +
        `title="${title}" author="${author}" isbn="${isbnHint}"`,
    });
  }
}
