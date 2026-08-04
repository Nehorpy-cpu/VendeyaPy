import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §2 — LA REANUDACIÓN DE COBERTURA TRABAJA SOBRE EL CANAL DEL REQUEST.
 * ==============================================================================
 * El worker de reanudación es el que MÁS daño hace si se equivoca de sesión: lee el carrito y
 * CREA EL PEDIDO con él. Leyendo `sessions/active` desde un request que nació en otro número, el
 * cliente recibe un pedido armado con el carrito de la conversación equivocada — con precios,
 * cantidades y productos que nunca pidió por ahí— y encima con instrucciones bancarias.
 *
 * El canal no se recalcula en el job (eso cuesta lecturas y vuelve a divergir): se PERSISTE en el
 * `coverageRequest` cuando el turno lo crea, y el job lo copia. Un request/job SIN el campo —todos
 * los que existen hoy— es del canal heredado, y ese fallback es EXPLÍCITO y está probado acá.
 */
const docs = new Map<string, Record<string, unknown>>();
const escribir = (path: string, data: Record<string, unknown>, merge: boolean) => {
  const base: Record<string, unknown> = merge ? { ...(docs.get(path) ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) base[k] = v;
  docs.set(path, base);
};
const refFor = (path: string) => ({
  path,
  get: async () => ({ exists: docs.has(path), ref: refFor(path), data: () => docs.get(path) }),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
});

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => ({ exists: docs.has(ref.path), ref: refFor(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: { path: string }, d: Record<string, unknown>) => escribir(ref.path, d, false),
        update: (ref: { path: string }, d: Record<string, unknown>) => escribir(ref.path, d, true),
        create: () => undefined,
      }),
  }),
  paths: {
    session: (t: string, c: string, s: string) => `tenants/${t}/customers/${c}/sessions/${s}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    order: (t: string, o: string) => `tenants/${t}/orders/${o}`,
    notifications: (t: string) => `tenants/${t}/notifications`,
  },
}));
vi.mock('../messaging/whatsappClient.js', () => ({ getWhatsAppClient: vi.fn() }));
vi.mock('./messages.js', () => ({ appendMessage: vi.fn(async () => undefined) }));
vi.mock('../audit/audit.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

import { canalDeCoberturaPersistido, reactivarResumeTrasLiberacion } from './coverageResume.js';

const TENANT = 't1';
const CLIENTE = '595000001234';
const REQ = 'covr_1';
const CANAL_HEREDADO = `tenants/${TENANT}/customers/${CLIENTE}/sessions/active`;
const CANAL_NUEVO = `tenants/${TENANT}/customers/${CLIENTE}/sessions/wa_444555666`;

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
});

describe('canalDeCoberturaPersistido — el canal viaja en el documento, no se recalcula', () => {
  it('el job manda cuando lo trae', () => {
    expect(canalDeCoberturaPersistido({ sessionKey: 'wa_444555666' }, { sessionKey: 'active' })).toBe('wa_444555666');
  });

  it('sin el campo en el job se cae al request', () => {
    expect(canalDeCoberturaPersistido({}, { sessionKey: 'wa_444555666' })).toBe('wa_444555666');
  });

  it('sin el campo en ninguno de los dos: canal HEREDADO, explícito', () => {
    expect(canalDeCoberturaPersistido({}, {})).toBe('active');
    expect(canalDeCoberturaPersistido(null, null)).toBe('active');
  });

  it('una clave que no sirve como id de documento no puede escribir en otra colección', () => {
    expect(canalDeCoberturaPersistido({ sessionKey: '../../otro' }, null)).toBe('active');
  });
});

describe('reactivarResumeTrasLiberacion — mira el puntero del canal liberado', () => {
  function sembrar(canalConPuntero: string): void {
    docs.set(`tenants/${TENANT}/config/checkout`, { coverage: { enabled: true, activationId: 'act-000001' } });
    docs.set(canalConPuntero, { context: { coverage: { requestId: REQ, status: 'coverage_approved' } } });
    docs.set(`tenants/${TENANT}/coverageResumeJobs/${REQ}`, {
      id: REQ, tenantId: TENANT, customerId: CLIENTE, coverageRequestId: REQ,
      action: 'approved', status: 'held_by_seller', activationId: 'act-000001',
    });
    docs.set(`tenants/${TENANT}/coverageRequests/${REQ}`, {
      id: REQ, tenantId: TENANT, customerId: CLIENTE, status: 'coverage_approved', decision: { action: 'approved' },
    });
  }

  it('liberar el canal nuevo re-encola el job que estaba retenido EN ESE canal', async () => {
    sembrar(CANAL_NUEVO);

    await expect(reactivarResumeTrasLiberacion(TENANT, CLIENTE, 'wa_444555666')).resolves.toBe(true);
    expect((docs.get(`tenants/${TENANT}/coverageResumeJobs/${REQ}`) as { status: string }).status).toBe('pending');
  });

  it('liberar el canal heredado no re-encola un job que pertenece al canal nuevo', async () => {
    sembrar(CANAL_NUEVO);
    docs.set(CANAL_HEREDADO, { context: {} });

    await expect(reactivarResumeTrasLiberacion(TENANT, CLIENTE, 'active')).resolves.toBe(false);
    expect((docs.get(`tenants/${TENANT}/coverageResumeJobs/${REQ}`) as { status: string }).status).toBe('held_by_seller');
  });
});
