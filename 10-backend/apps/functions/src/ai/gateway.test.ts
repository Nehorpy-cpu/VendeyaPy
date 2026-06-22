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
    expect(res.model).toBe('claude-haiku-4-5');
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
});
