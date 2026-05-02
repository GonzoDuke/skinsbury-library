import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.text().catch(() => '');
  console.error('\n========== CLIENT ERROR ==========');
  console.error(body);
  console.error('==================================\n');
  return NextResponse.json({ ok: true });
}
