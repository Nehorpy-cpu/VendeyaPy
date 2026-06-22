/**
 * ai/gateway.ts — AI Gateway: único punto que habla con Claude (AG-1/AG-3)
 * =======================================================================
 * `runAgent` recibe el tenantId YA resuelto + system/messages/tools que arma el backend, corre el
 * loop de tool-use (ejecuta las tools server-side entre llamadas) y devuelve { status, reply, usage,
 * costUsd }. NUNCA lanza al caller: sin cliente (sin API key) → 'disabled'; error del modelo →
 * 'error'. Así el caller hace fallback al motor rule-based y el bot nunca queda mudo. Logging SEGURO:
 * solo metadatos (sin system/messages/PII/API key). El metering de entitlements lo hace el caller.
 */
import { logger } from '../lib/logger.js';
import { getAiClient } from './client.js';
import { writeAiRequest, safeErrorCode } from './audit.js';
import { AI_MODEL, DEFAULT_MAX_TOKENS, estimateCostUsd } from './pricing.js';
import type { AiContentBlock, AiMessage, RunAgentDeps, RunAgentInput, RunAgentResult } from './types.js';

const DEFAULT_MAX_TOOL_ITERS = 4;

const defaultDeps: RunAgentDeps = {
  getClient: getAiClient,
  writeAudit: writeAiRequest,
  now: () => Date.now(),
};

/**
 * Corre un turno del agente (con loop de tool-use). tenantId resuelto por el backend; el modelo no
 * lee Firestore directo (las tools corren server-side, tenant-scoped). Devuelve siempre un resultado.
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

  const maxIters = input.maxToolIters ?? DEFAULT_MAX_TOOL_ITERS;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const messages: AiMessage[] = [...input.messages];
  let inputTokens = 0;
  let outputTokens = 0;
  const toolNames: string[] = [];

  try {
    let reply = '';
    for (let i = 0; i <= maxIters; i++) {
      const res = await client.createMessage({ model, system: input.system, messages, maxTokens, tools: input.tools });
      inputTokens += res.usage.inputTokens;
      outputTokens += res.usage.outputTokens;

      // ¿Pidió herramientas y hay ejecutor y queda presupuesto de rondas? Ejecutar y continuar.
      if (res.toolUses.length && input.executeTool && i < maxIters) {
        toolNames.push(...res.toolUses.map((t) => t.name));
        // Turno del asistente: texto (si hubo) + bloques tool_use.
        const assistantBlocks: AiContentBlock[] = [];
        if (res.text) assistantBlocks.push({ type: 'text', text: res.text });
        for (const tu of res.toolUses) assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
        messages.push({ role: 'assistant', content: assistantBlocks });
        // Resultados de las tools (server-side, tenant-scoped). Si una falla, se reporta como error.
        const resultBlocks: AiContentBlock[] = [];
        for (const tu of res.toolUses) {
          let out: unknown;
          try {
            out = await input.executeTool(tu.name, tu.input);
          } catch {
            out = { error: 'la herramienta no pudo completarse' };
          }
          resultBlocks.push({ type: 'tool_result', toolUseId: tu.id, content: JSON.stringify(out) });
        }
        messages.push({ role: 'user', content: resultBlocks });
        continue;
      }

      reply = res.text;
      break;
    }

    const latencyMs = deps.now() - t0;
    const usage = { inputTokens, outputTokens };
    const costUsd = estimateCostUsd(usage);

    logger.info('AI gateway: ok', {
      tenantId: input.tenantId,
      context: input.context,
      inputTokens,
      outputTokens,
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
      inputTokens,
      outputTokens,
      costUsd,
      toolNames,
    });

    return { status: 'ok', model, latencyMs, reply, usage, costUsd };
  } catch (e) {
    const latencyMs = deps.now() - t0;
    const errorCode = safeErrorCode(e);
    // Logging SEGURO: NO pasamos el error crudo (su message/stack podría arrastrar contenido).
    logger.error('AI gateway: error del modelo', undefined, { tenantId: input.tenantId, context: input.context, errorCode, latencyMs });
    await deps.writeAudit({ tenantId: input.tenantId, context: input.context, model, status: 'error', latencyMs, errorCode });
    return { status: 'error', model, latencyMs, errorCode };
  }
}
