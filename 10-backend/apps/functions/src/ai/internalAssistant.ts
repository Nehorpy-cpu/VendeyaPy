/**
 * ai/internalAssistant.ts — Asistente interno de crecimiento (Claude Haiku · AG-4)
 * ================================================================================
 * Núcleo del `internal_growth_assistant`: envuelve el gateway con GATE de entitlements
 * (feature aiAssistant + presupuesto), tools READ-ONLY del contexto `internal` (resumen_ventas) y
 * METERING. Es para el OWNER/ADMIN del panel y SÍ puede ver agregados privados (ganancia/margen) PERO
 * SOLO del tenant indicado (tenantId YA resuelto por el callable; las tools lo usan, ignoran el input).
 * Read-only: no escribe, no cambia config, no envía mensajes, no crea promos/campañas. Si el gateway
 * está disabled / falla / sin cupo → devuelve un error CONTROLADO y amigable (nunca rompe el callable).
 */
import { assertAiBudget, recordAiUsage } from '../entitlements/ai.js';
import { runAgent } from './gateway.js';
import { buildInternalSystemPrompt } from './prompts.js';
import { toolDefinitionsForContext, executeTool } from './tools/registry.js';
import type { RunAgentInput, RunAgentResult, ToolExecResult } from './types.js';

const EST_TOKENS_PER_TURN = 1500; // estimación para el gate ANTES de llamar (presupuesto).
const INTERNAL_MAX_TOKENS = 800;

const MSG_GATE = 'El asistente de IA no está disponible en tu plan o alcanzaste el límite de uso de este mes.';
const MSG_DISABLED = 'El asistente de IA no está configurado en este momento. Probá más tarde.';
const MSG_ERROR = 'No pude generar una respuesta ahora. Probá de nuevo en un momento.';

export type InternalAssistantOutcome =
  | { ok: true; reply: string }
  | { ok: false; reason: string; message: string };

export interface InternalAssistantDeps {
  assertBudget: (tenantId: string, estTokens: number, actorUid?: string | null) => Promise<void>;
  recordUsage: (tenantId: string, tokens: number, costUsd: number) => Promise<void>;
  runAgent: (input: RunAgentInput) => Promise<RunAgentResult>;
  execTool: (tenantId: string, name: string, input: Record<string, unknown>) => Promise<ToolExecResult>;
}
const defaultDeps: InternalAssistantDeps = {
  assertBudget: (t, est, uid) => assertAiBudget(t, est, uid),
  recordUsage: (t, tokens, cost) => recordAiUsage(t, tokens, cost),
  runAgent,
  execTool: (t, name, input) => executeTool('internal_growth_assistant', t, name, input),
};

export async function runInternalAssistant(
  input: { tenantId: string; businessName: string; message: string; actorUid?: string | null },
  deps: InternalAssistantDeps = defaultDeps,
): Promise<InternalAssistantOutcome> {
  // GATE: feature aiAssistant + presupuesto de tokens. Denegación legítima (feature off → 'failed-
  // precondition'; cuota → 'resource-exhausted') → 'gate' (decile que actualice el plan). Cualquier
  // otro error (infra/Firestore caído/inesperado) → 'error' genérico: no le mientas diciendo "sin cupo".
  try {
    await deps.assertBudget(input.tenantId, EST_TOKENS_PER_TURN, input.actorUid);
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'failed-precondition' || code === 'resource-exhausted') {
      return { ok: false, reason: 'gate', message: MSG_GATE };
    }
    return { ok: false, reason: 'error', message: MSG_ERROR };
  }

  const result = await deps.runAgent({
    tenantId: input.tenantId,
    context: 'internal_growth_assistant',
    system: buildInternalSystemPrompt({ businessName: input.businessName }),
    messages: [{ role: 'user', content: input.message }],
    tools: toolDefinitionsForContext('internal_growth_assistant'), // solo resumen_ventas (read-only)
    maxTokens: INTERNAL_MAX_TOKENS,
    executeTool: async (name, toolInput) => {
      const r = await deps.execTool(input.tenantId, name, toolInput); // tenantId del contexto, no del modelo/input
      return r.ok ? r.result : { error: r.error };
    },
  });

  // disabled (sin API key) / error (Claude falló) / texto vacío → error CONTROLADO (no rompe el callable).
  if (result.status === 'disabled') return { ok: false, reason: 'disabled', message: MSG_DISABLED };
  if (result.status !== 'ok' || !result.reply || !result.reply.trim()) {
    return { ok: false, reason: result.status === 'ok' ? 'empty_reply' : result.status, message: MSG_ERROR };
  }

  // METER: registrar el uso real (tokens + costo). No bloquea la respuesta si falla.
  if (result.usage) {
    try {
      await deps.recordUsage(input.tenantId, result.usage.inputTokens + result.usage.outputTokens, result.costUsd ?? 0);
    } catch {
      /* el metering nunca debe romper la respuesta */
    }
  }

  return { ok: true, reply: result.reply.trim() };
}
