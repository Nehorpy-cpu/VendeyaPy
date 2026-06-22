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
 * Extrae los SKUs (ids) mostrados SOLO del RESULTADO backend de `buscar_productos` (PublicProduct[]).
 * Claude NUNCA aporta SKUs: la fuente de verdad es el array que devolvió la tool server-side
 * (tenant-scoped, sanitizado). Endurecido contra formas raras: ignora no-arrays, items no-objeto,
 * ids no-string/vacíos; deduplica y corta a `max`. Así un id inventado por el modelo no entra.
 */
export function extractShownSkus(toolName: string, toolResult: unknown, max = MAX_SHOWN_SKUS): string[] {
  if (toolName !== SHOWN_SKUS_TOOL || !Array.isArray(toolResult)) return [];
  const ids: string[] = [];
  for (const item of toolResult) {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return [...new Set(ids)].slice(0, max);
}

export type SalesAgentOutcome =
  | { used: true; reply: string; shownSkus: string[]; usedTools: string[] }
  | { used: false; reason: string };

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
  // GATE: feature aiAssistant + presupuesto de tokens. Si no pasa (feature off / cuota) → fallback.
  try {
    await deps.assertBudget(input.tenantId, EST_TOKENS_PER_TURN);
  } catch {
    return { used: false, reason: 'gate' };
  }

  // Metadata SEGURA capturada server-side durante el loop de tools (no del texto del modelo).
  let shownSkus: string[] = [];
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
      // SKUs mostrados = SOLO ids del resultado backend de buscar_productos (la última búsqueda no vacía gana).
      if (r.ok) {
        const ids = extractShownSkus(name, r.result);
        if (ids.length) shownSkus = ids;
      }
      return r.ok ? r.result : { error: r.error };
    },
  });

  // disabled (sin API key/cliente) / error (Claude falló) / texto vacío o inválido → fallback rule-based.
  if (result.status !== 'ok' || !result.reply || !result.reply.trim()) {
    // status 'ok' con reply vacío = 'empty_reply' (no 'ok'): el reason es para diagnóstico/logging.
    return { used: false, reason: result.status === 'ok' ? 'empty_reply' : result.status };
  }

  // METER: registrar el uso real (tokens + costo). No bloquea la respuesta si falla.
  if (result.usage) {
    try {
      await deps.recordUsage(input.tenantId, result.usage.inputTokens + result.usage.outputTokens, result.costUsd ?? 0);
    } catch {
      /* el metering nunca debe romper la respuesta al cliente */
    }
  }

  return { used: true, reply: result.reply.trim(), shownSkus: [...shownSkus], usedTools: [...usedTools] };
}
