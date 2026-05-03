import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { withAnthropicRetry } from '@/lib/anthropic-retry';

export const runtime = 'nodejs';
export const maxDuration = 60;

const READ_PROMPT = `This image is a tightly-cropped photo of a SINGLE book spine. Read it.

Extract:
- title: the title as printed on the spine
- author: the author as printed on the spine (people's names; for editors of anthologies, prefix with "ed. ")
- publisher: the publisher logo or text if visible at the foot of the spine
- lcc: the Library of Congress Classification call number, ONLY if a real LCC is printed or stickered on this physical spine. See LCC RULES below.
- confidence: HIGH if both title and author are clearly legible; MEDIUM if one is partly obscured; LOW if you are guessing

STRICT RULES:
- If text is rotated 90° (vertical), still read it left-to-right.
- If you cannot read the title OR author, return empty strings for both and set confidence=LOW with a note describing the spine's appearance (color, what little text you can see).
- Do NOT invent text. If you can only see part of a word, leave it empty and note it.
- The author and title may be stacked on the same spine. Both belong to ONE book.
- Author names: return as printed (e.g., "Albert Camus", not "Camus, Albert").

LCC RULES (very strict):
- Return an LCC ONLY if it is actually printed, stamped, or applied as a library classification sticker on this physical spine. Common on ex-library copies, university press editions, and older Modern Library hardbacks. Most modern paperbacks have NONE — return empty string in that case.
- Always return in canonical single-line format. The model is responsible for normalizing whatever you see on the spine.
  - Class letters (1–3 uppercase): e.g., PR, BL, QA, PS, BJ, CT, HM
  - Followed immediately by the class number, no spaces: PR2807, BJ1031, QA76.73
  - Cutter number(s): preceded by a single space and a period, e.g., " .H3", " .M387", " .L33"
  - Optional date or volume marker: separated by a single space, e.g., " 1990", " 2010"
  - If the spine shows the parts on separate lines or with extra spacing (PR / 2807 / .H3 / 1990), JOIN them into the canonical single-line form below.
- Examples of correctly-normalized output:
  - "PR2807 .H3 1990"
  - "BJ1031 .H37 2010"
  - "QA76.73 .P98 K39 2024"
  - "PS3525 .I5156 D4 1998"
- If you cannot confidently identify EVERY component (class letters AND number AND cutter), return an empty string. Do NOT return partial LCCs. Do NOT guess the cutter from the author's name — capture only what is actually printed.
- Do NOT confuse LCC with: ISBN (13 digits, often with barcodes); publisher series numbers like "70" on Modern Library spines; Dewey Decimal numbers (these are ALL-NUMERIC, e.g., 822.33). LCC ALWAYS starts with one to three uppercase letters.

Return ONLY a JSON object (no prose, no fences):
{"title": "...", "author": "...", "publisher": "...", "lcc": "...", "confidence": "HIGH|MEDIUM|LOW", "note": "..."}`;

interface ReadResponse {
  title: string;
  author: string;
  publisher: string;
  lcc: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  note?: string;
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

  let body: {
    imageBase64?: string;
    mediaType?: string;
    position?: number;
    /** Override the model. Defaults to Opus (back-compat). */
    model?: 'sonnet' | 'opus';
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.imageBase64) {
    return NextResponse.json({ error: 'imageBase64 is required' }, { status: 400 });
  }

  // Strip a `data:image/...;base64,` prefix if present.
  const base64 = body.imageBase64.replace(/^data:[^;]+;base64,/, '');

  const t = (body.mediaType ?? 'image/jpeg').toLowerCase();
  const mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' =
    t === 'image/png'
      ? 'image/png'
      : t === 'image/webp'
        ? 'image/webp'
        : t === 'image/gif'
          ? 'image/gif'
          : 'image/jpeg';

  const client = new Anthropic({ apiKey });

  // Default Opus; orchestrator can route to Sonnet for visually easy spines.
  const modelId =
    body.model === 'sonnet' ? 'claude-sonnet-4-20250514' : 'claude-opus-4-7';

  try {
    const t0 = Date.now();
    const resp = await withAnthropicRetry(
      () =>
        client.messages.create({
          model: modelId,
          max_tokens: 512,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: base64 },
                },
                { type: 'text', text: READ_PROMPT },
              ],
            },
          ],
        }),
      'read-spine'
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

    const result: ReadResponse = {
      title: String(parsed.title ?? '').trim(),
      author: String(parsed.author ?? '').trim(),
      publisher: String(parsed.publisher ?? '').trim(),
      lcc: String(parsed.lcc ?? '').trim(),
      confidence:
        parsed.confidence === 'HIGH' || parsed.confidence === 'MEDIUM' || parsed.confidence === 'LOW'
          ? parsed.confidence
          : 'LOW',
      note: parsed.note ? String(parsed.note) : undefined,
    };

    console.log(
      `[read-spine ${body.model ?? 'opus'}] #${body.position ?? '?'} → "${result.title}" / "${result.author}"${result.lcc ? ` lcc=${result.lcc}` : ''} (${result.confidence}, ${Date.now() - t0}ms)`
    );

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Vision API error', details: err?.message ?? String(err) },
      { status: 502 }
    );
  }
}
