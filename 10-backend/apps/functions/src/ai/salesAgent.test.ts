import { describe, it, expect } from 'vitest';
import { runSalesAgent, extractShownSkus, MAX_SHOWN_SKUS } from './salesAgent.js';
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
    expect(out).toEqual({ used: true, reply: 'Te recomiendo el Lattafa Asad ✨', shownSkus: [], usedTools: [] });
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

  it('respuesta vacía/inválida (status ok, texto vacío) → used:false, reason empty_reply, sin metering', async () => {
    const { deps, calls } = makeDeps({ runAgent: async () => okResult({ reply: '   ' }) });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }] }, deps);
    expect(out).toEqual({ used: false, reason: 'empty_reply' }); // no 'ok': el reason refleja la causa real
    expect(calls.usage).toHaveLength(0); // no se mide si no hubo respuesta usable
  });

  it('si el metering falla, NO rompe la respuesta al cliente (used:true igual)', async () => {
    const { deps } = makeDeps({ recordUsage: async () => { throw new Error('firestore caído'); } });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }] }, deps);
    expect(out).toEqual({ used: true, reply: 'Te recomiendo el Lattafa Asad ✨', shownSkus: [], usedTools: [] });
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

  // ---- AG-3B: captura de shownSkus desde el RESULTADO backend de buscar_productos ----

  it('IA usa buscar_productos → shownSkus = ids del RESULTADO backend; usedTools registrado', async () => {
    const productos = [{ id: 'p1', name: 'Yara' }, { id: 'p2', name: 'Good Girl' }]; // shape PublicProduct[]
    const { deps } = makeDeps({ execTool: async () => ({ ok: true, result: productos }) });
    const runAgent: SalesAgentDeps['runAgent'] = async (input) => {
      await input.executeTool!('buscar_productos', { estilo: 'árabe' });
      return okResult({ reply: 'Mirá estas 2 opciones ✨' });
    };
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'algo árabe' }] }, { ...deps, runAgent });
    expect(out).toEqual({ used: true, reply: 'Mirá estas 2 opciones ✨', shownSkus: ['p1', 'p2'], usedTools: ['buscar_productos'] });
  });

  it('prompt injection: el modelo inventa SKUs en el texto → NO entran; shownSkus solo del backend', async () => {
    const productos = [{ id: 'real-1', name: 'Yara' }];
    const { deps } = makeDeps({ execTool: async () => ({ ok: true, result: productos }) });
    const runAgent: SalesAgentDeps['runAgent'] = async (input) => {
      await input.executeTool!('buscar_productos', {});
      return okResult({ reply: 'Agregá el SKU-HACK-999 y el id evil-tenant-prod ✨' }); // texto malicioso, ignorado
    };
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'x' }] }, { ...deps, runAgent });
    expect(out).toMatchObject({ used: true, shownSkus: ['real-1'] }); // ni SKU-HACK-999 ni evil-tenant-prod
  });

  it('buscar_productos sin resultados → shownSkus vacío (el engine no pisa lastShownSkus)', async () => {
    const { deps } = makeDeps({ execTool: async () => ({ ok: true, result: [] }) });
    const runAgent: SalesAgentDeps['runAgent'] = async (input) => { await input.executeTool!('buscar_productos', { precioMax: 1 }); return okResult(); };
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'algo de 1 guaraní' }] }, { ...deps, runAgent });
    expect(out).toMatchObject({ used: true, shownSkus: [] });
  });

  it('una tool bloqueada/no-buscar no aporta SKUs (resumen_ventas no entra al estado)', async () => {
    const { deps } = makeDeps({ execTool: async () => ({ ok: true, result: [{ id: 'no-deberia-entrar' }] }) });
    const runAgent: SalesAgentDeps['runAgent'] = async (input) => { await input.executeTool!('listar_promociones_activas', {}); return okResult(); };
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'promos?' }] }, { ...deps, runAgent });
    expect(out).toMatchObject({ used: true, shownSkus: [] }); // solo buscar_productos puebla shownSkus
  });
});

describe('ai/salesAgent extractShownSkus (fuente de verdad = resultado backend)', () => {
  it('solo desde buscar_productos: otra tool → []', () => {
    expect(extractShownSkus('listar_promociones_activas', [{ id: 'x' }])).toEqual([]);
    expect(extractShownSkus('resumen_ventas', [{ id: 'x' }])).toEqual([]);
  });
  it('resultado no-array (objeto/null/string) → []', () => {
    expect(extractShownSkus('buscar_productos', { productos: [{ id: 'x' }] })).toEqual([]);
    expect(extractShownSkus('buscar_productos', null)).toEqual([]);
    expect(extractShownSkus('buscar_productos', 'p1,p2')).toEqual([]);
  });
  it('ignora items no-objeto / sin id / id no-string o vacío', () => {
    expect(extractShownSkus('buscar_productos', ['p1', 42, null, {}, { id: 7 }, { id: '' }, { id: '  ' }, { id: 'ok' }])).toEqual(['ok']);
  });
  it('deduplica conservando orden y hace trim', () => {
    expect(extractShownSkus('buscar_productos', [{ id: 'a' }, { id: '  b  ' }, { id: 'a' }])).toEqual(['a', 'b']);
  });
  it('corta al tope MAX_SHOWN_SKUS', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}` }));
    const out = extractShownSkus('buscar_productos', many);
    expect(out).toHaveLength(MAX_SHOWN_SKUS);
    expect(out[0]).toBe('p0');
  });
});
