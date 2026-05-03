import { NextRequest, NextResponse } from 'next/server';
import type { PhotoBatch } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const REPO = process.env.GITHUB_REPO || 'GonzoDuke/carnegie';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const DIR_PATH = 'data/pending-batches';

interface GhFile {
  content?: string;
  sha: string;
  encoding?: string;
  name?: string;
  path?: string;
  type?: string;
}

interface GhCommitResponse {
  content?: { path: string; sha: string };
  commit?: { sha: string; html_url: string; message: string };
}

async function ghFetch(path: string, init?: RequestInit) {
  const token = process.env.GITHUB_TOKEN!;
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'carnegie-pending-batches-bot',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  return res;
}

async function getFile(path: string): Promise<{ content: string; sha: string } | null> {
  const r = await ghFetch(
    `/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub GET ${path}: ${r.status} ${text.slice(0, 300)}`);
  }
  const file = (await r.json()) as GhFile;
  const decoded = file.content
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : '';
  return { content: decoded, sha: file.sha };
}

async function putFile(
  path: string,
  content: string,
  sha: string | null,
  message: string
): Promise<GhCommitResponse> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await ghFetch(`/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub PUT ${path}: ${r.status} ${text.slice(0, 300)}`);
  }
  return (await r.json()) as GhCommitResponse;
}

/**
 * PUT with one automatic retry on 409 (stale SHA) — fetches the current
 * SHA again and replays the write. The content for a single batch is
 * always a full overwrite, so the retry can safely use the latest SHA
 * without recomputing anything. Anything other than 409 is rethrown
 * after the first attempt so caller error-handling paths stay clean.
 */
async function putFileWithSha409Retry(
  path: string,
  content: string,
  initialSha: string | null,
  message: string
): Promise<GhCommitResponse> {
  try {
    return await putFile(path, content, initialSha, message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/^GitHub PUT [^:]+: 409 /.test(msg)) {
      throw err;
    }
    // Stale SHA — another writer landed first. Re-fetch and retry once.
    const fresh = await getFile(path);
    return await putFile(path, content, fresh?.sha ?? null, message);
  }
}

async function deleteFile(path: string, sha: string, message: string): Promise<void> {
  const r = await ghFetch(`/repos/${REPO}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: BRANCH }),
  });
  if (!r.ok && r.status !== 404) {
    const text = await r.text();
    throw new Error(`GitHub DELETE ${path}: ${r.status} ${text.slice(0, 300)}`);
  }
}

async function listDir(path: string): Promise<GhFile[]> {
  const r = await ghFetch(
    `/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`
  );
  if (r.status === 404) return [];
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub LIST ${path}: ${r.status} ${text.slice(0, 300)}`);
  }
  const data = (await r.json()) as GhFile[] | GhFile;
  if (!Array.isArray(data)) return [];
  return data.filter((f) => f.type === 'file' && f.name?.endsWith('.json'));
}

function safeBatchId(id: string): string | null {
  // Whitelist what makeId() produces — alphanumerics, dashes, underscores.
  // Anything else gets rejected so a crafted batchId can't escape the dir.
  if (!id || id.length > 80) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

/**
 * Read every pending batch from data/pending-batches/. Returns
 * `available: false` when GITHUB_TOKEN isn't configured so the client can
 * fall back to a pure localStorage flow without raising errors.
 */
export async function GET() {
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json({ available: false, batches: [] });
  }
  try {
    const files = await listDir(DIR_PATH);
    if (files.length === 0) {
      return NextResponse.json({ available: true, batches: [], repo: REPO, branch: BRANCH });
    }
    // The directory listing endpoint omits per-file `content`, so always
    // fan out to per-file GETs. N is small (≤ a few dozen pending batches).
    const results = await Promise.all(
      files.map(async (f) => {
        if (!f.path) return null;
        try {
          const got = await getFile(f.path);
          if (!got) return null;
          const parsed = JSON.parse(got.content) as PhotoBatch;
          return parsed;
        } catch {
          return null;
        }
      })
    );
    const batches = results.filter(
      (b): b is PhotoBatch =>
        !!b && typeof b === 'object' && typeof b.id === 'string' && Array.isArray(b.books)
    );
    return NextResponse.json({
      available: true,
      batches,
      repo: REPO,
      branch: BRANCH,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pending-batches GET] failed:', message);
    return NextResponse.json(
      { available: true, error: 'GitHub API error', details: message },
      { status: 502 }
    );
  }
}

/**
 * Write a single batch to data/pending-batches/{id}.json. Body must be
 * the full PhotoBatch (slimmed by the client to drop ocrImage). SHA is
 * resolved server-side so re-processing the same batch overwrites cleanly.
 */
export async function POST(req: NextRequest) {
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json(
      { available: false, error: 'GITHUB_TOKEN not configured' },
      { status: 501 }
    );
  }

  let batch: PhotoBatch;
  try {
    batch = (await req.json()) as PhotoBatch;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!batch || typeof batch !== 'object' || typeof batch.id !== 'string') {
    return NextResponse.json({ error: 'Missing batch.id' }, { status: 400 });
  }
  const id = safeBatchId(batch.id);
  if (!id) {
    return NextResponse.json({ error: 'Invalid batch.id' }, { status: 400 });
  }
  if (!Array.isArray(batch.books)) {
    return NextResponse.json({ error: 'batch.books must be an array' }, { status: 400 });
  }

  const filePath = `${DIR_PATH}/${id}.json`;
  const json = JSON.stringify(batch, null, 2) + '\n';
  const dateStr = new Date().toISOString().slice(0, 10);
  const labelDesc = batch.batchLabel ? `"${batch.batchLabel}"` : 'unlabeled';
  const message = `Pending batch ${labelDesc}: ${batch.books.length} book(s) (${dateStr})`;

  try {
    const existing = await getFile(filePath);
    const commit = await putFileWithSha409Retry(
      filePath,
      json,
      existing?.sha ?? null,
      message
    );
    return NextResponse.json({
      available: true,
      ok: true,
      id,
      sha: commit.content?.sha ?? null,
      commit: { url: commit.commit?.html_url, sha: commit.commit?.sha },
      repo: REPO,
      branch: BRANCH,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pending-batches POST] failed:', message);
    return NextResponse.json(
      { available: true, error: 'GitHub API error', details: message },
      { status: 502 }
    );
  }
}

/**
 * Delete a single pending batch by id (query param `?batchId=…`). Used
 * after CSV export and on Clear/New-session. Idempotent — a missing file
 * returns ok so the client can retry without erroring.
 */
export async function DELETE(req: NextRequest) {
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json(
      { available: false, error: 'GITHUB_TOKEN not configured' },
      { status: 501 }
    );
  }

  const raw = req.nextUrl.searchParams.get('batchId');
  if (!raw) {
    return NextResponse.json({ error: 'Missing batchId' }, { status: 400 });
  }
  const id = safeBatchId(raw);
  if (!id) {
    return NextResponse.json({ error: 'Invalid batchId' }, { status: 400 });
  }

  const filePath = `${DIR_PATH}/${id}.json`;
  try {
    const existing = await getFile(filePath);
    if (!existing) {
      return NextResponse.json({ available: true, ok: true, id, missing: true });
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    await deleteFile(filePath, existing.sha, `Pending batch removed: ${id} (${dateStr})`);
    return NextResponse.json({ available: true, ok: true, id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pending-batches DELETE] failed:', message);
    return NextResponse.json(
      { available: true, error: 'GitHub API error', details: message },
      { status: 502 }
    );
  }
}
