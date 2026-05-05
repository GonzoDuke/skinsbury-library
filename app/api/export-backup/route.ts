import { NextRequest, NextResponse } from 'next/server';
import {
  mergeLedgerAdditions,
  type LedgerEntry,
} from '@/lib/export-ledger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const REPO = process.env.GITHUB_REPO || 'GonzoDuke/carnegie';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const LEDGER_PATH = 'lib/export-ledger.json';
const BACKUPS_DIR = 'data/export-backups';

// ---------------------------------------------------------------------------
// One atomic Git Trees commit per export. Each export produces exactly one
// commit that contains:
//   - the JSON backup file(s) added under data/export-backups/
//   - the export-ledger.json updated with the run's additions merged in
//
// Mirrors /api/commit-vocabulary's Trees flow. The two-PUT alternative
// (Contents API on each path) split atomicity — a transient failure on the
// second write left half-applied state in the repo. Trees keeps blobs
// dangling until the final ref PATCH lands, so any pre-PATCH failure is
// a no-op on the visible repo state.
// ---------------------------------------------------------------------------

interface BackupFileInput {
  /** Filename only (no slashes). Lands at `data/export-backups/{filename}`. */
  filename: string;
  /** UTF-8 backup contents (the BackupEnvelope JSON, already serialized). */
  content: string;
}

interface CommitBody {
  backups: BackupFileInput[];
  additions: LedgerEntry[];
  /** Optional override; otherwise we synthesize from filenames + counts. */
  commitMessage?: string;
}

async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = process.env.GITHUB_TOKEN!;
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'carnegie-export-backup-bot',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
}

async function ghFetchOrThrow(path: string, init?: RequestInit): Promise<Response> {
  const r = await ghFetch(path, init);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(
      `GitHub ${init?.method ?? 'GET'} ${path}: ${r.status} ${text.slice(0, 300)}`
    );
  }
  return r;
}

interface RefResponse {
  object: { sha: string; type: string };
}
interface CommitResponse {
  sha: string;
  tree: { sha: string };
  html_url: string;
}
interface TreeResponse {
  sha: string;
  tree: { path: string; sha: string; type: string }[];
}

async function getRefSha(): Promise<string> {
  const r = await ghFetchOrThrow(
    `/repos/${REPO}/git/ref/heads/${encodeURIComponent(BRANCH)}`
  );
  return ((await r.json()) as RefResponse).object.sha;
}

async function getCommit(sha: string): Promise<CommitResponse> {
  const r = await ghFetchOrThrow(`/repos/${REPO}/git/commits/${sha}`);
  return (await r.json()) as CommitResponse;
}

async function getTree(sha: string): Promise<TreeResponse> {
  const r = await ghFetchOrThrow(`/repos/${REPO}/git/trees/${sha}`);
  return (await r.json()) as TreeResponse;
}

async function getBlobUtf8(sha: string): Promise<string> {
  const r = await ghFetchOrThrow(`/repos/${REPO}/git/blobs/${sha}`);
  const data = (await r.json()) as { content?: string; encoding?: string };
  if (!data.content) return '';
  if (data.encoding === 'utf-8') return data.content;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function createBlob(content: string): Promise<string> {
  const r = await ghFetchOrThrow(`/repos/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({
      content: Buffer.from(content, 'utf8').toString('base64'),
      encoding: 'base64',
    }),
  });
  return ((await r.json()) as { sha: string }).sha;
}

async function createTree(
  baseTreeSha: string,
  entries: { path: string; blobSha: string }[]
): Promise<string> {
  const r = await ghFetchOrThrow(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: entries.map((e) => ({
        path: e.path,
        mode: '100644',
        type: 'blob',
        sha: e.blobSha,
      })),
    }),
  });
  return ((await r.json()) as { sha: string }).sha;
}

async function createCommit(
  message: string,
  treeSha: string,
  parentSha: string
): Promise<{ sha: string; html_url: string }> {
  const r = await ghFetchOrThrow(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentSha],
    }),
  });
  return (await r.json()) as { sha: string; html_url: string };
}

interface UpdateRefOutcome {
  ok: boolean;
  status: number;
  conflict: boolean;
  errorBody?: string;
}

async function tryUpdateRef(commitSha: string): Promise<UpdateRefOutcome> {
  const r = await ghFetch(
    `/repos/${REPO}/git/refs/heads/${encodeURIComponent(BRANCH)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ sha: commitSha, force: false }),
    }
  );
  if (r.ok) return { ok: true, status: r.status, conflict: false };
  const text = await r.text();
  const conflict =
    r.status === 422 &&
    /not a fast forward|fast-forward|stale/i.test(text);
  return { ok: false, status: r.status, conflict, errorBody: text.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Read the current ledger out of the parent tree. Walks `lib/` to find
// export-ledger.json. Returns `[]` when the file doesn't exist yet.
// ---------------------------------------------------------------------------
async function readLedgerFromTree(rootTreeSha: string): Promise<LedgerEntry[]> {
  const root = await getTree(rootTreeSha);
  const libEntry = root.tree.find((t) => t.path === 'lib' && t.type === 'tree');
  if (!libEntry) return [];
  const libTree = await getTree(libEntry.sha);
  const ledgerEntry = libTree.tree.find(
    (t) => t.path === 'export-ledger.json' && t.type === 'blob'
  );
  if (!ledgerEntry) return [];
  const text = await getBlobUtf8(ledgerEntry.sha);
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        e &&
        typeof e === 'object' &&
        typeof (e as LedgerEntry).date === 'string' &&
        typeof (e as LedgerEntry).titleNorm === 'string' &&
        typeof (e as LedgerEntry).authorNorm === 'string' &&
        typeof (e as LedgerEntry).isbn === 'string'
    ) as LedgerEntry[];
  } catch {
    return [];
  }
}

function isValidFilename(name: string): boolean {
  // Reject anything that could climb out of the backups dir.
  if (typeof name !== 'string') return false;
  if (!name) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  if (name.length > 200) return false;
  return /\.json$/i.test(name);
}

// Lightweight availability probe so the client can render the right CTA.
export async function GET() {
  return NextResponse.json({
    available: !!process.env.GITHUB_TOKEN,
    repo: REPO,
    branch: BRANCH,
  });
}

export async function POST(req: NextRequest) {
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json(
      { available: false, error: 'GITHUB_TOKEN not configured' },
      { status: 501 }
    );
  }

  let body: CommitBody;
  try {
    body = (await req.json()) as CommitBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const backups = Array.isArray(body.backups) ? body.backups : [];
  const additions = Array.isArray(body.additions) ? body.additions : [];

  if (backups.length === 0) {
    return NextResponse.json(
      { error: 'backups must be a non-empty array' },
      { status: 400 }
    );
  }
  for (const b of backups) {
    if (!b || typeof b !== 'object' || !isValidFilename(b.filename)) {
      return NextResponse.json(
        { error: `bad backup filename: ${JSON.stringify((b as BackupFileInput | null)?.filename ?? null)}` },
        { status: 400 }
      );
    }
    if (typeof b.content !== 'string' || !b.content.length) {
      return NextResponse.json(
        { error: `bad backup content for ${b.filename}` },
        { status: 400 }
      );
    }
  }

  // Validate ledger additions the same way /api/ledger does so a malformed
  // POST can't poison the file.
  const validAdditions = additions.filter(
    (e) =>
      e &&
      typeof e === 'object' &&
      typeof e.date === 'string' &&
      typeof e.titleNorm === 'string' &&
      typeof e.authorNorm === 'string' &&
      typeof e.isbn === 'string'
  );

  const message =
    typeof body.commitMessage === 'string' && body.commitMessage.trim()
      ? body.commitMessage.trim()
      : defaultMessage(backups.length, validAdditions.length);

  // Pre-build the backup blobs once. Blob create is content-addressed —
  // the same bytes always produce the same SHA — so a fast-forward retry
  // doesn't need to re-upload these.
  const backupBlobShas: { path: string; blobSha: string }[] = [];
  for (const b of backups) {
    const blobSha = await createBlob(b.content);
    backupBlobShas.push({
      path: `${BACKUPS_DIR}/${b.filename}`,
      blobSha,
    });
  }

  const buildAndPush = async (): Promise<{
    commit: { sha: string; html_url: string };
    mergedEntries: LedgerEntry[];
  }> => {
    const parentSha = await getRefSha();
    const parentCommit = await getCommit(parentSha);
    const baseTreeSha = parentCommit.tree.sha;

    // Read the ledger off the parent tree so concurrent writers don't
    // get stomped. Merge our additions into that current state.
    const currentLedger = await readLedgerFromTree(baseTreeSha);
    const mergedLedger =
      validAdditions.length > 0
        ? mergeLedgerAdditions(currentLedger, validAdditions)
        : currentLedger;

    const ledgerJson = JSON.stringify(mergedLedger, null, 2) + '\n';
    const ledgerBlobSha = await createBlob(ledgerJson);

    const treeEntries = [
      ...backupBlobShas,
      { path: LEDGER_PATH, blobSha: ledgerBlobSha },
    ];
    const newTreeSha = await createTree(baseTreeSha, treeEntries);
    const commit = await createCommit(message, newTreeSha, parentSha);

    const first = await tryUpdateRef(commit.sha);
    if (first.ok) return { commit, mergedEntries: mergedLedger };
    if (!first.conflict) {
      throw new Error(
        `GitHub PATCH ref: ${first.status} ${first.errorBody ?? ''}`
      );
    }
    // Fast-forward conflict — rebuild on the new parent. Single retry.
    return rebuildAndUpdate();
  };

  const rebuildAndUpdate = async (): Promise<{
    commit: { sha: string; html_url: string };
    mergedEntries: LedgerEntry[];
  }> => {
    const parentSha = await getRefSha();
    const parentCommit = await getCommit(parentSha);
    const baseTreeSha = parentCommit.tree.sha;
    const currentLedger = await readLedgerFromTree(baseTreeSha);
    const mergedLedger =
      validAdditions.length > 0
        ? mergeLedgerAdditions(currentLedger, validAdditions)
        : currentLedger;
    const ledgerJson = JSON.stringify(mergedLedger, null, 2) + '\n';
    const ledgerBlobSha = await createBlob(ledgerJson);
    const treeEntries = [
      ...backupBlobShas,
      { path: LEDGER_PATH, blobSha: ledgerBlobSha },
    ];
    const newTreeSha = await createTree(baseTreeSha, treeEntries);
    const commit = await createCommit(message, newTreeSha, parentSha);
    const second = await tryUpdateRef(commit.sha);
    if (second.ok) return { commit, mergedEntries: mergedLedger };
    throw new Error(
      `GitHub PATCH ref (after fast-forward retry): ${second.status} ${second.errorBody ?? ''}`
    );
  };

  try {
    const { commit, mergedEntries } = await buildAndPush();
    return NextResponse.json({
      available: true,
      ok: true,
      commit: { sha: commit.sha, url: commit.html_url, message },
      entries: mergedEntries,
      backups: backupBlobShas.map((b) => b.path),
      repo: REPO,
      branch: BRANCH,
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error('[export-backup POST] failed:', errMessage);
    return NextResponse.json(
      { available: true, error: 'GitHub API error', details: errMessage },
      { status: 502 }
    );
  }
}

// Generic fallback for when the caller doesn't supply a commitMessage.
// Real callers (the Export screen) always supply one with the batch label
// and count baked in, but a programmatic POST without one still gets a
// readable default.
function defaultMessage(fileCount: number, bookCount: number): string {
  const fileWord = fileCount === 1 ? 'file' : 'files';
  const bookWord = bookCount === 1 ? 'book' : 'books';
  return `Export backup: ${fileCount} ${fileWord} (${bookCount} ${bookWord})`;
}
