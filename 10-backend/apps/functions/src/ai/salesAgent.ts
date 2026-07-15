/**
 * ai/salesAgent.ts — Sales agent de WhatsApp con Claude Haiku (AG-3)
 * =================================================================
 * Envuelve el gateway con: GATE de entitlements (feature aiAssistant + presupuesto de tokens),
 * tools del contexto `sales` (solo lectura, sanitizadas), y METERING del uso real. Devuelve
 * { used: true, reply } solo si la IA está habilitada Y produjo una respuesta válida; en cualquier
 * otro caso { used: false } y el caller (handleMessage) usa el motor rule-based. Reversible: sin
 * feature/env/presupuesto, la IA nunca corre. El modelo NUNCA recibe datos privados (tools sanitizadas).
 */
import type { AgentConfig } from '@vpw/shared';
import { assertAiBudget, recordAiUsage } from '../entitlements/ai.js';
import { runAgent } from './gateway.js';
import { buildSalesSystemPrompt } from './prompts.js';
import { toolDefinitionsForContext, executeTool } from './tools/registry.js';
import type { AiMessage, RunAgentInput, RunAgentResult, ToolExecResult } from './types.js';

const EST_TOKENS_PER_TURN = 1500; // estimación para el gate ANTES de llamar (presupuesto).
const SALES_MAX_TOKENS = 700;
/**
 * Tope de productos a recordar en el estado conversacional. Igual al límite del catálogo rule-based
 * (engine.ts catalogo `limit:3`) y al alcance de `ordinalIndex` (primero/segundo/tercero). Así "el
 * primero/segundo/tercero" cubre exactamente lo recordado y no quedan SKUs no seleccionables por orden.
 */
export const MAX_SHOWN_SKUS = 3;
const SHOWN_SKUS_TOOL = 'buscar_productos';

/**
 * Extrae {id, name} de los productos mostrados SOLO del RESULTADO backend de `buscar_productos`
 * (PublicProduct[]). Claude NUNCA aporta SKUs: la fuente de verdad es el array que devolvió la
 * tool server-side (tenant-scoped, sanitizado). Endurecido contra formas raras: ignora no-arrays,
 * items no-objeto, ids no-string/vacíos; deduplica y corta a `max`. El name viaja junto al id
 * para que el motor pueda ALINEAR la respuesta con lo presentado (F3) sin re-leer el catálogo.
 */
export function extractShownProducts(
  toolName: string,
  toolResult: unknown,
  max = MAX_SHOWN_SKUS,
): Array<{ id: string; name: string }> {
  if (toolName !== SHOWN_SKUS_TOOL || !Array.isArray(toolResult)) return [];
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const item of toolResult) {
    if (!item || typeof item !== 'object') continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) continue;
    seen.add(id.trim());
    out.push({ id: id.trim(), name: typeof name === 'string' ? name.trim() : '' });
  }
  return out.slice(0, max);
}

/** Compat: solo los ids (tests/consumidores existentes). */
export function extractShownSkus(toolName: string, toolResult: unknown, max = MAX_SHOWN_SKUS): string[] {
  return extractShownProducts(toolName, toolResult, max).map((p) => p.id);
}

/**
 * AI-FALLBACK-HONESTO-1: razón ESTRUCTURADA del bloqueo (nunca comparar textos de error).
 *  - quota_exhausted: cuota/presupuesto mensual agotado (confirmado por el gate) — único caso
 *    que habilita el handoff automático `ai_unavailable`.
 *  - feature_unavailable: feature apagada / trial vencido / cuenta suspendida.
 *  - configuration_error: sin API key/cliente (gateway 'disabled').
 *  - provider_transient_error: error/timeout del proveedor (transitorio: NO deriva).
 *  - empty_reply: el modelo respondió vacío.
 */
export type SalesAgentBlockReason =
  | 'quota_exhausted'
  | 'feature_unavailable'
  | 'configuration_error'
  | 'provider_transient_error'
  | 'empty_reply';

export type SalesAgentOutcome =
  | {
      used: true;
      reply: string;
      shownSkus: string[];
      /** F3: id+name en el orden de la tool (para alinear con el texto presentado). */
      shownProducts: Array<{ id: string; name: string }>;
      usedTools: string[];
    }
  | { used: false; reason: SalesAgentBlockReason };

export interface SalesAgentDeps {
  assertBudget: (tenantId: string, estTokens: number) => Promise<void>;
  recordUsage: (tenantId: string, tokens: number, costUsd: number) => Promise<void>;
  runAgent: (input: RunAgentInput) => Promise<RunAgentResult>;
  execTool: (tenantId: string, name: string, input: Record<string, unknown>) => Promise<ToolExecResult>;
}
const defaultDeps: SalesAgentDeps = {
  assertBudget: (t, est) => assertAiBudget(t, est),
  recordUsage: (t, tokens, cost) => recordAiUsage(t, tokens, cost),
  runAgent,
  execTool: (t, name, input) => executeTool('whatsapp_sales_agent', t, name, input),
};

export async function runSalesAgent(
  input: { tenantId: string; agentConfig: AgentConfig; messages: AiMessage[] },
  deps: SalesAgentDeps = defaultDeps,
): Promise<SalesAgentOutcome> {
  // GATE: feature aiAssistant + presupuesto de tokens. Si no pasa → fallback con razón
  // ESTRUCTURADA por código de error (HttpsError.code), jamás por texto:
  //  - 'resource-exhausted'  → cuota/presupuesto agotado (habilita el fallback honesto).
  //  - 'failed-precondition' → feature off / trial vencido / suspensión.
  try {
    await deps.assertBudget(input.tenantId, EST_TOKENS_PER_TURN);
  } catch (e) {
    const code = (e as { code?: string }).code;
    const reason: SalesAgentBlockReason =
      code === 'resource-exhausted' ? 'quota_exhausted'
      : code === 'failed-precondition' ? 'feature_unavailable'
      // Sin código conocido (Firestore caído, error de infraestructura): transitorio — jamás
      // se interpreta como cuota agotada ni como feature apagada (review).
      : 'provider_transient_error';
    return { used: false, reason };
  }

  // Metadata SEGURA capturada server-side durante el loop de tools (no del texto del modelo).
  let shownProducts: Array<{ id: string; name: string }> = [];
  const usedTools: string[] = [];

  const result = await deps.runAgent({
    tenantId: input.tenantId,
    context: 'whatsapp_sales_agent',
    system: buildSalesSystemPrompt({ agent: input.agentConfig }),
    messages: input.messages,
    tools: toolDefinitionsForContext('whatsapp_sales_agent'), // solo buscar_productos / listar_promociones_activas
    maxTokens: SALES_MAX_TOKENS,
    executeTool: async (name, toolInput) => {
      usedTools.push(name);
      const r = await deps.execTool(input.tenantId, name, toolInput); // tenantId del contexto, no del modelo
      // Productos mostrados = SOLO del resultado backend de buscar_productos (la última búsqueda no vacía gana).
      if (r.ok) {
        const shown = extractShownProducts(name, r.result);
        if (shown.length) shownProducts = shown;
      }
      return r.ok ? r.result : { error: r.error };
    },
  });

  // disabled (sin API key/cliente) / error (Claude falló) / texto vacío o inválido → fallback rule-based.
  if (result.status !== 'ok' || !result.reply || !result.reply.trim()) {
    const reason: SalesAgentBlockReason =
      result.status === 'ok' ? 'empty_reply'
      : result.status === 'disabled' ? 'configuration_error'
      : 'provider_transient_error';
    return { used: false, reason };
  }

  // METER: registrar el uso real (tokens + costo). No bloquea la respuesta si falla.
  if (result.usage) {
    try {
      await deps.recordUsage(input.tenantId, result.usage.inputTokens + result.usage.outputTokens, result.costUsd ?? 0);
    } catch {
      /* el metering nunca debe romper la respuesta al cliente */
    }
  }

  return {
    used: true,
    reply: result.reply.trim(),
    shownSkus: shownProducts.map((p) => p.id),
    shownProducts: [...shownProducts],
    usedTools: [...usedTools],
  };
}
