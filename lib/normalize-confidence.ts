/**
 * Normalize a confidence value parsed from a model response into the
 * canonical 'HIGH' | 'MEDIUM' | 'LOW' tri-state.
 *
 * The model is instructed to return one of those three exact strings,
 * but in practice it sometimes drifts: lowercase ("high"), prefixed
 * ("Very High"), abbreviated ("med"). Prior code did a strict
 * three-way equality check and silently collapsed everything else to
 * 'LOW' — which corrupted the signal for anything downstream that
 * uses confidence as load-bearing input (retry decisions, "flag for
 * review" logic, etc.).
 *
 * This helper does case-insensitive matching against a small set of
 * known synonyms, then warns and defaults to 'LOW' for anything truly
 * unexpected so the drift becomes visible in the logs instead of silent.
 */
export function normalizeConfidence(input: unknown): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (typeof input !== 'string') return 'LOW';
  const normalized = input.trim().toUpperCase();
  if (normalized === 'HIGH' || normalized === 'VERY HIGH') return 'HIGH';
  if (normalized === 'MEDIUM' || normalized === 'MED') return 'MEDIUM';
  if (normalized === 'LOW' || normalized === 'VERY LOW') return 'LOW';
  console.warn(
    `[normalize-confidence] unexpected confidence value: ${JSON.stringify(input)}, defaulting to LOW`
  );
  return 'LOW';
}
