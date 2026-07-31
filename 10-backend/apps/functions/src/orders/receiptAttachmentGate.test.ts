import { describe, it, expect, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Attachment, Order, Session } from '@vpw/shared';
import {
  MENSAJE_COMPROBANTE_PROPUESTO,
  crearReceiptAttachmentGate,
  type ReceiptAttachmentGateDeps,
} from './receiptAttachmentGate.js';
import { DEFAULT_RECEIPT_GATE_CONFIG } from './receiptGate.js';
import type { AttachmentGateInput } from '../meta/attachmentGate.js';

/**
 * ADR-0016 §4 — El gate REAL enchufado a la ingesta. Lo que se prueba acá es la COSTURA:
 * qué se propone, qué se degrada a medio normal y qué NUNCA se toca (el estado del pedido).
 */
const TENANT = 'tnt_demo';
const CLIENTE = '595981000111';
const ATT = 'att_0123456789abcdef01234567';
const AHORA = 1_700_000_000_000;

const adjunto = (over: Partial<Attachment> = {}): Attachment =>
  ({
    attachmentId: ATT,
    tenantId: TENANT,
    customerId: CLIENTE,
    ingestState: 'stored',
    classification: { value: 'unclassified', source: 'rule', confidence: 0, by: null, at: null },
    orderCandidateId: null,
    mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
    bytes: 80_000,
    ...over,
  }) as unknown as Attachment;

const pedido = (id: string, status: string, over: Record<string, unknown> = {}): Order =>
  ({
    id,
    tenantId: TENANT,
    customerId: CLIENTE,
    status,
    createdAt: Timestamp.fromMillis(AHORA - 120_000),
    ...over,
  }) as unknown as Order;

const sesion = (over: Record<string, unknown> = {}): Session =>
  ({ state: 'AWAITING_PAYMENT', context: { pendingOrderId: 'ord_1' }, ...over }) as unknown as Session;

const entrada = (attachment = adjunto()): AttachmentGateInput => ({
  tenantId: TENANT,
  customerId: CLIENTE,
  channel: 'whatsapp',
  attachment,
  messageId: 'msg_1',
  receivedByPhoneNumberId: null,
});

const hacerDeps = (over: Partial<ReceiptAttachmentGateDeps> = {}): ReceiptAttachmentGateDeps => ({
  getSession: async () => sesion(),
  getOrder: async (_t, id) => pedido(id, 'PENDING_PAYMENT'),
  listCustomerOrders: async () => [pedido('ord_1', 'PENDING_PAYMENT')],
  getConfig: async () => DEFAULT_RECEIPT_GATE_CONFIG,
  link: vi.fn(async (_t, i) => ({ ok: true as const, orderId: i.orderId, alreadyLinked: false })),
  markGenericMedia: vi.fn(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null })),
  notifyCandidate: vi.fn(async () => true),
  nowMs: () => AHORA,
  ...over,
});

describe('orders/receiptAttachmentGate — costura ingesta ↔ pedidos', () => {
  it('con contexto declarado propone el candidato y avisa SIN confirmar el pago', async () => {
    const deps = hacerDeps();
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r).toEqual({
      reply: MENSAJE_COMPROBANTE_PROPUESTO,
      classification: 'payment_receipt_candidate',
      orderCandidateId: 'ord_1',
    });
    expect(deps.link).toHaveBeenCalledWith(TENANT, expect.objectContaining({ attachmentId: ATT, orderId: 'ord_1' }));
    expect(deps.markGenericMedia).not.toHaveBeenCalled();
    expect(r.reply).not.toMatch(/pagado|confirmad[oa]/i);
  });

  it('SIN contexto explícito de pago ⇒ medio normal y el gate no responde nada', async () => {
    const deps = hacerDeps({ getSession: async () => sesion({ state: 'BROWSING' }) });
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.classification).toBe('generic_media');
    expect(r.orderCandidateId).toBeNull();
    expect(deps.link).not.toHaveBeenCalled();
    expect(deps.markGenericMedia).toHaveBeenCalled();
  });

  it('pedido de otro cliente en el puntero de la sesión ⇒ medio normal', async () => {
    const deps = hacerDeps({
      getOrder: async (_t, id) => pedido(id, 'PENDING_PAYMENT', { customerId: '595999000111' }),
      listCustomerOrders: async () => [],
    });
    const r = await crearReceiptAttachmentGate(deps)(entrada());
    expect(r.classification).toBe('generic_media');
    expect(deps.link).not.toHaveBeenCalled();
  });

  it('archivo no almacenado o formato no verificado ⇒ medio normal', async () => {
    const deps = hacerDeps();
    const gate = crearReceiptAttachmentGate(deps);
    expect((await gate(entrada(adjunto({ ingestState: 'download_failed' })))).classification).toBe('generic_media');
    expect(
      (await gate(entrada(adjunto({ mime: { declared: 'image/jpeg', verified: null } } as Partial<Attachment>)))).classification,
    ).toBe('generic_media');
    expect(deps.link).not.toHaveBeenCalled();
  });

  it('carrera: si el pedido se pagó entre la evaluación y la transacción, degrada (nunca fabrica evidencia)', async () => {
    const deps = hacerDeps({ link: vi.fn(async () => ({ ok: false as const, reason: 'order_already_paid' as const })) });
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.classification).toBe('generic_media');
    expect(deps.markGenericMedia).toHaveBeenCalled();
  });

  it('idempotente: un reintento del webhook no repite el mensaje ni vuelve a vincular', async () => {
    const deps = hacerDeps();
    const yaPropuesto = adjunto({
      classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: null },
      orderCandidateId: 'ord_1',
    } as Partial<Attachment>);
    const r = await crearReceiptAttachmentGate(deps)(entrada(yaPropuesto));

    expect(r).toEqual({ reply: '', classification: 'payment_receipt_candidate', orderCandidateId: 'ord_1' });
    expect(deps.link).not.toHaveBeenCalled();
  });

  /**
   * DISCRIMINANTE B2. La respuesta al cliente PROMETE que «un vendedor lo revisa». Si proponer un
   * candidato no genera ninguna señal operativa, esa promesa es papel: el archivo queda esperando
   * a que alguien abra por casualidad la conversación correcta.
   */
  it('proponer un candidato GENERA la señal operativa, con los ids del vínculo', async () => {
    const deps = hacerDeps();
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.reply).toBe(MENSAJE_COMPROBANTE_PROPUESTO);
    expect(deps.notifyCandidate).toHaveBeenCalledTimes(1);
    expect(deps.notifyCandidate).toHaveBeenCalledWith({
      tenantId: TENANT,
      customerId: CLIENTE,
      orderId: 'ord_1',
      attachmentId: ATT,
    });
  });

  it('sin candidato (medio normal) NO se avisa nada: no se molesta al vendedor por una foto', async () => {
    const deps = hacerDeps({ getSession: async () => sesion({ state: 'BROWSING' }) });
    await crearReceiptAttachmentGate(deps)(entrada());
    expect(deps.notifyCandidate).not.toHaveBeenCalled();
  });

  it('reintento del webhook: ya propuesto ⇒ ni mensaje ni aviso repetido', async () => {
    const deps = hacerDeps();
    const yaPropuesto = adjunto({
      classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: null },
      orderCandidateId: 'ord_1',
    } as Partial<Attachment>);
    await crearReceiptAttachmentGate(deps)(entrada(yaPropuesto));
    expect(deps.notifyCandidate).not.toHaveBeenCalled();

    // Y si la transacción resuelve que el vínculo YA existía, tampoco se re-avisa.
    const deps2 = hacerDeps({ link: vi.fn(async (_t, i) => ({ ok: true as const, orderId: i.orderId, alreadyLinked: true })) });
    await crearReceiptAttachmentGate(deps2)(entrada());
    expect(deps2.notifyCandidate).not.toHaveBeenCalled();
  });

  it('si la campana falla, el turno del cliente NO se rompe (el archivo ya está guardado)', async () => {
    const deps = hacerDeps({ notifyCandidate: vi.fn(async () => { throw new Error('firestore caído'); }) });
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r).toEqual({
      reply: MENSAJE_COMPROBANTE_PROPUESTO,
      classification: 'payment_receipt_candidate',
      orderCandidateId: 'ord_1',
    });
  });

  it('el gate JAMÁS devuelve una clasificación de comprobante vinculado ni menciona PAID', async () => {
    const deps = hacerDeps();
    const r = await crearReceiptAttachmentGate(deps)(entrada());
    expect(r.classification).not.toBe('payment_receipt_linked');
    expect(JSON.stringify(r)).not.toMatch(/PAID/);
  });
});
