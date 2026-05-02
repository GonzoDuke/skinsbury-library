import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

const REPO = process.env.GITHUB_REPO || 'GonzoDuke/carnegie';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const VOCAB_PATH = 'lib/tag-vocabulary.json';
const CHANGELOG_PATH = 'lib/vocabulary-changelog.md';
// The placeholder marker the changelog ships with — new entries get inserted
// just above it so the auto-append note stays at the bottom.
const TRAILING_COMMENT =
  '<!-- New entries will be appended below automatically by the approve command -->';

interface CommitBody {
  vocabularyJson: string;
  changelogEntries: string;
  newTagCount: number;
  /**
   * Optional override for the commit message. Lets non-promotion edits
   * (manual add from the Vocabulary screen, tag deletion) describe
   * themselves accurately instead of being labeled "promote N new tags".
   */
  commitMessage?: string;
}

interface GhFile {
  content?: string; // base64 (only when getting a file by path)
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
      'User-Agent': 'carnegie-vocabulary-bot',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub ${init?.method ?? 'GET'} ${path}: ${res.status} ${text.slice(0, 300)}`
    );
  }
  return res;
}

async function getFile(path: string): Promise<GhFile> {
  const r = await ghFetch(
    `/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`
  );
  return (await r.json()) as GhFile;
}

async function putFile(
  path: string,
  content: string,
  sha: string,
  message: string
): Promise<GhCommitResponse> {
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
    branch: BRANCH,
  };
  const r = await ghFetch(`/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return (await r.json()) as GhCommitResponse;
}

// Lightweight availability probe so the client can render the right button.
// Returns 200 with `{ available: false }` rather than 501 — easier on fetch.
export async function GET() {
  return NextResponse.json({
    available: !!process.env.GITHUB_TOKEN,
    repo: REPO,
    branch: BRANCH,
  });
}

export async function POST(req: NextRequest) {
  if (!process.env.GITHUB_TOKEN) {
    // Client should fall back to the manual download workflow on 501.
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

  if (
    typeof body.vocabularyJson !== 'string' ||
    typeof body.changelogEntries !== 'string' ||
    typeof body.newTagCount !== 'number' ||
    !Number.isFinite(body.newTagCount) ||
    body.newTagCount < 0
  ) {
    return NextResponse.json({ error: 'Bad body shape' }, { status: 400 });
  }
  if (!body.vocabularyJson.trim() || !body.changelogEntries.trim()) {
    return NextResponse.json({ error: 'Empty payload' }, { status: 400 });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const tagWord = body.newTagCount === 1 ? 'tag' : 'tags';
  const baseMessage =
    typeof body.commitMessage === 'string' && body.commitMessage.trim()
      ? `${body.commitMessage.trim()} (${dateStr})`
      : `Vocabulary: promote ${body.newTagCount} new ${tagWord} (${dateStr})`;

  try {
    // 1) Replace tag-vocabulary.json with the client-built version.
    const vocabFile = await getFile(VOCAB_PATH);
    const vocabResult = await putFile(
      VOCAB_PATH,
      body.vocabularyJson,
      vocabFile.sha,
      `${baseMessage} — vocabulary`
    );

    // 2) Append the changelog entries to the existing file. We slot them in
    // above the trailing comment marker when present so the bot-appended
    // note stays at the foot of the document.
    const changelogFile = await getFile(CHANGELOG_PATH);
    const currentChangelog = changelogFile.content
      ? Buffer.from(changelogFile.content, 'base64').toString('utf8')
      : '';

    const newEntries = body.changelogEntries.trim();
    let updatedChangelog: string;
    if (currentChangelog.includes(TRAILING_COMMENT)) {
      updatedChangelog = currentChangelog.replace(
        TRAILING_COMMENT,
        `${newEntries}\n\n${TRAILING_COMMENT}`
      );
    } else {
      updatedChangelog = currentChangelog.trimEnd() + '\n\n' + newEntries + '\n';
    }

    const changelogResult = await putFile(
      CHANGELOG_PATH,
      updatedChangelog,
      changelogFile.sha,
      `${baseMessage} — changelog`
    );

    return NextResponse.json({
      ok: true,
      newTagCount: body.newTagCount,
      commits: [
        {
          path: VOCAB_PATH,
          sha: vocabResult.commit?.sha,
          url: vocabResult.commit?.html_url,
        },
        {
          path: CHANGELOG_PATH,
          sha: changelogResult.commit?.sha,
          url: changelogResult.commit?.html_url,
        },
      ],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[commit-vocabulary] failed:', message);
    return NextResponse.json(
      { error: 'GitHub API error', details: message },
      { status: 502 }
    );
  }
}
