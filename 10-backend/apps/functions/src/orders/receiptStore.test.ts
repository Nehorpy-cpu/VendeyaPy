import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { receiptAttachmentsState, type Attachment, type Order, type OrderStatus } from '@vpw/shared';
import {
  linkReceiptCandidate,
  markAttachmentAsReceipt,
  readOrderReceiptAttachments,
  unmarkAttachmentReceipt,
  type ReceiptStoreDeps,
  type ReceiptTx,
} from './receiptStore.js';

/**
 * ADR-0016 — Persistencia transaccional del vínculo. El fake de transacción REPRODUCE la
 * semántica que importa: cada transacción LEE el estado vigente en el momento de correr, así una
 * carrera (marcar y desmarcar al mismo tiempo) se resuelve como en Firestore — gana una y la otra
 * ve el estado nuevo.
 *
 * Invariante del archivo: NINGUNA operación escribe `status: 'PAID'`.
 */
const TENANT = 'tnt_demo';
const CLIENTE = '595981000111';
const ATT = 'att_0123456789abcdef01234567';
const NOW = Timestamp.fromMillis(1_700_000_000_000);

interface Mundo {
  attachments: Record<string, Attachment>;
  orders: Record<string, Order>;
  patches: Array<{ kind: 'attachment' | 'order'; id: string; patch: Record<string, unknown> }>;
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

/** Aplica un patch con field paths punteados sobre el documento en memoria (como hace Firestore). */
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

function deps(mundo: Mundo): ReceiptStoreDeps {
  // Serialización: Firestore reintenta la transacción perdedora y la vuelve a correr sobre el
  // estado ya commiteado. El mutex reproduce ESE efecto (aislamiento serializable), que es lo
  // que hay que testear: nunca dos escrituras sobre la misma lectura.
  let cola: Promise<unknown> = Promise.resolve();
  return {
    now: () => NOW,
    runTransaction(tenantId, fn) {
      expect(tenantId).toBe(TENANT);
      const corrida = cola.then(() => ejecutar(mundo, fn));
      cola = corrida.catch(() => undefined);
      return corrida;
    },
  };
}

async function ejecutar<T>(mundo: Mundo, fn: (tx: ReceiptTx) => Promise<T>): Promise<T> {
  const escrituras: Array<() => void> = [];
  const tx: ReceiptTx = {
    async getAttachment(id) {
      return mundo.attachments[id] ?? null;
    },
    async getOrder(id) {
      return mundo.orders[id] ?? null;
    },
    updateAttachment(id, patch) {
      mundo.patches.push({ kind: 'attachment', id, patch });
      escrituras.push(() => aplicar(mundo.attachments[id] as unknown as Record<string, unknown>, patch));
    },
    updateOrder(id, patch) {
      mundo.patches.push({ kind: 'order', id, patch });
      escrituras.push(() => aplicar(mundo.orders[id] as unknown as Record<string, unknown>, patch));
    },
  };
  const out = await fn(tx);
  // El commit ocurre AL FINAL, como en una transacción real.
  for (const w of escrituras) w();
  return out;
}

const mundo = (attachment: Attachment, order: Order): Mundo => ({
  attachments: { [attachment.attachmentId]: attachment },
  orders: { [order.id]: order },
  patches: [],
});

const sinPAID = (m: Mundo) => {
  for (const p of m.patches) expect(JSON.stringify(p.patch)).not.toMatch(/"PAID"/);
};

describe('receiptStore — vínculo CANDIDATO (system): acumula y NO mueve el pedido', () => {
  it('propone el candidato sin tocar el estado del pedido', async () => {
    const m = mundo(attachmentDoc(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    const r = await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));

    expect(r).toEqual({ ok: true, orderId: 'ord_1', alreadyLinked: false });
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');
    const orderPatch = m.patches.find((p) => p.kind === 'order')!.patch;
    expect(orderPatch).not.toHaveProperty('status');
    expect(orderPatch['receiptAttachments.candidateIds']).toEqual([ATT]);
    sinPAID(m);
  });

  it('MULTI-ADJUNTO: un segundo envío ACUMULA, no reemplaza', async () => {
    const otro = 'att_ffffffffffffffffffffffff';
    const m = mundo(attachmentDoc(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    m.attachments[otro] = attachmentDoc({ attachmentId: otro });

    await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));
    await linkReceiptCandidate(TENANT, { attachmentId: otro, orderId: 'ord_1' }, deps(m));

    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([ATT, otro]);
  });

  it('idempotente: repetir el mismo vínculo no duplica ni vuelve a escribir el estado', async () => {
    const m = mundo(attachmentDoc(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));
    const r2 = await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));
    expect(r2).toEqual({ ok: true, orderId: 'ord_1', alreadyLinked: true });
    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([ATT]);
  });

  it('estado FRESCO: si el pedido se pagó entre el gate y la transacción, no se propone nada', async () => {
    const m = mundo(attachmentDoc(), orderDoc('ord_1', 'PAID'));
    expect(await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m))).toEqual({
      ok: false,
      reason: 'order_already_paid',
    });
    expect(m.patches).toHaveLength(0);
  });

  it('pedido de otro cliente o adjunto de otro tenant ⇒ nada se escribe', async () => {
    const m1 = mundo(attachmentDoc(), orderDoc('ord_1', 'PENDING_PAYMENT', { customerId: '595999000000' }));
    expect(await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m1))).toEqual({
      ok: false,
      reason: 'order_customer_mismatch',
    });
    const m2 = mundo(attachmentDoc({ tenantId: 'tnt_otro' }), orderDoc('ord_1', 'PENDING_PAYMENT'));
    expect(await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m2))).toEqual({
      ok: false,
      reason: 'tenant_mismatch',
    });
    expect([...m1.patches, ...m2.patches]).toHaveLength(0);
  });

  it('adjunto o pedido inexistente ⇒ motivo explícito, sin escrituras', async () => {
    const m = mundo(attachmentDoc(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    expect(await linkReceiptCandidate(TENANT, { attachmentId: 'att_000000000000000000000000', orderId: 'ord_1' }, deps(m))).toEqual({
      ok: false,
      reason: 'attachment_not_found',
    });
    expect(await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_x' }, deps(m))).toEqual({
      ok: false,
      reason: 'order_not_found',
    });
  });

  it('archivo sin bytes guardados ⇒ no se propone', async () => {
    const m = mundo(attachmentDoc({ ingestState: 'download_failed' }), orderDoc('ord_1', 'PENDING_PAYMENT'));
    expect(await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m))).toEqual({
      ok: false,
      reason: 'attachment_not_stored',
    });
  });
});

describe('receiptStore — marcar/desmarcar (human)', () => {
  const candidato = () =>
    attachmentDoc({
      classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: NOW },
      orderCandidateId: 'ord_1',
    });

  it('marcar lleva el pedido a PENDING_VERIFICATION y registra quién lo produjo — nunca PAID', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    const r = await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'uid_vendedor' }, deps(m));

    expect(r).toEqual({ ok: true, alreadyMarked: false, status: 'PENDING_VERIFICATION' });
    expect(m.orders['ord_1']!.status).toBe('PENDING_VERIFICATION');
    const receipts = readOrderReceiptAttachments(m.orders['ord_1']);
    expect(receipts.linkedIds).toEqual([ATT]);
    expect(receipts.statusDrivenBy).toBe(ATT);
    const attPatch = m.patches.find((p) => p.kind === 'attachment')!.patch;
    expect(attPatch['classification.value']).toBe('payment_receipt_linked');
    expect(attPatch['classification.source']).toBe('human');
    expect(attPatch['classification.by']).toBe('uid_vendedor');
    sinPAID(m);
  });

  /**
   * DISCRIMINANTE B1 — VISIBILIDAD DESDE EL PEDIDO. El vendedor marca el comprobante en
   * Conversaciones y después abre Pedidos: si el pedido no expone el vínculo en la superficie que
   * el panel lee, el archivo existe pero es INVISIBLE justo donde se trabaja el pedido.
   *
   * Se afirma contra la MISMA proyección compartida que usa el panel (`@vpw/shared`), no contra
   * los field paths crudos: eso es lo que ata el contrato entre las dos puntas.
   */
  it('el pedido EXPONE el comprobante para el panel: estado `linked` + el id que abre el visor', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'uid_vendedor' }, deps(m));

    const pedido = m.orders['ord_1']!;
    expect(receiptAttachmentsState(pedido)).toBe('linked');
    // Es el id OPACO del adjunto: con eso el panel pide el enlace por `attachmentGetViewUrl`.
    expect(readOrderReceiptAttachments(pedido).linkedIds).toEqual([ATT]);
    // Y jamás una ruta de Storage ni una URL: el pedido no guarda bytes ni caminos.
    expect(JSON.stringify(pedido['receiptAttachments'])).not.toMatch(/tenants\/|https?:/);
  });

  it('un CANDIDATO del sistema no se ve como comprobante desde el pedido (es una sugerencia)', async () => {
    const m = mundo(attachmentDoc(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m));

    expect(receiptAttachmentsState(m.orders['ord_1']!)).toBe('candidate');
    expect(readOrderReceiptAttachments(m.orders['ord_1']).linkedIds).toEqual([]);
  });

  it('marcar NO confirma el pago: el pedido queda sin paidAt ni paymentId', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m));
    for (const p of m.patches) {
      expect(Object.keys(p.patch).join(',')).not.toMatch(/paidAt|paymentId/);
    }
  });

  it('marcar es idempotente (no re-escribe ni re-mueve el estado)', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m));
    const antes = m.patches.length;
    const r2 = await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m));
    expect(r2).toEqual({ ok: true, alreadyMarked: true, status: 'PENDING_VERIFICATION' });
    expect(m.patches).toHaveLength(antes);
  });

  it('ILEGAL: marcar sobre un pedido ya pagado no escribe nada', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PAID'));
    expect(await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m))).toEqual({
      ok: false,
      reason: 'order_already_paid',
    });
    expect(m.patches).toHaveLength(0);
    expect(m.orders['ord_1']!.status).toBe('PAID');
  });

  it('desmarcar revierte a PENDING_PAYMENT y PRESERVA el archivo como generic_media', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m));
    const r = await unmarkAttachmentReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u2' }, deps(m));

    expect(r).toEqual({ ok: true, status: 'PENDING_PAYMENT', reverted: true });
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');
    expect(readOrderReceiptAttachments(m.orders['ord_1']).linkedIds).toEqual([]);
    // El adjunto sobrevive: cambia el significado, no el archivo.
    expect(m.attachments[ATT]).toBeDefined();
    const ultimo = m.patches.filter((p) => p.kind === 'attachment').at(-1)!.patch;
    expect(ultimo['classification.value']).toBe('generic_media');
    expect(ultimo['orderCandidateId']).toBeNull();
    sinPAID(m);
  });

  /**
   * DISCRIMINANTE B1, end-to-end sobre la transacción. Dos comprobantes marcados por una persona;
   * desmarcar el primero (el que figura como origen del estado) NO puede tirar abajo el segundo.
   */
  it('MULTI-COMPROBANTE: desmarcar el primero deja el pedido en PENDING_VERIFICATION mientras el segundo siga vinculado', async () => {
    const OTRO = 'att_ffffffffffffffffffffffff';
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    m.attachments[OTRO] = attachmentDoc({
      attachmentId: OTRO,
      classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: NOW },
      orderCandidateId: 'ord_1',
    });

    await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u1' }, deps(m));
    await markAttachmentAsReceipt(TENANT, { attachmentId: OTRO, orderId: 'ord_1', actorUid: 'u1' }, deps(m));
    expect(readOrderReceiptAttachments(m.orders['ord_1']).statusDrivenBy).toBe(ATT);

    const r = await unmarkAttachmentReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u2' }, deps(m));

    expect(r).toEqual({ ok: true, status: 'PENDING_VERIFICATION', reverted: false });
    expect(m.orders['ord_1']!.status).toBe('PENDING_VERIFICATION');
    const receipts = readOrderReceiptAttachments(m.orders['ord_1']);
    expect(receipts.linkedIds).toEqual([OTRO]);
    // El puntero se traspasó al comprobante que SÍ sigue sosteniendo el estado.
    expect(receipts.statusDrivenBy).toBe(OTRO);

    // Y recién al desmarcar el segundo el pedido vuelve a esperar pago.
    const r2 = await unmarkAttachmentReceipt(TENANT, { attachmentId: OTRO, orderId: 'ord_1', actorUid: 'u2' }, deps(m));
    expect(r2).toEqual({ ok: true, status: 'PENDING_PAYMENT', reverted: true });
    expect(readOrderReceiptAttachments(m.orders['ord_1'])).toEqual({
      candidateIds: [],
      linkedIds: [],
      statusDrivenBy: null,
    });
    sinPAID(m);
  });

  /**
   * DISCRIMINANTE B5. Desmarcar deja el adjunto `generic_media` con `orderCandidateId: null` — es
   * decir, PURGABLE otra vez. Si el pedido lo siguiera listando en `candidateIds`, el panel
   * mostraría una referencia a bytes que el job de retención puede borrar.
   */
  it('desmarcar lo saca de las DOS listas del pedido (candidateIds y linkedIds)', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m));
    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([ATT]);

    await unmarkAttachmentReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u2' }, deps(m));

    expect(readOrderReceiptAttachments(m.orders['ord_1']).candidateIds).toEqual([]);
    expect(readOrderReceiptAttachments(m.orders['ord_1']).linkedIds).toEqual([]);
    // El adjunto quedó desvinculado ⇒ purgable; el pedido ya no lo referencia por ningún lado.
    const ultimo = m.patches.filter((p) => p.kind === 'attachment').at(-1)!.patch;
    expect(ultimo['orderCandidateId']).toBeNull();
  });

  /**
   * DISCRIMINANTE B4 (persistencia). Un adjunto con los bytes ya purgados conserva
   * `ingestState: 'stored'`: si el store no mira `purgedAt`, el vendedor vincula un archivo que
   * no existe y el pedido se mueve a PENDING_VERIFICATION sin evidencia.
   */
  it('un adjunto PURGADO no puede marcarse ni proponerse: no se escribe nada', async () => {
    const purgado = () =>
      attachmentDoc({
        classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: NOW },
        orderCandidateId: 'ord_1',
        purgedAt: NOW,
      } as Partial<Attachment>);

    const m = mundo(purgado(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    expect(await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m))).toEqual({
      ok: false,
      reason: 'attachment_purged',
    });
    expect(m.patches).toHaveLength(0);
    expect(m.orders['ord_1']!.status).toBe('PENDING_PAYMENT');

    const m2 = mundo(attachmentDoc({ purgedAt: NOW } as Partial<Attachment>), orderDoc('ord_1', 'PENDING_PAYMENT'));
    expect(await linkReceiptCandidate(TENANT, { attachmentId: ATT, orderId: 'ord_1' }, deps(m2))).toEqual({
      ok: false,
      reason: 'attachment_purged',
    });
    expect(m2.patches).toHaveLength(0);
  });

  /**
   * DISCRIMINANTE B3 — DEADLOCK del puntero nulo, sobre la transacción real. El pedido ya venía en
   * `PENDING_VERIFICATION` por el flujo legacy/dev, así que marcar NO mueve el estado y
   * `statusDrivenBy` nunca se escribe. Antes, desmarcar quedaba trabado para siempre: el adjunto
   * seguía siendo "comprobante" sin forma de revocarlo.
   */
  it('pedido que YA venía en PENDING_VERIFICATION: marcar y desmarcar no traba, y el estado no se toca', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_VERIFICATION'));

    const marcado = await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u1' }, deps(m));
    expect(marcado).toEqual({ ok: true, alreadyMarked: false, status: 'PENDING_VERIFICATION' });
    // El estado no lo produjo este camino ⇒ el puntero sigue vacío (esa es la trampa del vector).
    expect(readOrderReceiptAttachments(m.orders['ord_1']).statusDrivenBy).toBeNull();
    expect(readOrderReceiptAttachments(m.orders['ord_1']).linkedIds).toEqual([ATT]);

    const r = await unmarkAttachmentReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u2' }, deps(m));

    expect(r).toEqual({ ok: true, status: 'PENDING_VERIFICATION', reverted: false });
    // El pedido queda donde estaba: no se revierte un estado que este camino no produjo.
    expect(m.orders['ord_1']!.status).toBe('PENDING_VERIFICATION');
    expect(readOrderReceiptAttachments(m.orders['ord_1']).linkedIds).toEqual([]);
    const ultimo = m.patches.filter((p) => p.kind === 'attachment').at(-1)!.patch;
    expect(ultimo['classification.value']).toBe('generic_media');
    sinPAID(m);
  });

  it('ILEGAL: desmarcar cuando el estado lo sostiene OTRA evidencia', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    await markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m));
    // Otro adjunto pasa a sostener el estado (lo simula el mundo, como lo haría otro vendedor).
    aplicarStatusDrivenBy(m, 'ord_1', 'att_ffffffffffffffffffffffff');

    expect(await unmarkAttachmentReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u' }, deps(m))).toEqual({
      ok: false,
      reason: 'other_evidence_drives_status',
    });
    expect(m.orders['ord_1']!.status).toBe('PENDING_VERIFICATION');
  });

  it('CARRERA marcar/desmarcar: la segunda transacción ve el estado nuevo y no pisa nada', async () => {
    const m = mundo(candidato(), orderDoc('ord_1', 'PENDING_PAYMENT'));
    const d = deps(m);

    // Las dos operaciones se lanzan juntas; el fake las serializa como haría el commit real.
    const [marcado, desmarcado] = await Promise.all([
      markAttachmentAsReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u1' }, d),
      unmarkAttachmentReceipt(TENANT, { attachmentId: ATT, orderId: 'ord_1', actorUid: 'u2' }, d),
    ]);

    // Exactamente una gana; el pedido queda en un estado coherente y JAMÁS en PAID.
    expect([marcado.ok, desmarcado.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(['PENDING_PAYMENT', 'PENDING_VERIFICATION']).toContain(m.orders['ord_1']!.status);
    sinPAID(m);

    // Y una tercera pasada deja el sistema consistente (sin vínculos huérfanos).
    const receipts = readOrderReceiptAttachments(m.orders['ord_1']);
    if (m.orders['ord_1']!.status === 'PENDING_VERIFICATION') {
      expect(receipts.linkedIds).toContain(ATT);
    } else {
      expect(receipts.linkedIds).not.toContain(ATT);
    }
  });
});

/** Simula que otro adjunto pasó a sostener el `PENDING_VERIFICATION` del pedido. */
function aplicarStatusDrivenBy(m: Mundo, orderId: string, attachmentId: string): void {
  const order = m.orders[orderId] as unknown as Record<string, unknown>;
  const receipts = (order['receiptAttachments'] ?? {}) as Record<string, unknown>;
  receipts['statusDrivenBy'] = attachmentId;
  order['receiptAttachments'] = receipts;
}

describe('receiptStore — readOrderReceiptAttachments (documentos viejos)', () => {
  it('un pedido sin la metadata no explota y no inventa vínculos', () => {
    expect(readOrderReceiptAttachments(orderDoc('ord_1', 'PENDING_PAYMENT'))).toEqual({
      candidateIds: [],
      linkedIds: [],
      statusDrivenBy: null,
    });
    expect(readOrderReceiptAttachments(null)).toEqual({ candidateIds: [], linkedIds: [], statusDrivenBy: null });
  });

  it('descarta basura y deduplica', () => {
    const sucio = orderDoc('ord_1', 'PENDING_PAYMENT', {
      receiptAttachments: { candidateIds: [ATT, ATT, 42, null, ''], linkedIds: 'no-es-lista', statusDrivenBy: '' },
    });
    expect(readOrderReceiptAttachments(sucio)).toEqual({ candidateIds: [ATT], linkedIds: [], statusDrivenBy: null });
  });
});
