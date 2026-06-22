/**
 * ai/audit.ts — Auditoría del AI Gateway (AG-1)
 * =============================================
 * Escribe SOLO metadatos en tenants/{t}/aiRequests/{id}: contexto, status, tokens, costo,
 * latencia, herramientas, código de error. NUNCA guarda el system prompt, los mensajes, PII
 * ni la API key. Best-effort: si la escritura falla, no rompe la respuesta del gateway.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import type { AiAuditRecord } from './types.js';

/** Código de error SEGURO (status HTTP o nombre de clase), nunca el cuerpo del error. */
export function safeErrorCode(e: unknown): string {
  const err = e as { status?: number; name?: string } | null;
  if (err && typeof err.status === 'number') return `http_${err.status}`;
  if (err && typeof err.name === 'string' && err.name) return err.name;
  return 'unknown';
}

/** Persiste un registro de auditoría (best-effort; no lanza). */
export async function writeAiRequest(record: AiAuditRecord): Promise<void> {
  try {
    await db().collection(`tenants/${record.tenantId}/aiRequests`).add({
      context: record.context,
      model: record.model,
      status: record.status,
      latencyMs: record.latencyMs,
      inputTokens: record.inputTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      costUsd: record.costUsd ?? null,
      toolNames: record.toolNames ?? [],
      errorCode: record.errorCode ?? null,
      createdAt: Timestamp.now(),
    });
  } catch {
    // La auditoría nunca debe romper el flujo del gateway. No exponemos el contenido.
    logger.warn('aiRequests: no se pudo escribir la auditoría', { tenantId: record.tenantId, status: record.status });
  }
}
