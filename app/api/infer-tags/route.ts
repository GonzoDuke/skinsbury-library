import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import type { InferTagsResult } from '@/lib/types';
import type { CorrectionEntry } from '@/lib/corrections-log';
import { withAnthropicRetry } from '@/lib/anthropic-retry';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_CORRECTIONS_IN_PROMPT = 20;

let cachedSystemPrompt: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  const p = path.join(process.cwd(), 'lib', 'system-prompt.md');
  cachedSystemPrompt = await fs.readFile(p, 'utf8');
  return cachedSystemPrompt;
}

function isCorrectionEntry(e: unknown): e is CorrectionEntry {
  if (!e || typeof e !== 'object') return false;
  const c = e as Partial<CorrectionEntry>;
  return (
    typeof c.title === 'string' &&
    typeof c.author === 'string' &&
    typeof c.lcc === 'string' &&
    Array.isArray(c.systemSuggestedTags) &&
    typeof c.timestamp === 'string' &&
    (typeof c.removedTag === 'string' || typeof c.addedTag === 'string')
  );
}

function formatCorrection(c: CorrectionEntry): string {
  const lcc = c.lcc ? c.lcc : 'unknown';
  const suggested =
    c.systemSuggestedTags.length > 0
      ? c.systemSuggestedTags.join(', ')
      : 'no tags';
  if (c.removedTag) {
    return `CORRECTION: For "${c.title}" by ${c.author} (LCC: ${lcc}), the system suggested [${suggested}] but the user removed "${c.removedTag}" — do not suggest this tag for similar books.`;
  }
  if (c.addedTag) {
    return `CORRECTION: For "${c.title}" by ${c.author} (LCC: ${lcc}), the system missed "${c.addedTag}" — suggest this tag for similar books.`;
  }
  return '';
}

function buildSystemWithCorrections(
  basePrompt: string,
  corrections: CorrectionEntry[]
): string {
  if (corrections.length === 0) return basePrompt;
  // Newest corrections first so the most recent editorial judgment
  // sits closest to the model's instructions.
  const sorted = [...corrections].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : -1
  );
  const limited = sorted.slice(0, MAX_CORRECTIONS_IN_PROMPT);
  const lines = limited.map(formatCorrection).filter(Boolean);
  if (lines.length === 0) return basePrompt;
  const block = [
    '',
    '## Recent corrections from the user',
    '',
    'Treat each line below as a few-shot example of editorial judgment to follow on similar books:',
    '',
    ...lines,
  ].join('\n');
  return basePrompt + '\n' + block;
}

function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model response');
  return JSON.parse(t.slice(start, end + 1));
}

interface InferRequest {
  title?: string;
  author?: string;
  isbn?: string;
  publisher?: string;
  publicationYear?: number;
  lcc?: string;
  existingGenreTags?: string[];
  subjectHeadings?: string[];
  // Phase-3 enrichment fields. All optional; the user-message
  // formatter omits the line when the field is empty/undefined so old
  // callers that don't pass them produce the same prompt as before.
  ddc?: string;
  /** LCC class letter derived from DDC via the static crosswalk. Passed
   *  only when `lcc` is missing — used as a domain anchor distinct from
   *  a sourced LCC. */
  lccDerivedFromDdc?: string;
  lcshSubjects?: string[];
  /** MARC field 655 (Index Term — Genre/Form) — cataloger-applied
   *  explicit genre vocabulary, e.g. "Detective and mystery fiction",
   *  "Bildungsromans", "Festschriften", "Cookbooks". Highest-priority
   *  signal for genre/form classification. */
  marcGenreTerms?: string[];
  /** Publisher-series indicator extracted directly from the spine
   *  ("Penguin Classics", "Library of America", "Folio Society"). The
   *  user actually saw it on the physical book — overrides the
   *  prompt's "only when publisher confirms" guard for the matching
   *  form tag. */
  extractedSeries?: string;
  synopsis?: string;
  /** Recent tag corrections forwarded by the client. Up to 20 most
   *  recent are appended to the system prompt as few-shot examples. */
  corrections?: CorrectionEntry[];
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  let body: InferRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const basePrompt = await loadSystemPrompt();
  const corrections = Array.isArray(body.corrections)
    ? body.corrections.filter(isCorrectionEntry)
    : [];
  const system = buildSystemWithCorrections(basePrompt, corrections);
  const client = new Anthropic({ apiKey });

  // Build the user message line-by-line so optional enrichment fields
  // are simply omitted (not rendered as empty lines) when the caller
  // didn't pass them. Old callers see the same prompt as before.
  const lines: string[] = [
    `- Title: ${body.title}`,
    `- Author: ${body.author ?? ''}`,
    `- ISBN: ${body.isbn ?? ''}`,
    `- Publisher: ${body.publisher ?? ''}`,
    `- Publication year: ${body.publicationYear ?? ''}`,
    `- LCC: ${body.lcc ?? ''}`,
    `- Subject headings: ${(body.subjectHeadings ?? []).join('; ')}`,
    `- Existing genre tags: ${(body.existingGenreTags ?? []).join('; ')}`,
  ];
  if (body.ddc) lines.push(`- DDC: ${body.ddc}`);
  // Only surface the derived LCC class letter when no authoritative LCC
  // was sourced — otherwise it'd be redundant and could confuse the
  // model into double-counting domain signal.
  if (body.lccDerivedFromDdc && !body.lcc) {
    lines.push(`- LCC class letter (derived from DDC, class-letter only): ${body.lccDerivedFromDdc}`);
  }
  if (Array.isArray(body.lcshSubjects) && body.lcshSubjects.length > 0) {
    lines.push(`- LCSH subject headings: ${body.lcshSubjects.join('; ')}`);
  }
  if (Array.isArray(body.marcGenreTerms) && body.marcGenreTerms.length > 0) {
    lines.push(`- MARC genre/form terms: ${body.marcGenreTerms.join('; ')}`);
  }
  if (body.extractedSeries) {
    lines.push(`- Spine-printed publisher series: ${body.extractedSeries}`);
  }
  if (body.synopsis) {
    const trimmed = body.synopsis.length > 300 ? body.synopsis.slice(0, 300) : body.synopsis;
    lines.push(`- Synopsis (first 300 chars): ${trimmed}`);
  }

  const userMessage = `Tag the following book according to the rules in the system prompt. Return ONLY a single JSON object (no markdown fences) with fields: title, author, isbn, publication_year, publisher, lcc, genre_tags (array of strings), form_tags (array of strings), confidence ("HIGH"|"MEDIUM"|"LOW"), reasoning (short string).

Book metadata:
${lines.join('\n')}`;

  try {
    const resp = await withAnthropicRetry(
      () =>
        client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system,
          messages: [{ role: 'user', content: userMessage }],
        }),
      'infer-tags'
    );

    const textBlock = resp.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return NextResponse.json({ error: 'Empty model response' }, { status: 502 });
    }

    let parsed: any;
    try {
      parsed = extractJsonObject(textBlock.text);
    } catch (err) {
      return NextResponse.json(
        { error: 'Could not parse JSON from model', text: textBlock.text },
        { status: 502 }
      );
    }

    const result: InferTagsResult = {
      genreTags: Array.isArray(parsed.genre_tags) ? parsed.genre_tags.map(String) : [],
      formTags: Array.isArray(parsed.form_tags) ? parsed.form_tags.map(String) : [],
      confidence:
        parsed.confidence === 'HIGH' ||
        parsed.confidence === 'MEDIUM' ||
        parsed.confidence === 'LOW'
          ? parsed.confidence
          : 'LOW',
      reasoning: String(parsed.reasoning ?? ''),
    };

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Tag inference error', details: err?.message ?? String(err) },
      { status: 502 }
    );
  }
}
