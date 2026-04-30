import { NextRequest, NextResponse } from 'next/server';
import { lookupBook } from '@/lib/book-lookup';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { title?: string; author?: string };
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
  const result = await lookupBook(title, author);
  const ms = Date.now() - t0;
  console.log(
    `[lookup-book] "${title}"${author ? ` / ${author}` : ''} → ${result.source}` +
      `${result.isbn ? ` isbn=${result.isbn}` : ''}` +
      `${result.lcc ? ` lcc=${result.lcc}` : ''}` +
      ` (${ms}ms)`
  );
  return NextResponse.json(result);
}
