import { NextRequest, NextResponse } from 'next/server';
import { lookupBook, lookupSpecificEdition } from '@/lib/book-lookup';

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

  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const t0 = Date.now();
  const result = body.matchEdition
    ? await lookupSpecificEdition(title, author, {
        year: body.hints?.year,
        publisher: body.hints?.publisher,
        isbn: body.hints?.isbn,
      })
    : await lookupBook(title, author);
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
}
