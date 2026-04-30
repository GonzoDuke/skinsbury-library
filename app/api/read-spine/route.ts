import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const maxDuration = 60;

const READ_PROMPT = `This image is a tightly-cropped photo of a SINGLE book spine. Read it.

Extract:
- title: the title as printed on the spine
- author: the author as printed on the spine (people's names; for editors of anthologies, prefix with "ed. ")
- publisher: the publisher logo or text if visible at the foot of the spine
- confidence: HIGH if both title and author are clearly legible; MEDIUM if one is partly obscured; LOW if you are guessing

STRICT RULES:
- If text is rotated 90° (vertical), still read it left-to-right.
- If you cannot read the title OR author, return empty strings for both and set confidence=LOW with a note describing the spine's appearance (color, what little text you can see).
- Do NOT invent text. If you can only see part of a word, leave it empty and note it.
- The author and title may be stacked on the same spine. Both belong to ONE book.
- Author names: return as printed (e.g., "Albert Camus", not "Camus, Albert").

Return ONLY a JSON object (no prose, no fences):
{"title": "...", "author": "...", "publisher": "...", "confidence": "HIGH|MEDIUM|LOW", "note": "..."}`;

interface ReadResponse {
  title: string;
  author: string;
  publisher: string;
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

  let body: { imageBase64?: string; mediaType?: string; position?: number };
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

  try {
    const t0 = Date.now();
    const resp = await client.messages.create({
      model: 'claude-opus-4-7',
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
    });

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
      confidence:
        parsed.confidence === 'HIGH' || parsed.confidence === 'MEDIUM' || parsed.confidence === 'LOW'
          ? parsed.confidence
          : 'LOW',
      note: parsed.note ? String(parsed.note) : undefined,
    };

    console.log(
      `[read-spine] #${body.position ?? '?'} → "${result.title}" / "${result.author}" (${result.confidence}, ${Date.now() - t0}ms)`
    );

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Vision API error', details: err?.message ?? String(err) },
      { status: 502 }
    );
  }
}
