import { describe, it, expect } from 'vitest';
import { estimateCostUsd, HAIKU_INPUT_USD_PER_MTOK, HAIKU_OUTPUT_USD_PER_MTOK, AI_MODEL } from './pricing.js';

describe('ai/pricing', () => {
  it('usa el modelo Haiku', () => {
    expect(AI_MODEL).toBe('claude-haiku-4-5');
  });

  it('calcula costo por 1M tokens de entrada/salida', () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(HAIKU_INPUT_USD_PER_MTOK, 6);
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(HAIKU_OUTPUT_USD_PER_MTOK, 6);
  });

  it('suma entrada + salida', () => {
    // 500k in + 200k out = 0.5*1 + 0.2*5 = 1.5
    expect(estimateCostUsd({ inputTokens: 500_000, outputTokens: 200_000 })).toBeCloseTo(1.5, 6);
  });

  it('no devuelve negativos', () => {
    expect(estimateCostUsd({ inputTokens: -10, outputTokens: -10 })).toBe(0);
  });
});
