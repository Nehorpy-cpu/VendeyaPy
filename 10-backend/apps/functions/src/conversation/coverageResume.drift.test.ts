import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ADR-0015 §8 — REANUDACIÓN DE COBERTURA CON EL PEDIDO YA CREADO.
 * ==============================================================
 * La rama de REUSO (`orderSnap.exists`) saltea `createPendingOrder` y, por lo tanto, el único
 * freno por deriva que existía. El escenario real: la orden nace de madrugada sin deriva, el job
 * se corta (kill-switch a mitad o crash), la corrida de verificación de la tarde marca el producto
 * `drifted_external` y la reanudación de la noche mandaba los datos bancarios y el total de un
 * precio público que ya no podemos afirmar. Igual desenlace si el job reintenta tras un fallo.
 *
 * Acá se ejercita el ciclo COMPLETO del worker contra un Firestore en memoria: claim → liberación
 * → orden reusada → (freno) → outbox. Lo que se prueba es el desenlace observable: si no podemos
 * confirmar el dato público, NO sale un solo mensaje con banco ni total, el job queda retenido
 * para una persona y la campana explica la razón REAL.
 */

const docs = new Map<string, Record<string, unknown>>();
const enviados: Array<{ to: string; text: string }> = [];

const esPlano = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { toMillis?: unknown }).toMillis !== 'function';

/** Escritura con soporte de rutas punteadas ('context.humanTakeover') y merge superficial. */
function escribir(path: string, data: Record<string, unknown>, merge: boolean): void {
  const base: Record<string, unknown> = merge ? { ...(docs.get(path) ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (k.includes('.')) {
      const partes = k.split('.');
      let cur = base;
      for (const p of partes.slice(0, -1)) {
        cur[p] = { ...((cur[p] as Record<string, unknown>) ?? {}) };
        cur = cur[p] as Record<string, unknown>;
      }
      cur[partes[partes.length - 1]!] = v;
    } else if (merge && esPlano(v) && esPlano(base[k])) {
      base[k] = { ...(base[k] as Record<string, unknown>), ...v };
    } else {
      base[k] = v;
    }
  }
  docs.set(path, base);
}
const refFor = (path: string) => ({
  path,
  get: async () => snapFor(path),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
  create: async (d: Record<string, unknown>) => {
    if (docs.has(path)) {
      const e = new Error('already exists') as Error & { code?: number };
      e.code = 6;
      throw e;
    }
    escribir(path, d, false);
  },
});
const snapFor = (path: string) => ({ exists: docs.has(path), ref: refFor(path), data: () => docs.get(path) });

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => snapFor(ref.path),
        set: (ref: { path: string }, d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(ref.path, d, o?.merge === true),
        update: (ref: { path: string }, d: Record<string, unknown>) => escribir(ref.path, d, true),
        create: (ref: { path: string }, d: Record<string, unknown>) => {
          if (docs.has(ref.path)) throw new Error('already exists');
          escribir(ref.path, d, false);
        },
      }),
  }),
  paths: {
    session: (t: string, c: string) => `tenants/${t}/customers/${c}/sessions/active`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    order: (t: string, o: string) => `tenants/${t}/orders/${o}`,
    notifications: (t: string) => `tenants/${t}/notifications`,
  },
}));
vi.mock('./messages.js', () => ({ appendMessage: vi.fn(async () => undefined) }));
vi.mock('../audit/audit.js', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('./coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async (to: string, text: string) => {
      enviados.push({ to, text });
      return { ok: true, outcome: 'accepted', id: 'wamid.out', viaMock: false };
    }),
  })),
}));
vi.mock('../orders/checkoutConfig.js', async (io) => {
  const real = await io<typeof import('../orders/checkoutConfig.js')>();
  return { ...real, getCheckoutConfig: vi.fn(async () => CONFIG_CHECKOUT) };
});
vi.mock('../orders/createPendingOrder.js', async (io) => {
  const real = await io<typeof import('../orders/createPendingOrder.js')>();
  return { ...real, createPendingOrder: vi.fn(async () => { throw new Error('no debería crearse una orden nueva'); }) };
});

import { processCoverageResumeJob } from './coverageResume.js';
import { setDriftProjection, type ProductDriftSnapshot } from '../catalog/driftGuard.js';
import { createPendingOrder } from '../orders/createPendingOrder.js';

const TENANT = 't1';
const TEL = '595000005678';
const REQ = 'covr_1';
const ORDER = 'ord_1';
const ACT = 'actTest01';

const CONFIG_CHECKOUT = {
  bankAccounts: [{ bank: 'Banco T', accountNumber: '1-1', holder: 'H', document: 'D' }],
  sellers: [],
  coverage: { enabled: true, activationId: ACT },
} as unknown as import('@vpw/shared').CheckoutConfig;

const P_CONFIG = `tenants/${TENANT}/config/checkout`;
const P_JOB = `tenants/${TENANT}/coverageResumeJobs/${REQ}`;
const P_REQ = `tenants/${TENANT}/coverageRequests/${REQ}`;
const P_ORDER = `tenants/${TENANT}/orders/${ORDER}`;
const P_SESSION = `tenants/${TENANT}/customers/${TEL}/sessions/active`;
const P_NOTIF_DRIFT = `tenants/${TENANT}/notifications/covdrift-${TEL}-${REQ}`;
const P_OUTBOX = `tenants/${TENANT}/coverageMessageOutbox/${REQ}_approved_atm_1`;

const TODOS_LOS_CAMPOS = ['title', 'description', 'price', 'currency', 'availability', 'inventory'];
const cablear = (over: Partial<ProductDriftSnapshot> = {}) =>
  setDriftProjection({
    activa: async () => true,
    snapshots: async (_t, ids) =>
      ids.map((productId) => ({ productId, externalFields: TODOS_LOS_CAMPOS, state: 'drifted_external', driftedFields: ['price'], ...over }) as ProductDriftSnapshot),
  });

/** Estado exacto del escenario: aprobación decidida, orden YA creada y takeover de cobertura vivo. */
function sembrar(): void {
  escribir(P_CONFIG, { coverage: { enabled: true, activationId: ACT } }, false);
  escribir(P_JOB, {
    id: REQ,
    tenantId: TENANT,
    customerId: TEL,
    coverageRequestId: REQ,
    action: 'approved',
    status: 'pending',
    attempts: 0,
    activationId: ACT,
    channel: 'whatsapp',
    receivedVia: null,
    checkoutAttemptId: 'atm_1',
    orderId: ORDER,
    leaseUntil: null,
  }, false);
  escribir(P_REQ, {
    id: REQ,
    tenantId: TENANT,
    customerId: TEL,
    status: 'coverage_approved',
    decision: { action: 'approved', locationFingerprint: 'fp1' },
    locationFingerprint: 'fp1',
    location: { source: 'text', addressText: 'Av. Test 123', name: null, coordinates: null },
    receivedVia: null,
  }, false);
  escribir(P_ORDER, {
    id: ORDER,
    tenantId: TENANT,
    customerId: TEL,
    status: 'PENDING_PAYMENT',
    items: [{ productId: 'p1', productName: 'Aurora Nocturna', quantity: 1, unitPrice: 250000, subtotal: 250000 }],
    totals: { subtotal: 250000, discount: 0, shipping: 0, total: 250000 },
  }, false);
  escribir(P_SESSION, {
    id: 'active',
    tenantId: TENANT,
    customerId: TEL,
    state: 'CART',
    cart: { items: [{ productId: 'p1', name: 'Aurora Nocturna', price: 250000, quantity: 1 }], subtotal: 250000 },
    context: {
      humanTakeover: true,
      handoffReason: 'coverage_review',
      handoffSourceId: REQ,
      coverage: { requestId: REQ, status: 'pending_coverage_review' },
    },
  }, false);
}

const job = () => docs.get(P_JOB) as { status?: string } | undefined;
const pedido = () => docs.get(P_ORDER) as { status?: string } | undefined;
const sesion = () => docs.get(P_SESSION) as { state?: string } | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
  enviados.length = 0;
  delete process.env.FUNCTIONS_EMULATOR; // el fixture de pausa es solo-emulador
  sembrar();
});
afterEach(() => setDriftProjection(null));

describe('coverageResume — la reanudación NO manda datos bancarios de un precio que no podemos afirmar', () => {
  it('orden preexistente + deriva aparecida DESPUÉS ⇒ cero banco/total, job retenido y campana honesta', async () => {
    cablear(); // la verificación de la tarde marcó `drifted_external` en price
    await processCoverageResumeJob(TENANT, REQ);

    // 1) Ni un mensaje: nada de cuenta bancaria, nada de total.
    expect(enviados).toHaveLength(0);
    expect(docs.has(P_OUTBOX)).toBe(false);
    expect(JSON.stringify([...docs.values()])).not.toContain('Banco T');

    // 2) El pedido no se duplicó ni se tocó, y la sesión no pasó a AWAITING_PAYMENT.
    expect(vi.mocked(createPendingOrder)).not.toHaveBeenCalled();
    expect(pedido()?.status).toBe('PENDING_PAYMENT');
    expect(sesion()?.state).not.toBe('AWAITING_PAYMENT');

    // 3) El job queda para una persona (no se pierde ni se reintenta en loop).
    expect(job()?.status).toBe('held_by_seller');
    expect((docs.get(P_REQ) as { resume?: { status?: string } }).resume?.status).toBe('held_by_seller');

    // 4) La campana dice la razón REAL (precio publicado), SANEADA y sin importes.
    const notif = docs.get(P_NOTIF_DRIFT) as { title?: string; body?: string } | undefined;
    expect(notif).toBeDefined();
    expect(`${notif?.title} ${notif?.body}`).toMatch(/precio/i);
    expect(`${notif?.title} ${notif?.body}`).not.toMatch(/ya no está disponible/i);
    expect(`${notif?.title} ${notif?.body}`).not.toContain('250.000');
    expect(`${notif?.title} ${notif?.body}`).not.toContain(TEL);
  });

  it('FAIL-CLOSED: si la proyección no se puede LEER tampoco salen datos bancarios', async () => {
    // "No hay deriva" y "no pude leer si la hay" no son lo mismo cuando hay dinero en juego.
    setDriftProjection({ activa: async () => true, snapshots: async () => { throw new Error('firestore unavailable'); } });
    await processCoverageResumeJob(TENANT, REQ);
    expect(enviados).toHaveLength(0);
    expect(job()?.status).toBe('held_by_seller');
    expect(docs.get(P_NOTIF_DRIFT)).toBeDefined();
  });

  it('orden reservada SIN ítems legibles ⇒ tampoco se manda un total que no sabemos atribuir', async () => {
    cablear({ state: 'verified', driftedFields: [] }); // ni siquiera hay deriva: el problema es la orden
    escribir(P_ORDER, { items: [] }, true);
    await processCoverageResumeJob(TENANT, REQ);
    expect(enviados).toHaveLength(0);
    expect(job()?.status).toBe('held_by_seller');
    expect(docs.get(P_NOTIF_DRIFT)).toBeDefined();
  });

  it('sin deriva (reconciliado) la reanudación sigue mandando las instrucciones de pago (cero regresión)', async () => {
    cablear({ state: 'verified', driftedFields: [] });
    await processCoverageResumeJob(TENANT, REQ);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.text).toContain('Banco T');
    expect(enviados[0]?.text).toContain('250.000');
    expect(job()?.status).toBe('done');
    expect(sesion()?.state).toBe('AWAITING_PAYMENT');
  });

  it('sin proyección cableada (tenant sin gobierno externo) el worker queda EXACTAMENTE como estaba', async () => {
    await processCoverageResumeJob(TENANT, REQ);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.text).toContain('Banco T');
    expect(job()?.status).toBe('done');
  });
});
