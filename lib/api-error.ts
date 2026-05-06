import { NextResponse } from 'next/server';

/**
 * Structured error response for /api routes.
 *
 * When an Anthropic call or external API call fails, the response
 * body should carry enough context for the next person debugging the
 * production trace to know:
 *   - error:        short error type, useful for log filtering
 *   - details:      the actual underlying error message
 *   - model:        the model identifier (when the route called one)
 *   - requestShape: a brief description of what was being requested
 *                   (e.g., 'spine read with 1 image', 'lookup-book
 *                   title="X" isbn="Y"'). Keep concise; no PII.
 *   - timestamp:    ISO timestamp of the failure
 *
 * The earlier temperature: 0 commit's 502 debugging took longer than
 * it should have because the response body was just `{ error, details }`
 * — the model name and request shape weren't surfaced. Adding them
 * once across every route makes future production debugging fast.
 */
export function structuredErrorResponse(
  err: unknown,
  context: {
    /** Short error type, e.g., 'Vision API error'. Defaults to 'Internal error'. */
    error?: string;
    /** Model identifier when the route called Anthropic. Leave undefined for routes that don't. */
    model?: string;
    /** Brief description of what the route was trying to do. Required. */
    requestShape: string;
    /** HTTP status. Defaults to 502 (the typical upstream-API-failure status). */
    status?: number;
  }
): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json(
    {
      error: context.error ?? 'Internal error',
      details: message,
      model: context.model,
      requestShape: context.requestShape,
      timestamp: new Date().toISOString(),
    },
    { status: context.status ?? 502 }
  );
}
