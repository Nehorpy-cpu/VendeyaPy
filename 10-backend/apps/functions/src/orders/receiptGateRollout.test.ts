/**
 * orders/receiptGateRollout.test.ts — NIVEL B DEL ROLLOUT Y ATOMICIDAD CANDIDATO+CAMPANA
 * ========================================================================================
 * Cubre los tres pedazos del contrato que hoy no existen (ADR-0016 §10 y §11):
 *
 *  B1) `config/receiptGate.enabled` fail-closed y tenant-scoped: SOLO el booleano exacto `true`
 *      enciende. Con el flag en OFF el adjunto guardado queda `generic_media`, no hay candidato,
 *      no hay campana, `attachmentMarkAsReceipt` RECHAZA y `attachmentUnmarkReceipt` SIGUE
 *      funcionando (apagar una función no puede dejar atrapada una decisión humana).
 *  B2) El flag se RELEE DENTRO de la transacción: una lectura vieja no le gana a un apagado ya
 *      commiteado.
 *  B3) La promesa al cliente («un vendedor lo revisa») y la campana que la hace cierta se
 *      confirman JUNTAS, en la misma transacción, con id determinístico — o no se confirma
 *      ninguna.
 *  B4) Idempotencia: un reintento del mismo webhook produce COMO MÁXIMO un candidato y una
 *      campana. Y jamás `PAID`.
 *
 * El fake de transacción reproduce la semántica que importa: los writes se aplican TODOS JUNTOS al
 * final y si uno falla no se aplica ninguno. Sin eso, "atómico" sería una palabra en un comentario.
 */
import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Attachment, Order, OrderStatus } from '@vpw/shared';
import {
  linkReceiptCandidate,
  markAttachmentAsReceipt,
  readOrderReceiptAttachments,
  unmarkAttachmentReceipt,
  type ReceiptStoreDeps,
  type ReceiptTx,
} from './receiptStore.js';
import {
  DEFAULT_RECEIPT_GATE_CONFIG,
  mergeReceiptGateWithIngest,
  normalizeReceiptGateConfig,
  receiptGateEnabledFromRaw,
} from './receiptGate.js';
import { receiptCandidateNotificationId } from './receiptCandidateNotification.js';
import { mensajeDeMotivo } from '../functions/attachments/attachmentCallables.js';

const TENANT = 'tnt_demo';
const CLIENTE = '595981000111';
const ATT = 'att_0123456789abcdef01234567';
const NOW = Timestamp.fromMillis(1_700_000_000_000);
const AVISO = receiptCandidateNotificationId(ATT);

// ---------------------------------------------------------------------------
// Mundo en memoria con commit atómico
// ---------------------------------------------------------------------------

interface Mundo {
  attachments: Record<string, Attachment>;
  orders: Record<string, Order>;
  notifications: Record<string, Record<string, unknown>>;
  /** OFF por defecto a propósito: el fake también es fail-closed. */
  gateEnabled: boolean;
  /** Simula un Firestore que rechaza la creación de la campana (cuota, permisos, caída). */
  campanaRota: boolean;
  patches: Array<{ kind: 'attachment' | 'order' | 'notification'; id: string; patch: Record<string, unknown> }>;
  /** Cuántas veces se releyó el flag dentro de una transacción. */
  lecturasDelFlag: number;
}

const attachmentDoc = (over: Partial<Attachment> = {}): Attachment =>
  ({
    attachmentId: ATT,
    tenantId: TENANT,
    customerId: CLIENTE,
    ingestState: 'stored',
    classification: { value: 'unclassified', source: 'rule', confidence: 0, by: null, at: null },
    orderCandidateId: null,
    mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
    bytes: 90_000,
    ...over,
  }) as unknown as Attachment;

const orderDoc = (id: string, status: OrderStatus, over: Record<string, unknown> = {}): Order =>
  ({
    id,
    tenantId: TENANT,
    customerId: CLIENTE,
    status,
    createdAt: Timestamp.fromMillis(NOW.toMillis() - 60_000),
    ...over,
  }) as unknown as Order;

function aplicar(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split('.');
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = value;
  }
}

const mundo = (over: Partial<Mundo> = {}): Mundo => ({
  attachments: { [ATT]: attachmentDoc() },
  orders: { ord_1: orderDoc('ord_1', 'PENDING_PAYMENT') },
  notifications: {},
  gateEnabled: true,
  campanaRota: false,
  patches: [],
  lecturasDelFlag: 0,
  ...over,
});

function deps(m: Mundo): ReceiptStoreDeps {
  let cola: Promise<unknown> = Promise.resolve();
  return {
    now: () => NOW,
    runTransaction(tenantId, fn) {
      expect(tenantId).toBe(TENANT);
      const corrida = cola.then(() => ejecutar(m, fn));
      cola = corrida.catch(() => undefined);
      return corrida;
    },
  };
}

async function ejecutar<T>(m: Mundo, fn: (tx: ReceiptTx) => Promise<T>): Promise<T> {
  const escrituras: Array<() => void> = [];
  const anotados: typeof m.patches = [];
  const tx: ReceiptTx = {
    async getAttachment(id) {
      return m.attachments[id] ?? null;
    },
    async getOrder(id) {
      return m.orders[id] ?? null;
    },
    async isReceiptGateEnabled() {
      m.lecturasDelFlag += 1;
      return m.gateEnabled;
    },
    async hasNotification(id) {
      return m.notifications[id] !== undefined;
    },
    updateAttachment(id, patch) {
      anotados.push({ kind: 'attachment', id, patch });
      escrituras.push(() => aplicar(m.attachments[id] as unknown as Record<string, unknown>, patch));
    },
    updateOrder(id, patch) {
      anotados.push({ kind: 'order', id, patch });
      escrituras.push(() => aplicar(m.orders[id] as unknown as Record<string, unknown>, patch));
    },
    createNotification(id, data) {
      anotados.push({ kind: 'notification', id, patch: data });
      escrituras.push(() => {
        // La campana rota tiene que voltear TODA la transacción, no solo su propio write.
        if (m.campanaRota) throw Object.assign(new Error('firestore caído'), { code: 13 });
        if (m.notifications[id]) throw Object.assign(new Error('already exists'), { code: 6 });
        m.notifications[id] = data;
      });
    },
  };
  const out = await fn(tx);
  // Commit: o entran todos los writes o no entra ninguno.
  const snapshotAtt = JSON.stringify(m.attachments);
  const snapshotOrd = JSON.stringify(m.orders);
  try {
    for (const w of escrituras) w();
  } catch (e) {
    m.attachments = JSON.parse(snapshotAtt) as Record<string, Attachment>;
    m.orders = JSON.parse(snapshotOrd) as Record<string, Order>;
    throw e;
  }
  m.patches.push(...anotados);
  return out;
}

const sinPAID = (m: Mundo) => {
  for (const p of m.patches) expect(JSON.stringify(p.patch)).not.toMatch(/"PAID"/);
};

// ---------------------------------------------------------------------------
// B1 — el flag solo enciende con el booleano exacto `true`
// ---------------------------------------------------------------------------

describe('ADR-0016 §10 — nivel B: `config/receiptGate.enabled` es fail-closed', () => {
  it('SOLO el booleano exacto `true` enciende: la coerción laxa deja el gate APAGADO', () => {
    expect(receiptGateEnabledFromRaw({ enabled: true })).toBe(true);

    // Las formas que un flag de seguridad NUNCA puede aceptar: así es como termina encendido sin
    // que nadie lo haya decidido.
    for (const crudo of [
      undefined,
      null,
      {},
      { enabled: false },
      { enabled: 'true' },
      { enabled: 'TRUE' },
      { enabled: 1 },
      { enabled: '1' },
      { enabled: 'yes' },
      { enabled: [true] },
      { enabled: { value: true } },
      'true',
      1,
      true,
      [{ enabled: true }],
    ]) {
      expect(receiptGateEnabledFromRaw(crudo)).toBe(false);
    }
  });

  it('el doc AUSENTE y el default del código están en OFF (desplegar no enciende nada)', () => {
    expect(DEFAULT_RECEIPT_GATE_CONFIG.enabled).toBe(false);
    expect(normalizeReceiptGateConfig(undefined).enabled).toBe(false);
    expect(normalizeReceiptGateConfig({}).enabled).toBe(false);
    expect(normalizeReceiptGateConfig({ windowMinutes: 60 }).enabled).toBe(false);
    expect(normalizeReceiptGateConfig({ enabled: true }).enabled).toBe(true);
  });

  it('el nivel B es INDEPENDIENTE de los límites de ingesta: la intersección no lo enciende ni lo apaga', () => {
    const limites = { maxBytes: 1_000_000, allowedMimeTypes: ['image/jpeg'] as const };
    expect(mergeReceiptGateWithIngest(normalizeReceiptGateConfig({ enabled: true }), limites).enabled).toBe(true);
    expect(mergeReceiptGateWithIngest(normalizeReceiptGateConfig({}), limites).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2 — el flag se relee DENTRO de la transacción
// ---------------------------------------------------------------------------

describe('ADR-0016 §10 — el flag se relee DENTRO de la transacción', () => {
  it('gate OFF ⇒ ni candidato ni campana ni una sola escritura', async () => {
    const m = mundo({ gateEnabled: false });
    const r = await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));

    expect(r).toEqual({ ok: false, reason: 'receipt_gate_disabled' });
    expect(m.patches).toHaveLength(0);
    expect(m.notifications).toEqual({});
    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([]);
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');
  });

  /**
   * EL DISCRIMINANTE DE B2. La config se lee ANTES de la transacción (el gate la necesita para
   * evaluar ventana y formatos). Si alguien apaga el nivel B en ese intervalo, la config vieja dice
   * `enabled: true` y la fresca dice `false`: gana la FRESCA o el apagado no sirve para nada.
   */
  it('apagado a mitad de procesamiento: la config vieja dice ON, el flag fresco dice OFF ⇒ no se escribe', async () => {
    const m = mundo({ gateEnabled: false });
    const configVieja = { ...DEFAULT_RECEIPT_GATE_CONFIG, enabled: true };

    const r = await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1', config: configVieja }, deps(m));

    expect(r).toEqual({ ok: false, reason: 'receipt_gate_disabled' });
    expect(m.lecturasDelFlag).toBeGreaterThan(0);
    expect(m.patches).toHaveLength(0);
    expect(m.notifications).toEqual({});
  });

  it('marcar como comprobante RELEE el flag y rechaza con el nivel B en OFF', async () => {
    const m = mundo({
      gateEnabled: false,
      attachments: {
        [ATT]: attachmentDoc({
          classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: NOW },
          orderCandidateId: 'ord_1',
        } as Partial<Attachment>),
      },
    });

    const r = await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'uid_v' }, deps(m));

    expect(r).toEqual({ ok: false, reason: 'receipt_gate_disabled' });
    expect(m.lecturasDelFlag).toBeGreaterThan(0);
    expect(m.patches).toHaveLength(0);
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');
  });

  /**
   * ADR-0016 §10: «apagar una función no puede dejar atrapada una decisión humana que alguien
   * necesita revertir». Si el desmarcado dependiera del flag, un tenant con el gate apagado
   * quedaría con comprobantes marcados para siempre.
   */
  it('DESMARCAR sigue funcionando con el nivel B en OFF: revocar siempre tiene que ser posible', async () => {
    const m = mundo({
      gateEnabled: false,
      attachments: {
        [ATT]: attachmentDoc({
          classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_v', at: NOW },
          orderCandidateId: 'ord_1',
        } as Partial<Attachment>),
      },
      orders: {
        ord_1: orderDoc('ord_1', 'PENDING_VERIFICATION', {
          receiptAttachments: { candidateIds: [ATT], linkedIds: [ATT], statusDrivenBy: ATT, updatedAt: NOW },
        }),
      },
    });

    const r = await unmarkAttachmentReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'uid_v' }, deps(m));

    expect(r).toEqual({ ok: true, status: 'PENDING_PAYMENT', reverted: true });
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');
    const attPatch = m.patches.find((p) => p.kind === 'attachment')!.patch;
    expect(attPatch['classification.value']).toBe('generic_media');
  });

  it('apagar el nivel B no borra ni oculta nada de lo ya guardado', async () => {
    const m = mundo({
      gateEnabled: false,
      attachments: {
        [ATT]: attachmentDoc({
          classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_v', at: NOW },
          orderCandidateId: 'ord_1',
        } as Partial<Attachment>),
      },
      orders: {
        ord_1: orderDoc('ord_1', 'PENDING_VERIFICATION', {
          receiptAttachments: { candidateIds: [ATT], linkedIds: [ATT], statusDrivenBy: ATT, updatedAt: NOW },
        }),
      },
      notifications: { [AVISO]: { id: AVISO } },
    });

    await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));

    // El vínculo humano sigue en pie y la campana ya existente no se toca.
    expect(readOrderReceiptAttachments(m.orders['ord_1']).linkedIds).toEqual([ATT]);
    expect(m.attachments[ATT]!.classification!.value).toBe('payment_receipt_linked');
    expect(m.notifications[AVISO]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// B3 — promesa y señal son un solo hecho
// ---------------------------------------------------------------------------

describe('ADR-0016 §11 — candidato y campana se confirman JUNTOS o ninguno', () => {
  it('el camino feliz escribe adjunto, pedido y campana en la MISMA transacción', async () => {
    const m = mundo();
    const r = await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));

    expect(r).toEqual({ ok: true, orderId: 'ord_1', alreadyLinked: false });
    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([ATT]);
    // La campana existe con el id determinístico y apunta a la conversación del cliente.
    const aviso = m.notifications[AVISO];
    expect(aviso).toBeDefined();
    expect(aviso!['category']).toBe('handoff');
    expect(aviso!['dedupeKey']).toBe(AVISO);
    expect(aviso!['customerId']).toBe(CLIENTE);
    // El pedido NO se movió: el candidato es una sugerencia.
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');
    sinPAID(m);
  });

  /**
   * EL DISCRIMINANTE DE B3. Hoy la campana es best-effort DESPUÉS del commit: el candidato queda
   * escrito, el mensaje sale igual y el cliente espera a un vendedor que nunca fue notificado.
   */
  it('si la campana falla, NO queda candidato, NO se toca el pedido y NO se promete revisión', async () => {
    const m = mundo({ campanaRota: true });

    await expect(
      linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m)),
    ).rejects.toThrow();

    // Nada sobrevivió: ni la clasificación del adjunto ni el vínculo en el pedido.
    expect(m.attachments[ATT]!.classification!.value).toBe('unclassified');
    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([]);
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');
    expect(m.notifications).toEqual({});
  });

  it('el texto del aviso no promete un pago confirmado ni filtra el teléfono completo', async () => {
    const m = mundo();
    await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));

    const aviso = m.notifications[AVISO]!;
    const texto = `${aviso['title'] as string} ${aviso['body'] as string}`;
    expect(texto).not.toMatch(/pago confirmado|pagado|cobrado/i);
    expect(texto).not.toContain(CLIENTE);
    expect(texto).toContain(`…${CLIENTE.slice(-4)}`);
  });
});

// ---------------------------------------------------------------------------
// B4 — idempotencia
// ---------------------------------------------------------------------------

describe('ADR-0016 §11 — un reintento produce como MÁXIMO un candidato y una campana', () => {
  it('reintento del mismo webhook: un solo candidato, una sola campana, cero PAID', async () => {
    const m = mundo();
    const d = deps(m);
    await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, d);
    const r2 = await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, d);

    expect(r2).toEqual({ ok: true, orderId: 'ord_1', alreadyLinked: true });
    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([ATT]);
    expect(Object.keys(m.notifications)).toEqual([AVISO]);
    expect(m.patches.filter((p) => p.kind === 'notification')).toHaveLength(1);
    sinPAID(m);
  });

  it('si la campana ya existe (aviso previo) el vínculo no explota ni la duplica', async () => {
    const m = mundo({ notifications: { [AVISO]: { id: AVISO, previo: true } } });
    const r = await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));

    expect(r).toEqual({ ok: true, orderId: 'ord_1', alreadyLinked: false });
    expect(m.notifications[AVISO]!['previo']).toBe(true);
    expect(m.patches.filter((p) => p.kind === 'notification')).toHaveLength(0);
    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([ATT]);
  });
});

// ---------------------------------------------------------------------------
// Superficie de la callable
// ---------------------------------------------------------------------------

describe('attachmentCallables — el gate apagado se le explica al vendedor sin filtrar el código', () => {
  it('`receipt_gate_disabled` tiene mensaje PROPIO y no invita a reintentar para siempre', () => {
    const r = mensajeDeMotivo('receipt_gate_disabled');
    const generico = mensajeDeMotivo('classification_not_open');

    expect(r.code).toBe('failed-precondition');
    // No puede caer en el mensaje genérico: "no se pudo" manda al vendedor a reintentar contra un
    // flag apagado, que no se arregla reintentando sino encendiéndolo.
    expect(r.message).not.toBe(generico.message);
    expect(r.message).toMatch(/habilitad/i);
    expect(r.message).not.toMatch(/probá de nuevo/i);
    // Y le dice lo único accionable: desmarcar SÍ sigue disponible (ADR-0016 §10).
    expect(r.message).toMatch(/desmarcar/i);
    // El código interno y la estructura de datos nunca salen.
    expect(r.message).not.toMatch(/tenants\/|attachments\/|_disabled|receiptGate|enabled/);
  });
});
