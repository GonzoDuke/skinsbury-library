import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { withAnthropicRetry } from '@/lib/anthropic-retry';

export const runtime = 'nodejs';
export const maxDuration = 30;

const PROMPT = `You are a Library of Congress cataloger. Given a book's title and author, return the canonical Library of Congress Classification (LCC) call number for that work.

Output rules:
- Return canonical LCC format with a single space before the cutter and (when applicable) before the date. Examples:
    "PR2807 .H32 1996"
    "BL53 .J36 2012"
    "QA76.73 .P98 2024"
    "CT275 .H62575 A3 2010"
- ONLY return an LCC when you are reasonably sure. For obscure or self-published books, or when you can't confidently identify the work, return an empty string.
- Confidence:
    HIGH   = canonical, well-known work; you're certain of the class letters and number
    MEDIUM = you know the LC class letters and rough number but the cutter or date is a guess
    LOW    = guessing — return empty lcc instead, with confidence LOW and a note

Reply with ONLY a JSON object (no fences, no prose):
{"lcc": "...", "confidence": "HIGH|MEDIUM|LOW", "reasoning": "<one short sentence>"}`;

interface Body {
  title?: string;
  author?: string;
  publisher?: string;
  publicationYear?: number;
}

function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in response');
  return JSON.parse(t.slice(start, end + 1));
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const title = (body.title ?? '').trim();
  const author = (body.author ?? '').trim();
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const userMsg = `Title: ${title}
Author: ${author || '(unknown)'}
Publisher: ${body.publisher ?? ''}
Publication year: ${body.publicationYear ?? ''}`;

  const client = new Anthropic({ apiKey });
  const t0 = Date.now();

  try {
    const resp = await withAnthropicRetry(
      () =>
        client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          system: PROMPT,
          messages: [{ role: 'user', content: userMsg }],
        }),
      'infer-lcc'
    );
    const block = resp.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      return NextResponse.json({ error: 'Empty model response' }, { status: 502 });
    }
    let parsed: any;
    try {
      parsed = extractJsonObject(block.text);
    } catch {
      return NextResponse.json({ error: 'Could not parse JSON', text: block.text }, { status: 502 });
    }
    const result = {
      lcc: String(parsed.lcc ?? '').trim(),
      confidence:
        parsed.confidence === 'HIGH' || parsed.confidence === 'MEDIUM' || parsed.confidence === 'LOW'
          ? parsed.confidence
          : 'LOW',
      reasoning: String(parsed.reasoning ?? ''),
    };
    console.log(
      `[infer-lcc] "${title}" / "${author}" → ${result.lcc || '∅'} (${result.confidence}, ${Date.now() - t0}ms)`
    );
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Inference error', details: err?.message ?? String(err) },
      { status: 502 }
    );
  }
}
