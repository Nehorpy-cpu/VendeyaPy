/**
 * entitlements/ai.ts — Scaffold de gating + metering de IA (Fase 5A)
 * =================================================================
 * Prepara los gates y contadores para cuando exista el cerebro IA real. NO conecta
 * OpenAI todavía: solo valida la feature `aiAssistant`, la cuota `aiTokens` y registra
 * tokens/costo. El motor IA (futuro) llamará `assertAiBudget` antes y `recordAiUsage` después.
 */
import { assertFeatureEnabled, assertWithinLimit, meterAiUsage } from './entitlements.js';

/** Valida que el tenant puede usar IA y le alcanza el presupuesto de tokens estimado. */
export async function assertAiBudget(tenantId: string, estimatedTokens: number, actorUid?: string | null): Promise<void> {
  await assertFeatureEnabled(tenantId, 'aiAssistant', { actorUid });
  await assertWithinLimit(tenantId, 'aiTokens', { delta: Math.max(0, Math.ceil(estimatedTokens)), actorUid });
}

/** Registra el consumo real de IA (tokens + costo estimado en USD). */
export async function recordAiUsage(tenantId: string, tokens: number, costUsd: number): Promise<void> {
  await meterAiUsage(tenantId, Math.max(0, Math.ceil(tokens)), Math.max(0, costUsd));
}
