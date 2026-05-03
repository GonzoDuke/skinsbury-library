import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { withAnthropicRetry } from '@/lib/anthropic-retry';

export const runtime = 'nodejs';
export const maxDuration = 60;

const DETECT_PROMPT = `Look at this photo of books. Your ONLY job is to locate book spines — do NOT read titles or authors yet.

A book spine is the narrow text-bearing edge of a book along its binding. Spines appear in two orientations:
- VERTICAL spines: books standing upright on a shelf. The spine runs top-to-bottom; text is usually rotated 90°.
- HORIZONTAL spines: books lying flat in a stack, with the spine facing the camera. The spine runs left-to-right; text reads horizontally.

Both orientations are valid. Detect EVERY visible spine, in either orientation.

For each visible spine, in natural reading order (left-to-right for shelves of upright books; top-to-bottom for stacks of books lying flat):
1. Output a bounding box in percentages of the image dimensions: x (left edge), y (top edge), width, height.
2. Coordinates are 0–100. (0,0) is the top-left of the image.
3. Include some padding around the spine so text near the edges is not cut off.

WHAT TO INCLUDE:
- The narrow text-bearing edge of any book — vertical or horizontal — where the title, author, and/or publisher imprint are visible. Spine text is typically plain typography on a relatively narrow rectangle.

WHAT TO EXCLUDE:
- Items showing their FRONT or BACK COVER instead of a spine. Covers usually have large cover art, photographs, big design elements, or a publisher logo dominating the face. If the face you can see is the cover, skip it.
- Magazines, journals, newspapers, CDs, DVDs, records. (Magazines tend to have glossy finish, cover imagery rather than text-only spine, and a date or issue number.)
- Partially-visible spines where one end is cut off so you can't see the full extent of the spine in its long direction (full top-to-bottom for vertical; full left-to-right for horizontal).
- Anything where you cannot tell whether you're looking at a spine or a cover — when in doubt, skip.

OTHER RULES:
- A single physical spine is ONE entry — even if the spine shows the author name and the title separated, that's one book, not two.
- Better to skip a borderline item than include something that isn't a book.
- The "position" field is the 1-indexed reading-order rank.

Return ONLY a JSON array (no prose, no markdown fences) of objects:
{ "position": <1-indexed integer>, "x": <number>, "y": <number>, "width": <number>, "height": <number>, "orientation": "vertical" | "horizontal", "note": <optional string> }`;

interface BboxDetection {
  position: number;
  x: number;
  y: number;
  width: number;
  height: number;
  orientation?: 'vertical' | 'horizontal';
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
    const resp = await withAnthropicRetry(
      () =>
        client.messages.create({
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
        }),
      'process-photo'
    );

    const textBlock = resp.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      console.warn('[process-photo] empty model response', JSON.stringify(resp.content));
      return NextResponse.json(
        { error: 'Empty model response', rawContent: resp.content },
        { status: 502 }
      );
    }

    const rawText = textBlock.text;

    let raw: unknown;
    try {
      raw = extractJsonArray(rawText);
    } catch (err) {
      console.warn('[process-photo] JSON parse failed. raw text:\n' + rawText);
      return NextResponse.json(
        { error: 'Could not parse JSON from model', rawText },
        { status: 502 }
      );
    }
    if (!Array.isArray(raw)) {
      console.warn('[process-photo] non-array. raw text:\n' + rawText);
      return NextResponse.json(
        { error: 'Model did not return an array', rawText },
        { status: 502 }
      );
    }

    const detections: BboxDetection[] = raw
      .map((r: any, i: number): BboxDetection => {
        const w = clampPct(r.width, 0);
        const h = clampPct(r.height, 100);
        const declared =
          r.orientation === 'horizontal' || r.orientation === 'vertical'
            ? r.orientation
            : undefined;
        return {
          position: Number.isFinite(r.position) ? Number(r.position) : i + 1,
          x: clampPct(r.x, 0),
          y: clampPct(r.y, 0),
          width: w,
          height: h,
          // Fall back to bbox shape when the model omits orientation:
          // wider-than-tall reads as horizontal, taller-than-wide as vertical.
          orientation: declared ?? (w > h ? 'horizontal' : 'vertical'),
          note: r.note ? String(r.note) : undefined,
        };
      })
      .filter((d) => d.width > 0 && d.height > 0);

    if (detections.length === 0) {
      console.warn('[process-photo] zero detections. raw text:\n' + rawText);
    } else {
      console.log(`[process-photo] detected ${detections.length} spines (${Date.now() - t0}ms)`);
    }
    return NextResponse.json({ detections, rawText });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Vision API error', details: err?.message ?? String(err) },
      { status: 502 }
    );
  }
}
