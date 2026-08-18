import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0021 — RECIBOS DE ENTREGA Y PERFIL HONESTO EN EL PROCESADOR DEL INBOX.
 * ===========================================================================
 * 1. §1 — Un evento del inbox cuyo payload trae `statuses[]` (recibos del proveedor) se procesa
 *    por un camino DETERMINÍSTICO propio: cero motor, cero IA, cero metering. Cada recibo se
 *    aplica por separado y un recibo malo NO tumba el lote ni afecta mensajes.
 * 2. §2 — Un mensaje entrante cuyo parseo trae `profileName` lo persiste en el doc del cliente
 *    SOLO si cambió: merge honesto que jamás pisa `name` (dato CRM confirmado) y que no escribe
 *    nada cuando el valor es igual al vigente.
 */

const docs = new Map<string, Record<string, unknown>>();
const enviados: Array<{ to: string; text: string }> = [];
/** Path de cliente ENVENENADO: su consulta de mensajes lanza (simula un fallo de Firestore). */
const CLIENTE_VENENO = '595000009999';

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

/** Escrituras al DOC del cliente (no a sus subcolecciones): mide el "sin escritura si es igual". */
let escriturasAlCliente = 0;

const refFor = (path: string) => ({
  id: path.split('/').pop() ?? '',
  path,
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => {
    if (/\/customers\/[^/]+$/.test(path)) escriturasAlCliente++;
    escribir(path, d, o?.merge === true);
  },
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
  create: async (d: Record<string, unknown>) => {
    if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
    docs.set(path, { ...d });
  },
});

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => ({
      doc: (id?: string) => refFor(`${path}/${id ?? 'auto'}`),
      where: (field: string, _op: string, value: unknown) => ({
        limit: (n: number) => ({
          get: async () => {
            if (path.includes(`/customers/${CLIENTE_VENENO}/`)) throw new Error('firestore caído');
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
  paths: {
    metaWebhookEvent: (id: string) => `metaWebhookInbox/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
    session: (t: string, c: string, k = 'active') => `tenants/${t}/customers/${c}/sessions/${k}`,
  },
}));

vi.mock('../conversation/coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));

const handleMessage = vi.fn(async () => ({
  reply: '',
  state: 'IDLE',
  handledByHuman: false,
  coverageActivationId: null,
}));
vi.mock('../conversation/engine.js', () => ({ handleMessage: (...a: unknown[]) => handleMessage(...(a as [])) }));
vi.mock('../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: vi.fn(async () => ({ reply: '', inerte: true, coverageActivationId: null })),
  coberturaVigente: vi.fn(async () => true),
}));
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async (to: string, text: string) => {
      enviados.push({ to, text });
      return { ok: true, outcome: 'accepted', id: 'wamid.out.1', viaMock: false };
    }),
    sendLocationRequest: vi.fn(async () => ({ ok: true, id: 'wamid.lr' })),
  })),
}));
const incrementMessageUsage = vi.fn(async () => undefined);
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: vi.fn(async () => ({ allowed: true })),
  incrementMessageUsage: (...a: unknown[]) => incrementMessageUsage(...(a as [])),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));
vi.mock('./attachmentLimits.js', () => ({
  getAttachmentIngestPolicy: vi.fn(async () => ({ enabled: true, limits: { maxBytes: 5_000_000, allowedMimeTypes: ['image/jpeg'] } })),
}));
vi.mock('./attachmentIngest.js', () => ({
  ingestInboundAttachment: vi.fn(async () => ({ attachmentId: 'a', messageId: 'm', ingestState: 'stored' as const, duplicate: false, reply: '', reason: null, attachment: null })),
  recordUnsupportedInbound: vi.fn(async () => ({ messageId: 'm', reply: '' })),
  recordAttachmentIngestDisabled: vi.fn(async () => ({ messageId: 'm', reply: '' })),
}));

import { processWebhookEvent } from './process.js';

const TENANT = 'tnt_recibos1';
const TEL = '595991234567';
const EVENTO = 'whatsapp_status_1';
const P_EVENTO = `metaWebhookInbox/${EVENTO}`;
const P_CLIENTE = `tenants/${TENANT}/customers/${TEL}`;
const P_BURBUJA_OUT = `${P_CLIENTE}/messages/m_out`;

const evento = (payload: Record<string, unknown>) => {
  docs.set(P_EVENTO, {
    id: EVENTO,
    platform: 'whatsapp',
    externalId: 'PNID_1',
    tenantId: TENANT,
    processingStatus: 'received',
    payload,
  });
};

const reciboDelivered = (extra: Record<string, unknown> = {}) => ({
  waMessageId: 'wamid.OUT1',
  status: 'delivered',
  timestampSeconds: 1716750400,
  recipientId: TEL,
  receivedVia: 'PNID_1',
  ...extra,
});

const burbujaSaliente = () => {
  docs.set(P_BURBUJA_OUT, {
    id: 'm_out', tenantId: TENANT, customerId: TEL, direction: 'out', author: 'bot',
    text: 'hola', waMessageId: 'wamid.OUT1', deliveryStatus: 'pending',
  });
};

const estadoEvento = () => (docs.get(P_EVENTO) as Record<string, unknown>)['processingStatus'];
const burbuja = () => docs.get(P_BURBUJA_OUT) as Record<string, unknown>;

beforeEach(() => {
  docs.clear();
  enviados.length = 0;
  escriturasAlCliente = 0;
  handleMessage.mockClear();
  incrementMessageUsage.mockClear();
  // Número con permiso real: el camino de MENSAJES lo exige (los recibos no dependen del gate).
  docs.set(`tenants/${TENANT}/metaAssets/PNID_1`, { externalId: 'PNID_1', status: 'active', automationMode: 'live' });
});

describe('recibos de entrega en el inbox (ADR-0021 §1)', () => {
  it('evento SOLO-recibos: aplica el recibo, cierra processed, y NO toca motor ni metering', async () => {
    burbujaSaliente();
    evento({ statuses: [reciboDelivered()] });
    await processWebhookEvent(EVENTO);

    expect(estadoEvento()).toBe('processed');
    expect(burbuja()['deliveryStatus']).toBe('delivered');
    expect(handleMessage).not.toHaveBeenCalled(); // cero IA
    expect(incrementMessageUsage).not.toHaveBeenCalled(); // cero cuota
    expect(enviados).toHaveLength(0);
  });

  it('recibo HUÉRFANO (mensaje viaMock o histórico): no-op suave, el evento cierra processed igual', async () => {
    evento({ statuses: [reciboDelivered({ waMessageId: 'wamid.NUNCA_PERSISTIDO' })] });
    await processWebhookEvent(EVENTO);

    expect(estadoEvento()).toBe('processed');
    // No fabricó ninguna burbuja ni doc de cliente por el recibo.
    expect([...docs.keys()].filter((p) => p.startsWith(`${P_CLIENTE}/messages/`))).toHaveLength(0);
  });

  it('un recibo MALO no tumba el lote: el resto se aplica y el evento no cae a failed', async () => {
    burbujaSaliente();
    evento({
      statuses: [
        reciboDelivered({ recipientId: CLIENTE_VENENO }), // su consulta LANZA
        reciboDelivered(), // este tiene que aplicarse igual
      ],
    });
    await processWebhookEvent(EVENTO);

    expect(estadoEvento()).toBe('processed');
    expect(burbuja()['deliveryStatus']).toBe('delivered');
  });

  it('recibos que viajan JUNTO a un mensaje: el mensaje se procesa primero y el recibo se aplica igual', async () => {
    burbujaSaliente();
    evento({ from: TEL, text: 'gracias!', messageId: 'wamid.IN9', statuses: [reciboDelivered()] });
    await processWebhookEvent(EVENTO);

    expect(estadoEvento()).toBe('processed');
    expect(handleMessage).toHaveBeenCalledTimes(1); // el turno del mensaje corrió normal
    expect(burbuja()['deliveryStatus']).toBe('delivered'); // y el recibo también se aplicó
  });
});

describe('profileName del webhook en el doc del cliente (ADR-0021 §2)', () => {
  const mensajeCon = (profileName: string) => ({
    from: TEL, text: 'hola', messageId: 'wamid.IN1', profileName,
  });

  it('un entrante con profileName lo persiste SIN pisar el `name` CRM', async () => {
    docs.set(P_CLIENTE, { id: TEL, tenantId: TENANT, name: 'Constanza (VIP)' });
    evento(mensajeCon('Coti 🌸'));
    await processWebhookEvent(EVENTO);

    const cliente = docs.get(P_CLIENTE) as Record<string, unknown>;
    expect(cliente['profileName']).toBe('Coti 🌸');
    expect(cliente['name']).toBe('Constanza (VIP)'); // el dato CRM confirmado no se toca
    expect(estadoEvento()).toBe('processed');
  });

  it('si el profileName NO cambió, no hay escritura del doc del cliente', async () => {
    docs.set(P_CLIENTE, { id: TEL, tenantId: TENANT, profileName: 'Coti 🌸' });
    evento(mensajeCon('Coti 🌸'));
    escriturasAlCliente = 0;
    await processWebhookEvent(EVENTO);

    expect(escriturasAlCliente).toBe(0);
    expect(estadoEvento()).toBe('processed');
  });

  it('si cambió, se actualiza (el cliente renombró su perfil de WhatsApp)', async () => {
    docs.set(P_CLIENTE, { id: TEL, tenantId: TENANT, profileName: 'Coti 🌸' });
    evento(mensajeCon('Constanza F.'));
    await processWebhookEvent(EVENTO);

    expect((docs.get(P_CLIENTE) as Record<string, unknown>)['profileName']).toBe('Constanza F.');
  });

  it('un entrante SIN profileName no escribe nada extra en el cliente', async () => {
    evento({ from: TEL, text: 'hola', messageId: 'wamid.IN2' });
    escriturasAlCliente = 0;
    await processWebhookEvent(EVENTO);

    expect(escriturasAlCliente).toBe(0);
    expect(docs.get(P_CLIENTE)).toBeUndefined();
  });
});
