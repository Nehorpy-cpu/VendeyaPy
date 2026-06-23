import { describe, it, expect } from 'vitest';
import { runInternalAssistant } from './internalAssistant.js';
import type { InternalAssistantDeps } from './internalAssistant.js';
import { executeTool } from './tools/registry.js';
import type { RunAgentInput, RunAgentResult, ToolExecResult } from './types.js';

const okResult = (over: Partial<RunAgentResult> = {}): RunAgentResult => ({
  status: 'ok', model: 'claude-haiku-4-5-20251001', latencyMs: 5,
  reply: 'Tus ventas crecieron 12% este mes 📈', usage: { inputTokens: 200, outputTokens: 90 }, costUsd: 0.002,
  ...over,
});

function makeDeps(over: Partial<InternalAssistantDeps> = {}): {
  deps: InternalAssistantDeps;
  calls: { budget: Array<[string, number, string | null | undefined]>; usage: Array<[string, number, number]>; runAgent: RunAgentInput[]; execTool: Array<[string, string, Record<string, unknown>]> };
} {
  const calls = { budget: [] as Array<[string, number, string | null | undefined]>, usage: [] as Array<[string, number, number]>, runAgent: [] as RunAgentInput[], execTool: [] as Array<[string, string, Record<string, unknown>]> };
  const deps: InternalAssistantDeps = {
    assertBudget: async (t, est, uid) => { calls.budget.push([t, est, uid]); },
    recordUsage: async (t, tokens, cost) => { calls.usage.push([t, tokens, cost]); },
    runAgent: async (input) => { calls.runAgent.push(input); return okResult(); },
    execTool: async (t, name, input): Promise<ToolExecResult> => { calls.execTool.push([t, name, input]); return { ok: true, result: { ventas: 0 } }; },
    ...over,
  };
  return { deps, calls };
}

const BASE = { tenantId: 'perfumeria', businessName: 'Perfumería AFG', message: '¿cómo van mis ventas?', actorUid: 'uid-owner' };

describe('ai/internalAssistant runInternalAssistant', () => {
  it('habilitado + respuesta válida → ok:true y registra uso (tokens sumados + costo)', async () => {
    const { deps, calls } = makeDeps();
    const out = await runInternalAssistant(BASE, deps);
    expect(out).toEqual({ ok: true, reply: 'Tus ventas crecieron 12% este mes 📈' });
    expect(calls.budget).toEqual([['perfumeria', 1500, 'uid-owner']]); // gate ANTES, con actorUid
    expect(calls.usage).toEqual([['perfumeria', 290, 0.002]]); // metering DESPUÉS (200+90)
  });

  const httpErr = (code) => Object.assign(new Error('denied'), { code });

  it('gate deniega (feature off → failed-precondition / cuota → resource-exhausted) → ok:false reason gate', async () => {
    for (const code of ['failed-precondition', 'resource-exhausted']) {
      const { deps, calls } = makeDeps({ assertBudget: async () => { throw httpErr(code); } });
      const out = await runInternalAssistant(BASE, deps);
      expect(out).toMatchObject({ ok: false, reason: 'gate' });
      expect(out.ok === false && out.message.length > 0).toBe(true);
      expect(calls.runAgent).toHaveLength(0); // nunca llamó a Claude
      expect(calls.usage).toHaveLength(0); // sin metering
    }
  });

  it('gate con fallo de INFRA (Error plano, sin code de denegación) → ok:false reason error (no "sin cupo")', async () => {
    const { deps, calls } = makeDeps({ assertBudget: async () => { throw new Error('firestore caído'); } });
    const out = await runInternalAssistant(BASE, deps);
    expect(out).toMatchObject({ ok: false, reason: 'error' }); // NO 'gate': no le miente al owner sobre su plan
    expect(calls.runAgent).toHaveLength(0);
  });

  it('gateway disabled (sin API key) → ok:false reason disabled, mensaje controlado, sin metering', async () => {
    const { deps, calls } = makeDeps({ runAgent: async () => okResult({ status: 'disabled', reply: undefined, usage: undefined, costUsd: undefined }) });
    const out = await runInternalAssistant(BASE, deps);
    expect(out).toMatchObject({ ok: false, reason: 'disabled' });
    expect(calls.usage).toHaveLength(0);
  });

  it('gateway error (Claude falló) → ok:false reason error (controlado)', async () => {
    const { deps } = makeDeps({ runAgent: async () => okResult({ status: 'error', reply: undefined, usage: undefined, costUsd: undefined, errorCode: 'http_500' }) });
    const out = await runInternalAssistant(BASE, deps);
    expect(out).toMatchObject({ ok: false, reason: 'error' });
  });

  it('status ok con reply vacío → ok:false reason empty_reply, sin metering', async () => {
    const { deps, calls } = makeDeps({ runAgent: async () => okResult({ reply: '   ' }) });
    const out = await runInternalAssistant(BASE, deps);
    expect(out).toMatchObject({ ok: false, reason: 'empty_reply' });
    expect(calls.usage).toHaveLength(0);
  });

  it('si el metering falla, NO rompe la respuesta (ok:true igual)', async () => {
    const { deps } = makeDeps({ recordUsage: async () => { throw new Error('firestore caído'); } });
    const out = await runInternalAssistant(BASE, deps);
    expect(out).toEqual({ ok: true, reply: 'Tus ventas crecieron 12% este mes 📈' });
  });

  it('contexto internal: tools READ-ONLY (resumen_ventas) y executeTool tenant-scoped (ignora el tenant del input)', async () => {
    const { deps, calls } = makeDeps();
    const runAgent: InternalAssistantDeps['runAgent'] = async (input) => {
      calls.runAgent.push(input);
      await input.executeTool!('resumen_ventas', { tenantId: 'OTRO-TENANT' });
      return okResult();
    };
    await runInternalAssistant(BASE, { ...deps, runAgent });
    const input = calls.runAgent[0]!;
    expect(input.context).toBe('internal_growth_assistant');
    const toolNames = (input.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual(['resumen_ventas']); // solo lectura; sin tools de escritura ni de sales
    expect(calls.execTool[0]![0]).toBe('perfumeria'); // tenant del contexto, ignora el 'OTRO-TENANT' del input
  });

  it('una tool del contexto sales (buscar_productos) NO es ejecutable desde internal (registry real)', async () => {
    // Usa el executeTool REAL del registry para probar el aislamiento de contextos.
    const r = await executeTool('internal_growth_assistant', 'perfumeria', 'buscar_productos', {});
    expect(r.ok).toBe(false); // buscar_productos no está en el allowlist de internal
  });
});
