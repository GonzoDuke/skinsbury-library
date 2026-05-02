import { NextRequest, NextResponse } from 'next/server';
import {
  entriesMatch,
  mergeLedgerAdditions,
  type LedgerEntry,
} from '@/lib/export-ledger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const REPO = process.env.GITHUB_REPO || 'GonzoDuke/carnegie';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const LEDGER_PATH = 'lib/export-ledger.json';

interface PostBody {
  add?: LedgerEntry[];
  removeBatchLabels?: (string | null)[];
  clearAll?: boolean;
  /**
   * Tag rename: replace every occurrence of `from` in any entry's
   * `tags` array with `to`. Case-insensitive match. Used by the
   * Vocabulary screen so a rename propagates to historical exports.
   */
  renameTag?: { from: string; to: string };
}

interface GhFile {
  content?: string; // base64
  sha: string;
  encoding?: string;
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
      'User-Agent': 'carnegie-ledger-bot',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  return res;
}

interface FetchedLedger {
  entries: LedgerEntry[];
  sha: string | null;
}

async function fetchLedger(): Promise<FetchedLedger> {
  const r = await ghFetch(
    `/repos/${REPO}/contents/${LEDGER_PATH}?ref=${encodeURIComponent(BRANCH)}`
  );
  if (r.status === 404) {
    // First-write case — file doesn't exist yet. Empty ledger, no SHA.
    return { entries: [], sha: null };
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub GET ${LEDGER_PATH}: ${r.status} ${text.slice(0, 300)}`);
  }
  const file = (await r.json()) as GhFile;
  const decoded = file.content
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    parsed = [];
  }
  const entries = Array.isArray(parsed)
    ? (parsed.filter(
        (e) =>
          e &&
          typeof e === 'object' &&
          typeof (e as LedgerEntry).date === 'string' &&
          typeof (e as LedgerEntry).titleNorm === 'string' &&
          typeof (e as LedgerEntry).authorNorm === 'string' &&
          typeof (e as LedgerEntry).isbn === 'string'
      ) as LedgerEntry[])
    : [];
  return { entries, sha: file.sha };
}

async function putLedger(
  entries: LedgerEntry[],
  sha: string | null,
  message: string
): Promise<GhCommitResponse> {
  const json = JSON.stringify(entries, null, 2) + '\n';
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(json, 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await ghFetch(`/repos/${REPO}/contents/${LEDGER_PATH}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub PUT ${LEDGER_PATH}: ${r.status} ${text.slice(0, 300)}`);
  }
  return (await r.json()) as GhCommitResponse;
}

/**
 * Read the authoritative ledger from the repo. Returns `available: false`
 * when GITHUB_TOKEN isn't configured so the client can fall back to a
 * pure localStorage flow without raising errors.
 */
export async function GET() {
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json({ available: false, entries: [] });
  }
  try {
    const { entries, sha } = await fetchLedger();
    return NextResponse.json({
      available: true,
      entries,
      sha,
      repo: REPO,
      branch: BRANCH,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ledger GET] failed:', message);
    return NextResponse.json(
      { available: true, error: 'GitHub API error', details: message },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json(
      { available: false, error: 'GITHUB_TOKEN not configured' },
      { status: 501 }
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const additions = Array.isArray(body.add) ? body.add : [];
  const removeLabels = Array.isArray(body.removeBatchLabels)
    ? body.removeBatchLabels
    : [];
  const clearAll = body.clearAll === true;
  const renameFrom =
    body.renameTag && typeof body.renameTag.from === 'string'
      ? body.renameTag.from.trim()
      : '';
  const renameTo =
    body.renameTag && typeof body.renameTag.to === 'string'
      ? body.renameTag.to.trim()
      : '';
  const doRename = renameFrom.length > 0 && renameTo.length > 0 && renameFrom !== renameTo;

  if (!clearAll && additions.length === 0 && removeLabels.length === 0 && !doRename) {
    return NextResponse.json({ error: 'Empty delta' }, { status: 400 });
  }

  // Validate the entries shape so a malformed POST can't poison the file.
  const validAdditions = additions.filter(
    (e) =>
      e &&
      typeof e === 'object' &&
      typeof e.date === 'string' &&
      typeof e.titleNorm === 'string' &&
      typeof e.authorNorm === 'string' &&
      typeof e.isbn === 'string'
  );

  try {
    const { entries: current, sha } = await fetchLedger();

    let next: LedgerEntry[] = current;
    if (clearAll) {
      next = [];
    } else if (removeLabels.length > 0) {
      const labelSet = new Set(removeLabels);
      next = next.filter((e) => {
        const label = e.batchLabel ?? null;
        return !labelSet.has(label);
      });
    }
    if (validAdditions.length > 0) {
      next = mergeLedgerAdditions(next, validAdditions);
    }
    let renameAffected = 0;
    if (doRename) {
      const fromLower = renameFrom.toLowerCase();
      next = next.map((e) => {
        if (!e.tags || e.tags.length === 0) return e;
        let mutated = false;
        const seen = new Set<string>();
        const nextTags: string[] = [];
        for (const t of e.tags) {
          const replaced = t.toLowerCase() === fromLower ? renameTo : t;
          // Drop dupes that the rename might create (a row that had
          // both old and new names ends up with two identical tags).
          if (seen.has(replaced.toLowerCase())) {
            mutated = true;
            continue;
          }
          seen.add(replaced.toLowerCase());
          if (replaced !== t) mutated = true;
          nextTags.push(replaced);
        }
        if (!mutated) return e;
        renameAffected += 1;
        return { ...e, tags: nextTags };
      });
    }

    // Skip the write when nothing actually changed — saves a no-op commit.
    if (
      next.length === current.length &&
      next.every((e, i) => entriesMatch(e, current[i]))
    ) {
      return NextResponse.json({
        available: true,
        entries: next,
        sha,
        unchanged: true,
        repo: REPO,
        branch: BRANCH,
      });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const messageParts: string[] = [];
    if (clearAll) messageParts.push('clear');
    if (removeLabels.length > 0) {
      const labelDesc = removeLabels
        .map((l) => (l === null ? 'unlabeled' : `"${l}"`))
        .join(', ');
      messageParts.push(`remove ${removeLabels.length} batch(es): ${labelDesc}`);
    }
    if (validAdditions.length > 0) {
      messageParts.push(
        `add ${validAdditions.length} ${validAdditions.length === 1 ? 'entry' : 'entries'}`
      );
    }
    if (doRename && renameAffected > 0) {
      messageParts.push(
        `rename "${renameFrom}" → "${renameTo}" (${renameAffected} ${renameAffected === 1 ? 'entry' : 'entries'})`
      );
    }
    const message = `Ledger: ${messageParts.join('; ')} (${dateStr})`;

    const commit = await putLedger(next, sha, message);

    return NextResponse.json({
      available: true,
      entries: next,
      sha: commit.content?.sha ?? null,
      commit: { url: commit.commit?.html_url, sha: commit.commit?.sha },
      repo: REPO,
      branch: BRANCH,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ledger POST] failed:', message);
    return NextResponse.json(
      { available: true, error: 'GitHub API error', details: message },
      { status: 502 }
    );
  }
}
