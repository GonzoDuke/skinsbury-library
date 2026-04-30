import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const maxDuration = 60;

const DETECT_PROMPT = `Look at this photo of a bookshelf. Your ONLY job is to locate book spines — do NOT read titles or authors yet.

For each visible book spine, working left to right:
1. Output a bounding box in percentages of the image dimensions: x (left edge), y (top edge), width, height.
2. Coordinates are 0–100. (0,0) is the top-left of the image.
3. Include some padding around the spine so text near the edges is not cut off.

STRICT RULES:
- Only include actual book spines that are upright and clearly visible.
- Do NOT include: magazines, journals, newspapers, CDs, DVDs, records, or items lying flat / showing a cover instead of a spine. (Magazines often have a glossy finish, a cover image rather than text-only spine, and a date/issue number.)
- Do NOT include partially-visible spines where you can't see the full top-to-bottom extent.
- A single physical spine is ONE entry — even if the spine shows the author name and the title stacked vertically, that's one book, not two.
- Better to skip a borderline item than include something that isn't a book.

Return ONLY a JSON array (no prose, no markdown fences) of objects:
{ "position": <1-indexed integer>, "x": <number>, "y": <number>, "width": <number>, "height": <number>, "note": <optional string> }`;

interface BboxDetection {
  position: number;
  x: number;
  y: number;
  width: number;
  height: number;
  note?: string;
}

function extractJsonArray(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in model response');
  return JSON.parse(t.slice(start, end + 1));
}

function clampPct(n: unknown, fallback: number): number {
  const v = typeof n === 'number' ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, v));
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not set' },
      { status: 500 }
    );
  }

  let imageBase64: string;
  let mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

  try {
    const form = await req.formData();
    const file = form.get('image');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No image file provided' }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    imageBase64 = buf.toString('base64');

    const type = (file.type || '').toLowerCase();
    if (type === 'image/png') mediaType = 'image/png';
    else if (type === 'image/webp') mediaType = 'image/webp';
    else if (type === 'image/gif') mediaType = 'image/gif';
    else mediaType = 'image/jpeg';
  } catch (err) {
    return NextResponse.json(
      { error: 'Invalid form data', details: String(err) },
      { status: 400 }
    );
  }

  const client = new Anthropic({ apiKey });

  try {
    const t0 = Date.now();
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: imageBase64 },
            },
            { type: 'text', text: DETECT_PROMPT },
          ],
        },
      ],
    });

    const textBlock = resp.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return NextResponse.json({ error: 'Empty model response' }, { status: 502 });
    }

    let raw: unknown;
    try {
      raw = extractJsonArray(textBlock.text);
    } catch (err) {
      return NextResponse.json(
        { error: 'Could not parse JSON from model', text: textBlock.text },
        { status: 502 }
      );
    }
    if (!Array.isArray(raw)) {
      return NextResponse.json(
        { error: 'Model did not return an array' },
        { status: 502 }
      );
    }

    const detections: BboxDetection[] = raw
      .map((r: any, i: number): BboxDetection => ({
        position: Number.isFinite(r.position) ? Number(r.position) : i + 1,
        x: clampPct(r.x, 0),
        y: clampPct(r.y, 0),
        width: clampPct(r.width, 0),
        height: clampPct(r.height, 100),
        note: r.note ? String(r.note) : undefined,
      }))
      .filter((d) => d.width > 0 && d.height > 0);

    console.log(`[process-photo] detected ${detections.length} spines (${Date.now() - t0}ms)`);
    return NextResponse.json({ detections });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Vision API error', details: err?.message ?? String(err) },
      { status: 502 }
    );
  }
}
