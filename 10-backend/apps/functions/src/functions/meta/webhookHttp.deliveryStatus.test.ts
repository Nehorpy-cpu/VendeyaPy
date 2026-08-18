import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0021 §1 y §2 — EL PRODUCTOR DEL INBOX CIERRA EL CIRCUITO DE LOS RECIBOS Y EL PERFIL.
 * =========================================================================================
 * Hasta este programa el parser ya extraía `deliveryStatuses` y `profileName`, y `process.ts` ya
 * sabía consumirlos — pero `planWebhookWrites` no escribía NADA con ellos: un webhook de solo
 * statuses producía cero escrituras y el tick jamás llegaba a la burbuja. Este archivo fija:
 *
 *  1. PLAN: cada recibo va a `metaWebhookInbox` como payload namespaceado `{ statuses: [...] }`
 *     SIN `payload.from` (mismo fail-safe pasivo que el echo: aunque el gate desapareciera, un
 *     recibo jamás podría procesarse como mensaje del cliente), con clave de idempotencia
 *     determinística por (wamid, estado) y `automationEligible: false`.
 *  2. PLAN: el payload del mensaje persistido lleva `profileName` cuando el parser lo asoció.
 *  3. E2E del camino REAL del inbox: lo que el plan escribe, `processWebhookEvent` lo consume y
 *     el tick avanza — determinístico, cero motor, cero metering (verify-ai-reservation §7).
 */

const docs = new Map<string, Record<string, unknown>>();

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
    } else {
      base[k] = v;
    }
  }
  docs.set(path, base);
}

const refFor = (path: string) => ({
  id: path.split('/').pop() ?? '',
  path,
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
  create: async (d: Record<string, unknown>) => {
    if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
    docs.set(path, { ...d });
  },
});

vi.mock('../../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => ({
      doc: (id?: string) => refFor(`${path}/${id ?? 'auto'}`),
      where: (field: string, _op: string, value: unknown) => ({
        limit: (n: number) => ({
          get: async () => {
            const hijos = [...docs.entries()]
              .filter(([p, d]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/') && d[field] === value)
              .slice(0, n)
              .map(([p, d]) => ({ id: p.split('/').pop(), ref: refFor(p), data: () => d }));
            return { empty: hijos.length === 0, docs: hijos };
          },
        }),
      }),
    }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        update: (ref: { update: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => void ref.update(d),
        set: (ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => Promise<void> }, d: Record<string, unknown>, o?: { merge?: boolean }) => void ref.set(d, o),
      }),
  }),
  storage: () => ({}),
  paths: {
    metaWebhookInbox: () => 'metaWebhookInbox',
    metaWebhookEvent: (id: string) => `metaWebhookInbox/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
    session: (t: string, c: string, k = 'active') => `tenants/${t}/customers/${c}/sessions/${k}`,
  },
}));

vi.mock('../../conversation/coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));
const handleMessage = vi.fn(async () => ({ reply: '', state: 'IDLE', handledByHuman: false, coverageActivationId: null }));
vi.mock('../../conversation/engine.js', () => ({ handleMessage: (...a: unknown[]) => handleMessage(...(a as [])) }));
vi.mock('../../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: vi.fn(async () => ({ reply: '', inerte: true, coverageActivationId: null })),
  coberturaVigente: vi.fn(async () => true),
}));
vi.mock('../../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async () => ({ ok: true, outcome: 'accepted', id: 'wamid.out', viaMock: false })),
    sendLocationRequest: vi.fn(async () => ({ ok: true, id: 'wamid.lr' })),
  })),
}));
const incrementMessageUsage = vi.fn(async () => undefined);
vi.mock('../../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: vi.fn(async () => ({ allowed: true })),
  incrementMessageUsage: (...a: unknown[]) => incrementMessageUsage(...(a as [])),
}));
vi.mock('../../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));
vi.mock('../../meta/attachmentLimits.js', () => ({
  getAttachmentIngestPolicy: vi.fn(async () => ({ enabled: true, limits: { maxBytes: 5_000_000, allowedMimeTypes: ['image/jpeg'] } })),
}));
vi.mock('../../meta/attachmentIngest.js', () => ({
  ingestInboundAttachment: vi.fn(async () => ({ attachmentId: 'a', messageId: 'm', ingestState: 'stored' as const, duplicate: false, reply: '', reason: null, attachment: null })),
  recordUnsupportedInbound: vi.fn(async () => ({ messageId: 'm', reply: '' })),
  recordAttachmentIngestDisabled: vi.fn(async () => ({ messageId: 'm', reply: '' })),
}));

import { planWebhookWrites } from './webhookHttp.js';
import { parseMetaWebhookPayload } from '../../meta/parseWebhook.js';
import { processWebhookEvent } from '../../meta/process.js';

const TENANT = 'tnt_e2e_recibos';
const CLIENTE = '595991234567';
const PNID = 'PNID_REAL';
const metadata = { display_phone_number: '595990000001', phone_number_id: PNID };

const cambio = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA_ID', changes: [{ field, value }] }],
});

const statusBody = (over: Record<string, unknown> = {}) =>
  cambio('messages', {
    metadata,
    statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1754200400', recipient_id: CLIENTE, ...over }],
  });

const mensajeConContacto = () =>
  cambio('messages', {
    metadata,
    contacts: [{ wa_id: CLIENTE, profile: { name: 'Coti Fernández' } }],
    messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }],
  });

const plan = (body: unknown, nowMs = 1_754_200_000_000) => planWebhookWrites(parseMetaWebhookPayload(body), nowMs);

beforeEach(() => {
  docs.clear();
  handleMessage.mockClear();
  incrementMessageUsage.mockClear();
});

describe('planWebhookWrites — los recibos de entrega llegan al inbox (ADR-0021 §1)', () => {
  it('un webhook de solo-statuses YA NO produce cero escrituras: va al inbox namespaceado', () => {
    const writes = plan(statusBody());
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w.collection).toBe('metaWebhookInbox');
    expect(w.kind).toBe('message'); // canal `messages`: process lo rutea a su camino de recibos
    const payload = w.event.payload as Record<string, unknown>;
    // FAIL-SAFE PASIVO (mismo diseño que el echo): sin `payload.from`, un recibo jamás puede
    // procesarse como mensaje del cliente aunque el gate de contenido desapareciera.
    expect('from' in payload).toBe(false);
    expect(payload['statuses']).toEqual([
      { waMessageId: 'wamid.OUT1', status: 'delivered', timestampSeconds: 1754200400, recipientId: CLIENTE, receivedVia: PNID },
    ]);
    expect(w.event.automationEligible).toBe(false); // un recibo no dispara negocio
    expect(w.event.externalId).toBe(PNID); // resuelve tenant por el índice, como todo el inbox
  });

  it('idempotencia determinística por (wamid, estado): mismo recibo ⇒ misma clave; transiciones distintas ⇒ claves distintas', () => {
    const [delivered1] = plan(statusBody());
    const [delivered2] = plan(statusBody());
    const [read] = plan(statusBody({ status: 'read' }));
    const [otroWamid] = plan(statusBody({ id: 'wamid.OUT2' }));
    expect(delivered1!.docId).toBeTruthy();
    expect(delivered1!.docId).toBe(delivered2!.docId); // la redelivery de Meta muere como duplicado
    expect(delivered1!.docId).not.toBe(read!.docId);
    expect(delivered1!.docId).not.toBe(otroWamid!.docId);
  });

  it('la clave del recibo no colisiona con el doc del MENSAJE saliente ni con un inbound del mismo wamid', () => {
    const [recibo] = plan(statusBody());
    const [mensaje] = plan(cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.OUT1', timestamp: '1', type: 'text', text: { body: 'x' } }] }));
    expect(recibo!.docId).not.toBe(mensaje!.docId);
  });

  it('un lote combinado (mensaje + status) produce las DOS escrituras, mensaje primero', () => {
    const body = cambio('messages', {
      metadata,
      contacts: [{ wa_id: CLIENTE, profile: { name: 'Coti' } }],
      messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }],
      statuses: [{ id: 'wamid.OUT1', status: 'read', timestamp: '1754200400', recipient_id: CLIENTE }],
    });
    const writes = plan(body);
    expect(writes).toHaveLength(2);
    expect((writes[0]!.event.payload as Record<string, unknown>)['from']).toBe(CLIENTE);
    expect((writes[1]!.event.payload as Record<string, unknown>)['statuses']).toBeDefined();
  });
});

describe('planWebhookWrites — profileName en el payload del mensaje (ADR-0021 §2)', () => {
  it('el mensaje persistido lleva el profileName que el parser asoció por wa_id', () => {
    const [w] = plan(mensajeConContacto());
    expect((w!.event.payload as Record<string, unknown>)['profileName']).toBe('Coti Fernández');
  });

  it('sin contacts, el payload queda EXACTAMENTE como antes (sin la clave)', () => {
    const [w] = plan(cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1', type: 'text', text: { body: 'hola' } }] }));
    expect('profileName' in (w!.event.payload as Record<string, unknown>)).toBe(false);
  });
});

describe('E2E del camino REAL del inbox: lo que el productor escribe, process lo consume', () => {
  const P_CLIENTE = `tenants/${TENANT}/customers/${CLIENTE}`;

  const sembrar = () => {
    // Binding PNID → tenant (el índice que usa process) + número con permiso real.
    docs.set(`metaExternalIndex/whatsapp_${PNID}`, { tenantId: TENANT });
    docs.set(`tenants/${TENANT}/metaAssets/${PNID}`, { externalId: PNID, status: 'active', automationMode: 'live' });
    // La burbuja saliente que espera su tick.
    docs.set(`${P_CLIENTE}/messages/m_out`, {
      id: 'm_out', tenantId: TENANT, customerId: CLIENTE, direction: 'out', author: 'bot',
      text: 'hola', waMessageId: 'wamid.OUT1', deliveryStatus: 'pending',
    });
  };

  /** Persiste el plan tal como lo haría el handler (create con el docId decidido) y procesa. */
  const entregarYProcesar = async (body: unknown) => {
    for (const w of plan(body)) {
      const path = `${w.collection}/${w.docId}`;
      if (!docs.has(path)) docs.set(path, { ...(w.event as unknown as Record<string, unknown>), id: w.docId });
      await processWebhookEvent(w.docId!);
    }
  };

  it('HOY ROJO SIN EL PRODUCTOR: el recibo entra por el webhook, viaja por el inbox y el tick avanza', async () => {
    sembrar();
    await entregarYProcesar(statusBody());

    const burbuja = docs.get(`${P_CLIENTE}/messages/m_out`) as Record<string, unknown>;
    expect(burbuja['deliveryStatus']).toBe('delivered');
    // Determinístico y cero costo (verify-ai-reservation §7): ni motor ni metering.
    expect(handleMessage).not.toHaveBeenCalled();
    expect(incrementMessageUsage).not.toHaveBeenCalled();
  });

  it('la redelivery del mismo recibo re-procesada es un no-op (monotonía) y el evento cierra processed', async () => {
    sembrar();
    await entregarYProcesar(statusBody());
    await entregarYProcesar(statusBody()); // mismo docId: el evento ya existe; re-procesarlo no retrocede nada

    const burbuja = docs.get(`${P_CLIENTE}/messages/m_out`) as Record<string, unknown>;
    expect(burbuja['deliveryStatus']).toBe('delivered');
    const eventos = [...docs.entries()].filter(([p]) => p.startsWith('metaWebhookInbox/'));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]![1]['processingStatus']).toBe('processed');
  });

  it('el profileName viaja del webhook al doc del cliente por el mismo camino', async () => {
    sembrar();
    docs.set(P_CLIENTE, { id: CLIENTE, tenantId: TENANT, name: 'Nombre CRM' });
    await entregarYProcesar(mensajeConContacto());

    const cliente = docs.get(P_CLIENTE) as Record<string, unknown>;
    expect(cliente['profileName']).toBe('Coti Fernández');
    expect(cliente['name']).toBe('Nombre CRM');
  });
});
