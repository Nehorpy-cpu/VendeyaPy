import { describe, it, expect } from 'vitest';
import { runSalesAgent } from './salesAgent.js';
import type { SalesAgentDeps } from './salesAgent.js';
import type { AgentConfig } from '@vpw/shared';
import type { RunAgentInput, RunAgentResult, ToolExecResult } from './types.js';

const AGENT = {
  agentName: 'Sofía', businessName: 'Perfumería AFG', tone: 'amable', language: 'es',
  greetingMessage: '', farewellMessage: '', handoffMessage: '', fallbackMessage: '',
  salesRules: '', faq: [], botEnabled: true, testMode: false, profitMode: false, industry: '',
} as AgentConfig;

const okResult = (over: Partial<RunAgentResult> = {}): RunAgentResult => ({
  status: 'ok', model: 'claude-haiku-4-5', latencyMs: 5,
  reply: 'Te recomiendo el Lattafa Asad ✨', usage: { inputTokens: 120, outputTokens: 80 }, costUsd: 0.001,
  ...over,
});

/** Deps de test: todo inyectado (sin red, sin Firestore, sin entitlements reales). Captura las llamadas. */
function makeDeps(over: Partial<SalesAgentDeps> = {}): {
  deps: SalesAgentDeps;
  calls: { budget: number[]; usage: Array<[string, number, number]>; runAgent: RunAgentInput[]; execTool: Array<[string, string, Record<string, unknown>]> };
} {
  const calls = { budget: [] as number[], usage: [] as Array<[string, number, number]>, runAgent: [] as RunAgentInput[], execTool: [] as Array<[string, string, Record<string, unknown>]> };
  const deps: SalesAgentDeps = {
    assertBudget: async (_t, est) => { calls.budget.push(est); },
    recordUsage: async (t, tokens, cost) => { calls.usage.push([t, tokens, cost]); },
    runAgent: async (input) => { calls.runAgent.push(input); return okResult(); },
    execTool: async (t, name, input): Promise<ToolExecResult> => { calls.execTool.push([t, name, input]); return { ok: true, result: { productos: [] } }; },
    ...over,
  };
  return { deps, calls };
}

describe('ai/salesAgent runSalesAgent', () => {
  it('IA habilitada + respuesta válida → used:true y registra uso (tokens sumados + costo)', async () => {
    const { deps, calls } = makeDeps();
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: '¿qué me recomendás para una primera cita?' }] }, deps);
    expect(out).toEqual({ used: true, reply: 'Te recomiendo el Lattafa Asad ✨' });
    expect(calls.budget).toHaveLength(1); // gate ANTES de llamar
    expect(calls.usage).toEqual([['perfumeria', 200, 0.001]]); // metering DESPUÉS (120+80)
  });

  it('gate falla (feature off / cuota excedida) → used:false, NO llama al modelo ni mide', async () => {
    const { deps, calls } = makeDeps({ assertBudget: async () => { throw new Error('quota_exceeded'); } });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }] }, deps);
    expect(out).toEqual({ used: false, reason: 'gate' });
    expect(calls.runAgent).toHaveLength(0); // nunca se llamó a Claude
    expect(calls.usage).toHaveLength(0); // sin metering
  });

  it('gateway disabled (sin API key/cliente) → used:false, sin metering', async () => {
    const { deps, calls } = makeDeps({ runAgent: async () => okResult({ status: 'disabled', reply: undefined, usage: undefined, costUsd: undefined }) });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }] }, deps);
    expect(out).toEqual({ used: false, reason: 'disabled' });
    expect(calls.usage).toHaveLength(0);
  });

  it('gateway error (Claude falló) → used:false (fallback rule-based)', async () => {
    const { deps } = makeDeps({ runAgent: async () => okResult({ status: 'error', reply: undefined, usage: undefined, costUsd: undefined, errorCode: 'http_500' }) });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }] }, deps);
    expect(out).toEqual({ used: false, reason: 'error' });
  });

  it('respuesta vacía/inválida → used:false, sin metering', async () => {
    const { deps, calls } = makeDeps({ runAgent: async () => okResult({ reply: '   ' }) });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }] }, deps);
    expect(out.used).toBe(false);
    expect(calls.usage).toHaveLength(0); // no se mide si no hubo respuesta usable
  });

  it('si el metering falla, NO rompe la respuesta al cliente (used:true igual)', async () => {
    const { deps } = makeDeps({ recordUsage: async () => { throw new Error('firestore caído'); } });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }] }, deps);
    expect(out).toEqual({ used: true, reply: 'Te recomiendo el Lattafa Asad ✨' });
  });

  it('arma el contexto sales: tools públicas + executeTool tenant-scoped que mapea ok/no-ok', async () => {
    const { deps, calls } = makeDeps();
    await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'tenés algo árabe?' }] }, deps);
    const input = calls.runAgent[0]!;
    expect(input.context).toBe('whatsapp_sales_agent');
    const toolNames = (input.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual(['buscar_productos', 'listar_promociones_activas']); // solo lectura pública; sin crear_borrador_pedido
    expect(input.executeTool).toBeTypeOf('function');

    // El callback ejecuta la tool con el tenantId del CONTEXTO (no del modelo) y mapea el resultado.
    const okOut = await input.executeTool!('buscar_productos', { genero: 'femenino', tenantId: 'OTRO-TENANT' });
    expect(calls.execTool[0]![0]).toBe('perfumeria'); // tenant del contexto, ignora el del input
    expect(okOut).toEqual({ productos: [] });
  });

  it('si la tool no está permitida (contexto), el modelo recibe {error} sin datos privados', async () => {
    const { deps } = makeDeps({ execTool: async () => ({ ok: false, error: 'Herramienta no disponible' }) });
    let received: unknown;
    const capture: SalesAgentDeps['runAgent'] = async (input) => {
      received = await input.executeTool!('resumen_ventas', {}); // tool interna: fuera del allowlist sales
      return okResult();
    };
    await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'dame tus ventas internas' }] }, { ...deps, runAgent: capture });
    expect(received).toEqual({ error: 'Herramienta no disponible' }); // nunca devuelve datos internos
  });
});
