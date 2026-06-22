/**
 * ai/gateway.ts — AI Gateway: único punto que habla con Claude (AG-1, core)
 * ========================================================================
 * `runAgent` recibe el tenantId YA resuelto + system/messages/tools que arma el backend, llama al
 * cliente (real o fake), y devuelve { status, reply, usage, costUsd }. NUNCA lanza al caller: ante
 * falta de cliente (sin API key) → status 'disabled'; ante error del modelo → status 'error'. Así el
 * caller (AG-3) hace fallback al motor rule-based y el bot nunca queda mudo. Logging SEGURO: solo
 * metadatos (sin system/messages/PII/API key). AG-1 es infra: no se cablea a handleMessage todavía.
 */
import { logger } from '../lib/logger.js';
import { getAiClient } from './client.js';
import { writeAiRequest, safeErrorCode } from './audit.js';
import { AI_MODEL, DEFAULT_MAX_TOKENS, estimateCostUsd } from './pricing.js';
import type { RunAgentDeps, RunAgentInput, RunAgentResult } from './types.js';

const defaultDeps: RunAgentDeps = {
  getClient: getAiClient,
  writeAudit: writeAiRequest,
  now: () => Date.now(),
};

/**
 * Corre un turno del agente. tenantId ya resuelto por el backend (auth/webhook); el modelo no lee
 * Firestore directo. Devuelve siempre un resultado (status ok/error/disabled); no lanza.
 */
export async function runAgent(input: RunAgentInput, deps: RunAgentDeps = defaultDeps): Promise<RunAgentResult> {
  const t0 = deps.now();
  const model = AI_MODEL;

  const client = await deps.getClient();
  if (!client) {
    const latencyMs = deps.now() - t0;
    logger.info('AI gateway: disabled (sin cliente/API key)', { tenantId: input.tenantId, context: input.context });
    await deps.writeAudit({ tenantId: input.tenantId, context: input.context, model, status: 'disabled', latencyMs });
    return { status: 'disabled', model, latencyMs };
  }

  try {
    const res = await client.createMessage({
      model,
      system: input.system,
      messages: input.messages,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      tools: input.tools,
    });
    const latencyMs = deps.now() - t0;
    const costUsd = estimateCostUsd(res.usage);
    const toolNames = res.toolUses.map((t) => t.name);

    // Logging SEGURO: solo metadatos. Nunca el system/messages/PII.
    logger.info('AI gateway: ok', {
      tenantId: input.tenantId,
      context: input.context,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd,
      latencyMs,
      tools: toolNames.length,
    });
    await deps.writeAudit({
      tenantId: input.tenantId,
      context: input.context,
      model,
      status: 'ok',
      latencyMs,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd,
      toolNames,
    });

    return { status: 'ok', model, latencyMs, reply: res.text, usage: res.usage, costUsd, toolUses: res.toolUses };
  } catch (e) {
    const latencyMs = deps.now() - t0;
    const errorCode = safeErrorCode(e);
    // Logging SEGURO: NO pasamos el error crudo (su message/stack podría arrastrar contenido).
    logger.error('AI gateway: error del modelo', undefined, { tenantId: input.tenantId, context: input.context, errorCode, latencyMs });
    await deps.writeAudit({ tenantId: input.tenantId, context: input.context, model, status: 'error', latencyMs, errorCode });
    return { status: 'error', model, latencyMs, errorCode };
  }
}
