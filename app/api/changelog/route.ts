import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';

/**
 * Serve the contents of lib/vocabulary-changelog.md so the Vocabulary
 * screen can render its history pane without hitting GitHub. The file
 * is bundled with the app, so this is just a disk read — no auth, no
 * rate limit. Returns plain text so the client can do its own parsing.
 *
 * On Vercel the file lives at process.cwd()/lib/vocabulary-changelog.md
 * (Next includes the lib/ tree at build time when files inside it are
 * imported elsewhere — and lib/tag-vocabulary.json is imported, which
 * pulls the directory in). If the file is somehow missing we return an
 * empty string instead of 500-ing.
 */
export async function GET() {
  try {
    const p = path.join(process.cwd(), 'lib', 'vocabulary-changelog.md');
    const text = await readFile(p, 'utf8');
    return new NextResponse(text, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new NextResponse('', {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
}
