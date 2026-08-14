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
import { randomUUID } from 'node:crypto';
import { abrirPresupuestoDeIa } from '../entitlements/ai.js';
import { estimacionDeTokens, type ReservaDeIa } from '../entitlements/aiReservation.js';
import { runAgent } from './gateway.js';
import { buildInternalSystemPrompt } from './prompts.js';
import { toolDefinitionsForContext, executeTool } from './tools/registry.js';
import type { RunAgentInput, RunAgentResult, ToolExecResult } from './types.js';

const INTERNAL_MAX_TOKENS = 800;

const MSG_GATE = 'El asistente de IA no está disponible en tu plan o alcanzaste el límite de uso de este mes.';
const MSG_DISABLED = 'El asistente de IA no está configurado en este momento. Probá más tarde.';
const MSG_ERROR = 'No pude generar una respuesta ahora. Probá de nuevo en un momento.';

export type InternalAssistantOutcome =
  | { ok: true; reply: string }
  | { ok: false; reason: string; message: string };

export interface InternalAssistantDeps {
  /** ADR-0018: abre el ciclo reserva→liquidación (reemplaza assertBudget + recordUsage). */
  openBudget: (tenantId: string, clave: string, estTokens: number, actorUid?: string | null) => Promise<ReservaDeIa>;
  runAgent: (input: RunAgentInput) => Promise<RunAgentResult>;
  execTool: (tenantId: string, name: string, input: Record<string, unknown>) => Promise<ToolExecResult>;
}
const defaultDeps: InternalAssistantDeps = {
  openBudget: (t, clave, est, uid) => abrirPresupuestoDeIa(t, clave, est, 'internal_growth_assistant', uid),
  runAgent,
  execTool: (t, name, input) => executeTool('internal_growth_assistant', t, name, input),
};

export async function runInternalAssistant(
  input: { tenantId: string; businessName: string; message: string; actorUid?: string | null },
  deps: InternalAssistantDeps = defaultDeps,
): Promise<InternalAssistantOutcome> {
  // GATE (ADR-0018): feature aiAssistant + RESERVA transaccional. La unidad de reintento acá es
  // la propia invocación del callable (no hay re-entrega upstream) ⇒ clave efímera por turno.
  // Denegación legítima (feature off → 'failed-precondition'; cuota → 'resource-exhausted') →
  // 'gate'. Cualquier otro error (infra) → 'error' genérico: no le mientas diciendo "sin cupo".
  let reserva: ReservaDeIa;
  try {
    reserva = await deps.openBudget(input.tenantId, `interno-${randomUUID()}`, estimacionDeTokens('texto_interno'), input.actorUid);
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'failed-precondition' || code === 'resource-exhausted') {
      return { ok: false, reason: 'gate', message: MSG_GATE };
    }
    return { ok: false, reason: 'error', message: MSG_ERROR };
  }
  if (reserva.cerrada) return { ok: false, reason: 'error', message: MSG_ERROR };

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

  // disabled (sin API key) / error (Claude falló) / texto vacío → error CONTROLADO (no rompe el
  // callable). Cierre de la reserva según lo que pasó: disabled = proveedor jamás contactado ⇒
  // liberar; error/vacío ⇒ liquidar el consumo parcial real que el gateway acumuló (ADR-0018).
  if (result.status === 'disabled') {
    try { await reserva.liberar('proveedor_no_configurado'); } catch { /* nunca rompe */ }
    return { ok: false, reason: 'disabled', message: MSG_DISABLED };
  }
  if (result.status !== 'ok' || !result.reply || !result.reply.trim()) {
    try { await reserva.liquidar(result.usage ?? { inputTokens: 0, outputTokens: 0 }, result.costUsd ?? 0); } catch { /* nunca rompe */ }
    return { ok: false, reason: result.status === 'ok' ? 'empty_reply' : result.status, message: MSG_ERROR };
  }

  // LIQUIDAR: uso real exactamente una vez. No bloquea la respuesta si falla (la reserva vence sola).
  try {
    await reserva.liquidar(result.usage ?? { inputTokens: 0, outputTokens: 0 }, result.costUsd ?? 0);
  } catch {
    /* el metering nunca debe romper la respuesta */
  }

  return { ok: true, reply: result.reply.trim() };
}
