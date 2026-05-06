import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import type { InferTagsResult } from '@/lib/types';
import type { CorrectionEntry } from '@/lib/corrections-log';
import { withAnthropicRetry } from '@/lib/anthropic-retry';
import { VOCAB, type DomainKey } from '@/lib/tag-domains';
import { normalizeConfidence } from '@/lib/normalize-confidence';
import { structuredErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_CORRECTIONS_IN_PROMPT = 20;
const MAX_DOMAINS_PER_BOOK = 3;

// ---------------------------------------------------------------------------
// Prompt loading. Two prompts now: one for call 1 (domain detection)
// and one for call 2 (focused tag inference, parameterized per domain).
// Each is loaded once per warm function instance.
// ---------------------------------------------------------------------------

let cachedDomainPrompt: string | null = null;
async function loadDomainPrompt(): Promise<string> {
  if (cachedDomainPrompt) return cachedDomainPrompt;
  const p = path.join(process.cwd(), 'lib', 'system-prompt-domain.md');
  cachedDomainPrompt = await fs.readFile(p, 'utf8');
  return cachedDomainPrompt;
}

let cachedTagsTemplate: string | null = null;
async function loadTagsTemplate(): Promise<string> {
  if (cachedTagsTemplate) return cachedTagsTemplate;
  const p = path.join(process.cwd(), 'lib', 'system-prompt-tags.md');
  cachedTagsTemplate = await fs.readFile(p, 'utf8');
  return cachedTagsTemplate;
}

// ---------------------------------------------------------------------------
// Vocabulary rendering for the call-2 prompt template. The {{domainVocabulary}}
// placeholder receives only the named domain's tag list; {{formVocabulary}}
// receives all form tags (domain-independent).
// ---------------------------------------------------------------------------

function renderDomainVocabulary(domain: DomainKey): string {
  const entry = VOCAB.domains[domain];
  if (!entry) return '(no vocabulary defined for this domain)';
  if (entry.tags.length === 0) {
    return `(no tags defined yet for ${entry.label} — propose new tags as needed with the [Proposed] prefix)`;
  }
  return `**${entry.label}** (LCC class letter: ${entry.lcc_letter || '—'})\nTags: ${entry.tags.join(', ') || '(none yet — propose new tags as needed with the [Proposed] prefix)'}`;
}

function renderFormVocabulary(): string {
  return [
    `**Content forms**: ${VOCAB.form_tags.content_forms.join(', ')}`,
    `**Series**: ${VOCAB.form_tags.series.join(', ')}`,
    `**Collectible**: ${VOCAB.form_tags.collectible.join(', ')}`,
  ].join('\n');
}

function renderTagsPrompt(domain: DomainKey): string {
  if (!cachedTagsTemplate) throw new Error('Tags prompt template not loaded');
  const domainName = VOCAB.domains[domain]?.label ?? domain;
  return cachedTagsTemplate
    .replace(/\{\{domainName\}\}/g, domainName)
    .replace(/\{\{domainVocabulary\}\}/g, renderDomainVocabulary(domain))
    .replace(/\{\{formVocabulary\}\}/g, renderFormVocabulary());
}

// ---------------------------------------------------------------------------
// Corrections few-shot. Now split between the two calls.
//   - Call 1 (domain detection) gets corrections with kind='domain'
//   - Call 2 (focused tag inference) gets corrections with kind='tag',
//     filtered to the current domain when possible.
// ---------------------------------------------------------------------------

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

function formatTagCorrection(c: CorrectionEntry): string {
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

function formatDomainCorrection(c: CorrectionEntry): string {
  const lcc = c.lcc ? c.lcc : 'unknown';
  if (c.removedTag) {
    return `CORRECTION: For "${c.title}" by ${c.author} (LCC: ${lcc}), the system inferred domain "${c.removedTag}" but the user removed it — be more cautious about that domain for similar books.`;
  }
  if (c.addedTag) {
    return `CORRECTION: For "${c.title}" by ${c.author} (LCC: ${lcc}), the user added domain "${c.addedTag}" — consider it for similar books.`;
  }
  return '';
}

function appendCorrections(
  basePrompt: string,
  corrections: CorrectionEntry[],
  formatter: (c: CorrectionEntry) => string
): string {
  if (corrections.length === 0) return basePrompt;
  const sorted = [...corrections]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, MAX_CORRECTIONS_IN_PROMPT);
  const lines = sorted.map(formatter).filter(Boolean);
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

// ---------------------------------------------------------------------------
// Request shape — now widened with the previously-missing fields the audit
// flagged (subtitle, allAuthors, edition, series, binding, language,
// pageCount). All optional; the user-message builder omits empty lines.
// ---------------------------------------------------------------------------

interface InferRequest {
  title?: string;
  author?: string;
  /** Subtitle — disambiguates ambiguous titles. Audit-fix field. */
  subtitle?: string;
  /** Full author list — multi-author books pass all here. Audit-fix field. */
  allAuthors?: string[];
  isbn?: string;
  publisher?: string;
  publicationYear?: number;
  /** Edition statement (audit-fix). Drives "First edition" / "Annotated" form tags. */
  edition?: string;
  /** Publisher series (audit-fix). Drives "Penguin Classics" etc. form tags. */
  series?: string;
  /** Binding type (audit-fix). Less load-bearing but cheap. */
  binding?: string;
  /** Language code or name (audit-fix). Matters for non-English tagging. */
  language?: string;
  /** Page count (audit-fix). Helps "Anthology" vs single-work disambiguation. */
  pageCount?: number;
  lcc?: string;
  existingGenreTags?: string[];
  subjectHeadings?: string[];
  ddc?: string;
  /** LCC class letter derived from DDC via the static crosswalk. */
  lccDerivedFromDdc?: string;
  /** LCC class letter derived from the user's own ledger. */
  lccDerivedFromAuthorPattern?: string;
  lcshSubjects?: string[];
  /** MARC field 655 (Index Term — Genre/Form). */
  marcGenreTerms?: string[];
  /** Spine-extracted publisher series. */
  extractedSeries?: string;
  /** Top tags from other books by this author in the user's ledger. */
  authorPatternTags?: string[];
  /** Sample size for the author-pattern result. */
  authorPatternSampleSize?: number;
  synopsis?: string;
  /** Recent corrections forwarded by the client. The route splits these
   *  by `kind` internally — domain corrections feed call 1, tag
   *  corrections feed call 2 (filtered to the per-call domain when
   *  possible). */
  corrections?: CorrectionEntry[];
}

// ---------------------------------------------------------------------------
// User-message builder. Shared between call 1 (domain) and call 2 (tags) —
// both calls receive the SAME book metadata, just with different system
// prompts. This is also where the audit-flagged previously-missing fields
// land in the prompt.
// ---------------------------------------------------------------------------

function buildUserMessage(body: InferRequest, mode: 'domain' | 'tags', domainName?: string): string {
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
  // Audit-fix: subtitle, allAuthors, edition, series, binding, language,
  // pageCount were on BookRecord but never reached the prompt.
  if (body.subtitle) lines.push(`- Subtitle: ${body.subtitle}`);
  if (Array.isArray(body.allAuthors) && body.allAuthors.length > 1) {
    lines.push(`- All authors: ${body.allAuthors.join('; ')}`);
  }
  if (body.edition) lines.push(`- Edition: ${body.edition}`);
  if (body.series) lines.push(`- Series: ${body.series}`);
  if (body.binding) lines.push(`- Binding: ${body.binding}`);
  if (body.language) lines.push(`- Language: ${body.language}`);
  if (typeof body.pageCount === 'number' && body.pageCount > 0) {
    lines.push(`- Page count: ${body.pageCount}`);
  }
  if (body.ddc) lines.push(`- DDC: ${body.ddc}`);
  if (body.lccDerivedFromDdc && !body.lcc) {
    lines.push(`- LCC class letter (derived from DDC, class-letter only): ${body.lccDerivedFromDdc}`);
  }
  if (body.lccDerivedFromAuthorPattern && !body.lcc && !body.lccDerivedFromDdc) {
    lines.push(`- LCC class letter (derived from author's other books in your library): ${body.lccDerivedFromAuthorPattern}`);
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
  if (
    Array.isArray(body.authorPatternTags) &&
    body.authorPatternTags.length > 0 &&
    typeof body.authorPatternSampleSize === 'number' &&
    body.authorPatternSampleSize >= 3
  ) {
    lines.push(
      `- Tags frequently applied to other books by this author in the user's library (sample of ${body.authorPatternSampleSize}): ${body.authorPatternTags.join(', ')}`
    );
  }
  if (body.synopsis) {
    const trimmed = body.synopsis.length > 300 ? body.synopsis.slice(0, 300) : body.synopsis;
    lines.push(`- Synopsis (first 300 chars): ${trimmed}`);
  }

  if (mode === 'domain') {
    return `Identify the primary domain (or domains) of the following book according to the rules in the system prompt. Return ONLY a single JSON object as specified.\n\nBook metadata:\n${lines.join('\n')}`;
  }
  // mode === 'tags'
  return `Tag the following book according to the rules in the system prompt. The domain is **${domainName}** — propose only tags within that domain (or [Proposed]-prefixed) plus form tags. Return ONLY a single JSON object as specified.\n\nBook metadata:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Domain validation. Accept only known domain keys so a stray model
// hallucination can't slip through. Cap at MAX_DOMAINS_PER_BOOK.
// ---------------------------------------------------------------------------

const VALID_DOMAINS: ReadonlySet<DomainKey> = new Set(
  Object.keys(VOCAB.domains) as DomainKey[]
);

interface DomainPick {
  domain: DomainKey;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function parseDomainResponse(parsed: unknown): { domains: DomainPick[]; reasoning: string } {
  const out: DomainPick[] = [];
  let reasoning = '';
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { domains?: unknown; reasoning?: unknown };
    if (typeof p.reasoning === 'string') reasoning = p.reasoning;
    if (Array.isArray(p.domains)) {
      for (const d of p.domains) {
        if (!d || typeof d !== 'object') continue;
        const dd = d as { domain?: unknown; confidence?: unknown };
        const domain = typeof dd.domain === 'string' ? (dd.domain.toLowerCase() as DomainKey) : null;
        if (!domain || !VALID_DOMAINS.has(domain)) continue;
        const confidence = normalizeConfidence(dd.confidence);
        out.push({ domain, confidence });
        if (out.length >= MAX_DOMAINS_PER_BOOK) break;
      }
    }
  }
  return { domains: out, reasoning };
}

// ---------------------------------------------------------------------------
// Per-domain focused tag call. Returns the parsed result as-is (caller
// merges across domains).
// ---------------------------------------------------------------------------

interface TagCallResult {
  genreTags: string[];
  formTags: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
}

async function runTagCallForDomain(
  client: Anthropic,
  body: InferRequest,
  domain: DomainKey,
  tagCorrections: CorrectionEntry[]
): Promise<TagCallResult | null> {
  const baseSystem = renderTagsPrompt(domain);
  const domainScopedCorrections = tagCorrections.filter(
    (c) => !c.domain || c.domain === domain
  );
  const system = appendCorrections(baseSystem, domainScopedCorrections, formatTagCorrection);
  const userMessage = buildUserMessage(body, 'tags', VOCAB.domains[domain]?.label ?? domain);
  const resp = await withAnthropicRetry(
    () =>
      client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    `infer-tags:${domain}`
  );
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return null;
  let parsed: any;
  try {
    parsed = extractJsonObject(textBlock.text);
  } catch {
    return null;
  }
  return {
    genreTags: Array.isArray(parsed.genre_tags) ? parsed.genre_tags.map(String) : [],
    formTags: Array.isArray(parsed.form_tags) ? parsed.form_tags.map(String) : [],
    confidence: normalizeConfidence(parsed.confidence),
    reasoning: String(parsed.reasoning ?? ''),
  };
}

// ---------------------------------------------------------------------------
// POST handler — orchestrates the two-call flow.
//   1. Domain detection (one Sonnet call). Capped at 3 domains.
//   2. For each identified domain, run focused tag inference IN PARALLEL.
//   3. Merge genre+form tags across domains, dedupe, return.
// ---------------------------------------------------------------------------

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

  const corrections = Array.isArray(body.corrections)
    ? body.corrections.filter(isCorrectionEntry)
    : [];
  const domainCorrections = corrections.filter((c) => c.kind === 'domain');
  const tagCorrections = corrections.filter((c) => (c.kind ?? 'tag') === 'tag');

  const client = new Anthropic({ apiKey });

  // Pre-load both prompts so the per-domain calls below can render
  // synchronously without racing.
  const [domainBase] = await Promise.all([loadDomainPrompt(), loadTagsTemplate()]);
  const domainSystem = appendCorrections(domainBase, domainCorrections, formatDomainCorrection);

  // ---------------- Call 1: domain detection ----------------
  let domainPicks: DomainPick[] = [];
  let domainReasoning = '';
  try {
    const userMessage = buildUserMessage(body, 'domain');
    const resp = await withAnthropicRetry(
      () =>
        client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 512,
          system: domainSystem,
          messages: [{ role: 'user', content: userMessage }],
        }),
      'infer-domain'
    );
    const textBlock = resp.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      let parsed: unknown;
      try {
        parsed = extractJsonObject(textBlock.text);
      } catch {
        parsed = null;
      }
      const result = parseDomainResponse(parsed);
      domainPicks = result.domains;
      domainReasoning = result.reasoning;
    }
  } catch (err: any) {
    return structuredErrorResponse(err, {
      error: 'Domain inference error',
      model: 'claude-sonnet-4-20250514',
      requestShape: `infer-tags (domain): title="${body.title ?? ''}" lcc="${body.lcc ?? ''}"`,
    });
  }

  // No domain returned → empty result with LOW domain confidence so the
  // caller can flag it. Don't run call 2 — there's no domain to focus on.
  if (domainPicks.length === 0) {
    const result: InferTagsResult = {
      genreTags: [],
      formTags: [],
      confidence: 'LOW',
      reasoning: domainReasoning || 'Domain inference returned no usable domains.',
      inferredDomains: [],
      domainConfidence: 'low',
    };
    return NextResponse.json(result);
  }

  // ---------------- Call 2: per-domain focused tag inference (parallel) ----------------
  const tagResults = await Promise.all(
    domainPicks.map((pick) =>
      runTagCallForDomain(client, body, pick.domain, tagCorrections).catch(() => null)
    )
  );

  // Merge across all domain calls. Genre tags + form tags get deduped
  // (case-sensitive — vocabulary tags ARE case-sensitive). Confidence
  // is the WORST of any successful call's reported confidence; LOW
  // beats MEDIUM beats HIGH.
  const order = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  const seenGenre = new Set<string>();
  const seenForm = new Set<string>();
  const mergedGenre: string[] = [];
  const mergedForm: string[] = [];
  let mergedConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
  const reasoningLines: string[] = [];

  for (let i = 0; i < tagResults.length; i++) {
    const tr = tagResults[i];
    if (!tr) continue;
    for (const t of tr.genreTags) {
      if (!seenGenre.has(t)) {
        seenGenre.add(t);
        mergedGenre.push(t);
      }
    }
    for (const t of tr.formTags) {
      if (!seenForm.has(t)) {
        seenForm.add(t);
        mergedForm.push(t);
      }
    }
    if (order[tr.confidence] < order[mergedConfidence]) mergedConfidence = tr.confidence;
    if (tr.reasoning) {
      reasoningLines.push(`[${domainPicks[i].domain}] ${tr.reasoning}`);
    }
  }

  // Translate domain confidence: HIGH → 'high', etc.
  const primaryDomainConfidence = domainPicks[0].confidence;
  const domainConfidence: 'high' | 'medium' | 'low' =
    primaryDomainConfidence === 'HIGH'
      ? 'high'
      : primaryDomainConfidence === 'MEDIUM'
        ? 'medium'
        : 'low';

  // If no tag call succeeded, we still have domain output — fall back
  // to LOW confidence and an empty tag set so the user can intervene.
  if (mergedGenre.length === 0 && mergedForm.length === 0) {
    mergedConfidence = 'LOW';
  }

  const result: InferTagsResult = {
    genreTags: mergedGenre,
    formTags: mergedForm,
    confidence: mergedConfidence,
    reasoning:
      reasoningLines.length > 0
        ? reasoningLines.join(' | ')
        : domainReasoning || 'Two-step inference returned no tag reasoning.',
    inferredDomains: domainPicks.map((p) => p.domain),
    domainConfidence,
  };

  return NextResponse.json(result);
}
