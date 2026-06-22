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

export type SalesAgentOutcome = { used: true; reply: string } | { used: false; reason: string };

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

  const result = await deps.runAgent({
    tenantId: input.tenantId,
    context: 'whatsapp_sales_agent',
    system: buildSalesSystemPrompt({ agent: input.agentConfig }),
    messages: input.messages,
    tools: toolDefinitionsForContext('whatsapp_sales_agent'), // solo buscar_productos / listar_promociones_activas
    maxTokens: SALES_MAX_TOKENS,
    executeTool: async (name, toolInput) => {
      const r = await deps.execTool(input.tenantId, name, toolInput); // tenantId del contexto, no del modelo
      return r.ok ? r.result : { error: r.error };
    },
  });

  // disabled (sin API key/cliente) / error (Claude falló) / texto vacío o inválido → fallback rule-based.
  if (result.status !== 'ok' || !result.reply || !result.reply.trim()) {
    return { used: false, reason: result.status };
  }

  // METER: registrar el uso real (tokens + costo). No bloquea la respuesta si falla.
  if (result.usage) {
    try {
      await deps.recordUsage(input.tenantId, result.usage.inputTokens + result.usage.outputTokens, result.costUsd ?? 0);
    } catch {
      /* el metering nunca debe romper la respuesta al cliente */
    }
  }

  return { used: true, reply: result.reply.trim() };
}
