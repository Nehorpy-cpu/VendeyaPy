/**
 * gateway.usageParcial.test.ts — el gateway reporta el uso PARCIAL en errores (ADR-0018 §3)
 * =========================================================================================
 * El loop de tools acumula inputTokens/outputTokens llamada a llamada. Antes, una excepción a
 * mitad del loop devolvía `status:'error'` SIN usage: los tokens ya consumidos se perdían para
 * la contabilidad. Con la reserva transaccional eso es inaceptable — la liquidación necesita el
 * parcial real. Este test rompe contra el gateway viejo y fija el contrato nuevo.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runAgent } from './gateway.js';
import type { RunAgentDeps, RunAgentInput } from './types.js';

const INPUT: RunAgentInput = {
  tenantId: 't', context: 'whatsapp_sales_agent', system: 's',
  messages: [{ role: 'user', content: 'hola' }],
  tools: [], maxTokens: 100,
  executeTool: async () => ({}),
};

it('excepción en la SEGUNDA llamada del loop ⇒ status error CON el uso acumulado de la primera', async () => {
  let llamada = 0;
  const deps: RunAgentDeps = {
    getClient: async () => ({
      createMessage: async () => {
        llamada++;
        if (llamada === 1) {
          return {
            text: '', usage: { inputTokens: 350, outputTokens: 40 },
            toolUses: [{ id: 'tu1', name: 'buscar_productos', input: {} }],
          };
        }
        throw Object.assign(new Error('overloaded'), { status: 529 });
      },
    }),
    writeAudit: vi.fn(async () => undefined),
    now: () => 1000,
  };
  const r = await runAgent({ ...INPUT, executeTool: async () => ({ ok: true }) }, deps);
  expect(r.status).toBe('error');
  expect(r.usage).toEqual({ inputTokens: 350, outputTokens: 40 });
  expect(r.costUsd).toBeGreaterThan(0);
});

it('excepción en la PRIMERA llamada ⇒ usage {0,0} explícito (nada consumido, liquidable en cero)', async () => {
  const deps: RunAgentDeps = {
    getClient: async () => ({ createMessage: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } }),
    writeAudit: vi.fn(async () => undefined),
    now: () => 1000,
  };
  const r = await runAgent(INPUT, deps);
  expect(r.status).toBe('error');
  expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
});
