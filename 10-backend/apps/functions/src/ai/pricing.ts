/**
 * ai/pricing.ts — Costo aproximado de Claude Haiku (AG-1)
 * =======================================================
 * Pricing por constante (configurable acá; se puede mover a env/plan en una fase posterior).
 * Claude Haiku 4.5: $1.00 / 1M tokens de entrada, $5.00 / 1M de salida.
 */
import type { AiUsage } from './types.js';

// ID DATADO oficial (no el alias): es el snapshot probado con éxito en AI-SMOKE-REAL → determinista
// para producción. Mismo pricing que Haiku 4.5. Para experimentar otro modelo en el smoke: env ANTHROPIC_MODEL.
export const AI_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_MAX_TOKENS = 1024;

export const HAIKU_INPUT_USD_PER_MTOK = 1.0;
export const HAIKU_OUTPUT_USD_PER_MTOK = 5.0;

/** Costo aproximado en USD del uso de tokens (entrada + salida). */
export function estimateCostUsd(usage: AiUsage): number {
  const input = (Math.max(0, usage.inputTokens) / 1_000_000) * HAIKU_INPUT_USD_PER_MTOK;
  const output = (Math.max(0, usage.outputTokens) / 1_000_000) * HAIKU_OUTPUT_USD_PER_MTOK;
  return input + output;
}
