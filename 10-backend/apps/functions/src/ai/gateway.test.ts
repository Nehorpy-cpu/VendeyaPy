import { describe, it, expect } from 'vitest';
import { runAgent } from './gateway.js';
import { FakeAiClient } from './client.js';
import { estimateCostUsd } from './pricing.js';
import type { AiAuditRecord, AiClient, RunAgentDeps, RunAgentInput } from './types.js';

const INPUT: RunAgentInput = {
  tenantId: 'perfumeria',
  context: 'whatsapp_sales_agent',
  system: 'system prompt (no se loguea)',
  messages: [{ role: 'user', content: 'hola, busco un perfume' }],
};

/** Deps de test: cliente inyectado (sin red) + auditoría capturada en memoria + tiempo fijo. */
function makeDeps(client: AiClient | null): { deps: RunAgentDeps; audits: AiAuditRecord[] } {
  const audits: AiAuditRecord[] = [];
  let t = 1000;
  return {
    audits,
    deps: {
      getClient: async () => client,
      writeAudit: async (r) => { audits.push(r); },
      now: () => (t += 5),
    },
  };
}

describe('ai/gateway runAgent', () => {
  it('ok: devuelve reply + usage + costo y audita status ok', async () => {
    const { deps, audits } = makeDeps(new FakeAiClient({ text: 'te recomiendo X', inputTokens: 100, outputTokens: 50 }));
    const res = await runAgent(INPUT, deps);
    expect(res.status).toBe('ok');
    expect(res.reply).toBe('te recomiendo X');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(res.costUsd).toBeCloseTo(estimateCostUsd({ inputTokens: 100, outputTokens: 50 }), 9);
    expect(res.model).toBe('claude-haiku-4-5-20251001');
    expect(typeof res.latencyMs).toBe('number');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: 'ok', context: 'whatsapp_sales_agent', inputTokens: 100, outputTokens: 50 });
  });

  it('error: el cliente lanza → status error con código seguro, sin reply, no lanza', async () => {
    const { deps, audits } = makeDeps(new FakeAiClient({ fail: true }));
    const res = await runAgent(INPUT, deps);
    expect(res.status).toBe('error');
    expect(res.reply).toBeUndefined();
    expect(res.errorCode).toBeTruthy();
    expect(audits[0]?.status).toBe('error');
  });

  it('disabled: sin cliente (sin API key) → status disabled, sin reply, no lanza', async () => {
    const { deps, audits } = makeDeps(null);
    const res = await runAgent(INPUT, deps);
    expect(res.status).toBe('disabled');
    expect(res.reply).toBeUndefined();
    expect(audits[0]?.status).toBe('disabled');
  });

  it('captura usage y calcula costo coherente', async () => {
    const { deps } = makeDeps(new FakeAiClient({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    const res = await runAgent(INPUT, deps);
    expect(res.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(res.costUsd).toBeCloseTo(6, 6); // $1 in + $5 out
  });

  it('tool-loop: tool_use → ejecuta server-side → tool_result → texto; suma usage de ambas rondas', async () => {
    // Ronda 1: el modelo pide una tool. Ronda 2: con el resultado, responde con texto.
    const client = new FakeAiClient({
      responses: [
        { toolUses: [{ id: 'tu_1', name: 'buscar_productos', input: { genero: 'femenino' } }], inputTokens: 100, outputTokens: 20 },
        { text: 'Encontré 2 opciones dulces 🌸', inputTokens: 60, outputTokens: 30 },
      ],
    });
    const { deps } = makeDeps(client);
    const toolCalls: Array<[string, Record<string, unknown>]> = [];
    const res = await runAgent({
      ...INPUT,
      tools: [{ name: 'buscar_productos', description: 'busca', inputSchema: { type: 'object' } }],
      executeTool: async (name, input) => { toolCalls.push([name, input]); return { productos: [{ name: 'X' }] }; },
    }, deps);
    expect(res.status).toBe('ok');
    expect(res.reply).toBe('Encontré 2 opciones dulces 🌸');
    expect(toolCalls).toEqual([['buscar_productos', { genero: 'femenino' }]]); // se ejecutó server-side
    expect(res.usage).toEqual({ inputTokens: 160, outputTokens: 50 }); // 100+60 / 20+30
  });

  it('tool-loop sin executeTool: no entra al loop, responde con el texto que haya', async () => {
    const client = new FakeAiClient({ toolUses: [{ id: 'tu_1', name: 'buscar_productos', input: {} }], text: 'sin tools disponibles' });
    const { deps } = makeDeps(client);
    const res = await runAgent(INPUT, deps); // INPUT no trae executeTool
    expect(res.status).toBe('ok');
    expect(res.reply).toBe('sin tools disponibles');
  });
});
