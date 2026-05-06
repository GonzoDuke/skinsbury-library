import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { withAnthropicRetry } from '@/lib/anthropic-retry';
import { normalizeConfidence } from '@/lib/normalize-confidence';
import { structuredErrorResponse } from '@/lib/api-error';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Last-resort identifier. Used when the spine OCR produced fragments
 * the title-search APIs couldn't match (garbled title, partial author,
 * subtitle-only text, etc.). Claude Sonnet's general knowledge can
 * often recognize a book from spine fragments — first edition Penguin
 * Classics imprint number, distinctive subtitle phrase, an unusual
 * author surname — that exact-match search engines fail on.
 *
 * Input: whatever raw text the spine read produced, plus the partial
 * title / author the OCR pass extracted (when those exist).
 * Output: a single proposed { title, author, isbn?, confidence }
 * for the pipeline to retry the lookup chain with.
 */
const IDENTIFY_PROMPT = `You are a librarian helping identify a single book from partial spine text. The spine OCR produced fragments — possibly garbled, partial, or ambiguous. Your job is to propose the most likely identification.

Return ONLY a single JSON object (no prose, no fences) with these fields:
{
  "title": "the most likely full title — your best guess based on the fragments",
  "author": "the most likely author in 'First Last' form (not 'Last, First')",
  "isbn": "ISBN-13 if you can recall a canonical printing's ISBN with confidence, else empty string",
  "confidence": "HIGH | MEDIUM | LOW",
  "reasoning": "one short sentence explaining what tipped your guess"
}

Rules:
- Return HIGH confidence ONLY when the fragments are distinctive enough that the answer is essentially unambiguous (e.g., "to kill a mocki" + "Lee" → To Kill a Mockingbird by Harper Lee).
- Return MEDIUM when there's a strong candidate but plausible alternatives exist.
- Return LOW when you're guessing — but still propose your best guess. The pipeline will retry the lookup chain with whatever you give and discard the result if it doesn't match.
- DO NOT invent ISBNs you aren't sure about. An empty isbn is fine — the pipeline can resolve one via the lookup chain from a correct title and author.
- If the fragments are too ambiguous to even guess, return empty title/author with confidence LOW and a reasoning sentence describing why.

Examples:

Spine fragments: "STRANG" / "CAMUS" / "VINTAGE"
→ {"title":"The Stranger","author":"Albert Camus","isbn":"","confidence":"HIGH","reasoning":"Vintage edition of Camus's novel — fragments uniquely match."}

Spine fragments: "AMERIC" / "PHILIP ROTH"
→ {"title":"American Pastoral","author":"Philip Roth","isbn":"","confidence":"MEDIUM","reasoning":"Roth has multiple titles starting with 'Americ' — American Pastoral is the most-printed; could also be The Plot Against America or The American."}

Spine fragments: "1984" / "ORWELL"
→ {"title":"1984","author":"George Orwell","isbn":"","confidence":"HIGH","reasoning":"Distinctive title + author — unambiguous."}`;

interface IdentifyRequest {
  /** The raw concatenated text the spine OCR captured. */
  rawText?: string;
  /** Whatever the OCR pass extracted as a title (often a fragment). */
  partialTitle?: string;
  /** Whatever the OCR pass extracted as an author. */
  partialAuthor?: string;
}

interface IdentifyResult {
  title: string;
  author: string;
  isbn: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
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

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  let body: IdentifyRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawText = (body.rawText ?? '').trim();
  const partialTitle = (body.partialTitle ?? '').trim();
  const partialAuthor = (body.partialAuthor ?? '').trim();

  if (!rawText && !partialTitle && !partialAuthor) {
    return NextResponse.json(
      { error: 'rawText, partialTitle, or partialAuthor is required' },
      { status: 400 }
    );
  }

  const userMessage = `Identify this book from these spine fragments:
- Raw OCR text: ${JSON.stringify(rawText) || '(none)'}
- Title fragment: ${JSON.stringify(partialTitle) || '(none)'}
- Author fragment: ${JSON.stringify(partialAuthor) || '(none)'}`;

  const client = new Anthropic({ apiKey });

  const requestShape = `identify-book: rawText="${rawText.slice(0, 60)}" partialTitle="${partialTitle}" partialAuthor="${partialAuthor}"`;
  const model = 'claude-sonnet-4-20250514';

  try {
    const t0 = Date.now();
    const resp = await withAnthropicRetry(
      () =>
        client.messages.create({
          model,
          max_tokens: 512,
          system: IDENTIFY_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      'identify-book'
    );

    const textBlock = resp.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return structuredErrorResponse(new Error('Empty model response'), {
        error: 'Empty model response',
        model,
        requestShape,
      });
    }

    let parsed: unknown;
    try {
      parsed = extractJsonObject(textBlock.text);
    } catch (err) {
      return structuredErrorResponse(err, {
        error: 'Could not parse JSON from model',
        model,
        requestShape,
      });
    }

    const p = parsed as Partial<IdentifyResult>;
    const result: IdentifyResult = {
      title: typeof p.title === 'string' ? p.title : '',
      author: typeof p.author === 'string' ? p.author : '',
      isbn: typeof p.isbn === 'string' ? p.isbn.replace(/[^\dxX]/g, '') : '',
      confidence: normalizeConfidence(p.confidence),
      reasoning: typeof p.reasoning === 'string' ? p.reasoning : '',
    };
    const ms = Date.now() - t0;
    console.log(
      `[identify-book] raw=${JSON.stringify(rawText.slice(0, 80))}` +
        ` → title=${JSON.stringify(result.title)}` +
        ` author=${JSON.stringify(result.author)}` +
        ` isbn=${result.isbn || '-'}` +
        ` conf=${result.confidence}` +
        ` (${ms}ms)`
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[identify-book] failed:', message);
    return structuredErrorResponse(err, {
      error: 'identify-book error',
      model,
      requestShape,
    });
  }
}
