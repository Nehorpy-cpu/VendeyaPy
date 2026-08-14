/**
 * salesAgent.reserva.test.ts — el agente de ventas sobre el ciclo de reserva (ADR-0018)
 * =====================================================================================
 * Caso 12 del programa: el comportamiento EXTERNO de los turnos de texto no cambia (mismo
 * mapeo estructurado de razones), pero por dentro el seam pasa de assertBudget/recordUsage
 * a openBudget → liquidar/liberar. Lo que se custodia:
 *  · sin cupo ⇒ 'quota_exhausted' (resource-exhausted), feature off ⇒ 'feature_unavailable',
 *    error raro ⇒ 'provider_transient_error' — байt a byte como antes;
 *  · turno OK ⇒ liquidar con el uso REAL (no la estimación);
 *  · gateway 'disabled' (proveedor jamás contactado) ⇒ LIBERAR, no liquidar;
 *  · gateway 'error' con uso parcial acumulado ⇒ liquidar ese parcial (antes se perdía);
 *  · la clave de facturación viaja desde el caller (wamid) y llega al openBudget.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RunAgentResult } from './types.js';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runSalesAgent, type SalesAgentDeps } from './salesAgent.js';
import type { ReservaDeIa } from '../entitlements/aiReservation.js';

const AGENT = { agentName: 'Asesora', businessName: 'Perfumería Test', greetingMessage: 'hola', botEnabled: true, profitMode: false, industry: 'perfumeria' };

function reservaEspia(over: Partial<ReservaDeIa> = {}) {
  const llamadas: { liquidar: Array<[{ inputTokens: number; outputTokens: number }, number]>; liberar: string[] } = { liquidar: [], liberar: [] };
  const reserva: ReservaDeIa = {
    clave: over.clave ?? 'ventas-wamid-test',
    cerrada: over.cerrada ?? false,
    liquidar: async (u, c) => { llamadas.liquidar.push([u, c]); return { aplicada: true }; },
    liberar: async (m) => { llamadas.liberar.push(m ?? ''); return { aplicada: true }; },
    ...over,
  };
  return { reserva, llamadas };
}

const okResult = (over: Partial<RunAgentResult> = {}): RunAgentResult => ({
  status: 'ok', model: 'm', latencyMs: 5, reply: 'Te recomiendo…',
  usage: { inputTokens: 900, outputTokens: 150 }, costUsd: 0.012, ...over,
});

function makeDeps(reserva: ReservaDeIa, over: Partial<SalesAgentDeps> = {}) {
  const claves: string[] = [];
  const deps: SalesAgentDeps = {
    openBudget: async (_t, clave, _est) => { claves.push(clave); return reserva; },
    runAgent: async () => okResult(),
    execTool: async () => ({ ok: true, result: {} }),
    ...over,
  };
  return { deps, claves };
}

describe('mapeo estructurado de razones (compatibilidad byte a byte)', () => {
  it('resource-exhausted ⇒ quota_exhausted (habilita la derivación honesta)', async () => {
    const { reserva } = reservaEspia();
    const { deps } = makeDeps(reserva, {
      openBudget: async () => { const e = new Error('sin cupo') as Error & { code: string }; e.code = 'resource-exhausted'; throw e; },
    });
    const out = await runSalesAgent({ tenantId: 'perfumeria', agentConfig: AGENT, messages: [{ role: 'user', content: 'hola' }], billingKey: 'ventas-w1' }, deps);
    expect(out).toEqual({ used: false, reason: 'quota_exhausted' });
  });

  it('failed-precondition ⇒ feature_unavailable; error sin código ⇒ provider_transient_error', async () => {
    const { reserva } = reservaEspia();
    const featureOff = makeDeps(reserva, {
      openBudget: async () => { const e = new Error('off') as Error & { code: string }; e.code = 'failed-precondition'; throw e; },
    });
    expect((await runSalesAgent({ tenantId: 't', agentConfig: AGENT, messages: [{ role: 'user', content: 'x' }] }, featureOff.deps)).reason).toBe('feature_unavailable');
    const infra = makeDeps(reserva, { openBudget: async () => { throw new Error('firestore caído'); } });
    expect((await runSalesAgent({ tenantId: 't', agentConfig: AGENT, messages: [{ role: 'user', content: 'x' }] }, infra.deps)).reason).toBe('provider_transient_error');
  });
});

describe('ciclo de la reserva por resultado del gateway', () => {
  it('turno OK ⇒ liquidar con el uso REAL y el costo del gateway', async () => {
    const { reserva, llamadas } = reservaEspia();
    const { deps, claves } = makeDeps(reserva);
    const out = await runSalesAgent({ tenantId: 't', agentConfig: AGENT, messages: [{ role: 'user', content: 'perfume dulce' }], billingKey: 'ventas-wamidX' }, deps);
    expect(out.used).toBe(true);
    expect(claves).toEqual(['ventas-wamidX']);
    expect(llamadas.liquidar).toEqual([[{ inputTokens: 900, outputTokens: 150 }, 0.012]]);
    expect(llamadas.liberar).toHaveLength(0);
  });

  it('gateway disabled (proveedor jamás contactado) ⇒ liberar, jamás liquidar', async () => {
    const { reserva, llamadas } = reservaEspia();
    const { deps } = makeDeps(reserva, { runAgent: async () => okResult({ status: 'disabled', reply: undefined, usage: undefined, costUsd: undefined }) });
    const out = await runSalesAgent({ tenantId: 't', agentConfig: AGENT, messages: [{ role: 'user', content: 'x' }] }, deps);
    expect(out).toEqual({ used: false, reason: 'configuration_error' });
    expect(llamadas.liberar).toHaveLength(1);
    expect(llamadas.liquidar).toHaveLength(0);
  });

  it('gateway error CON uso parcial acumulado ⇒ se liquida el parcial (antes se perdía)', async () => {
    const { reserva, llamadas } = reservaEspia();
    const { deps } = makeDeps(reserva, {
      runAgent: async () => okResult({ status: 'error', reply: undefined, usage: { inputTokens: 400, outputTokens: 0 }, costUsd: 0.0004, errorCode: 'http_529' }),
    });
    const out = await runSalesAgent({ tenantId: 't', agentConfig: AGENT, messages: [{ role: 'user', content: 'x' }] }, deps);
    expect(out).toEqual({ used: false, reason: 'provider_transient_error' });
    expect(llamadas.liquidar).toEqual([[{ inputTokens: 400, outputTokens: 0 }, 0.0004]]);
    expect(llamadas.liberar).toHaveLength(0);
  });

  it('reserva CERRADA (clave ya facturada por una re-entrega) ⇒ no llama al proveedor', async () => {
    const { reserva } = reservaEspia({ cerrada: true });
    const gateway = vi.fn(async () => okResult());
    const { deps } = makeDeps(reserva, { runAgent: gateway });
    const out = await runSalesAgent({ tenantId: 't', agentConfig: AGENT, messages: [{ role: 'user', content: 'x' }] }, deps);
    expect(out.used).toBe(false);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('la falla del metering al liquidar NO rompe la respuesta al cliente', async () => {
    const { reserva } = reservaEspia({ liquidar: async () => { throw new Error('firestore caído'); } });
    const { deps } = makeDeps(reserva);
    const out = await runSalesAgent({ tenantId: 't', agentConfig: AGENT, messages: [{ role: 'user', content: 'x' }] }, deps);
    expect(out.used).toBe(true); // la respuesta sale igual
  });
});
