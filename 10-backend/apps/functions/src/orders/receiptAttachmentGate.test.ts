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

/** Config del tenant con el nivel B ENCENDIDO: el default del código está en OFF (ADR-0016 §10). */
const CONFIG_ENCENDIDA = { ...DEFAULT_RECEIPT_GATE_CONFIG, enabled: true };

const hacerDeps = (over: Partial<ReceiptAttachmentGateDeps> = {}): ReceiptAttachmentGateDeps => ({
  getSession: async () => sesion(),
  getOrder: async (_t, id) => pedido(id, 'PENDING_PAYMENT'),
  listCustomerOrders: async () => [pedido('ord_1', 'PENDING_PAYMENT')],
  getConfig: async () => CONFIG_ENCENDIDA,
  link: vi.fn(async (_t, i) => ({ ok: true as const, orderId: i.orderId, alreadyLinked: false })),
  markGenericMedia: vi.fn(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null })),
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
   * DISCRIMINANTE B2. La respuesta al cliente PROMETE que «un vendedor lo revisa». La señal
   * operativa que hace cierta esa promesa la escribe AHORA la misma transacción del vínculo
   * (ADR-0016 §11), así que acá se prueba lo que le toca a la costura: la promesa sale SOLO
   * cuando el vínculo —campana incluida— quedó commiteado.
   */
  it('proponer un candidato promete revisión solo si el vínculo (con su campana) se confirmó', async () => {
    const deps = hacerDeps();
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.reply).toBe(MENSAJE_COMPROBANTE_PROPUESTO);
    expect(deps.link).toHaveBeenCalledTimes(1);
  });

  it('sin candidato (medio normal) no se propone nada: no se molesta al vendedor por una foto', async () => {
    const deps = hacerDeps({ getSession: async () => sesion({ state: 'BROWSING' }) });
    const r = await crearReceiptAttachmentGate(deps)(entrada());
    expect(deps.link).not.toHaveBeenCalled();
    expect(r.reply).toBe('');
  });

  it('reintento del webhook: ya propuesto ⇒ ni mensaje ni vínculo repetido', async () => {
    const deps = hacerDeps();
    const yaPropuesto = adjunto({
      classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: null },
      orderCandidateId: 'ord_1',
    } as Partial<Attachment>);
    expect((await crearReceiptAttachmentGate(deps)(entrada(yaPropuesto))).reply).toBe('');
    expect(deps.link).not.toHaveBeenCalled();

    // Y si la transacción resuelve que el vínculo YA existía, tampoco se repite el mensaje.
    const deps2 = hacerDeps({ link: vi.fn(async (_t, i) => ({ ok: true as const, orderId: i.orderId, alreadyLinked: true })) });
    expect((await crearReceiptAttachmentGate(deps2)(entrada())).reply).toBe('');
  });

  /**
   * DISCRIMINANTE B3 (ADR-0016 §11). Si la transacción que confirma candidato + campana no
   * commitea, no se promete revisión: el archivo queda como medio normal y la respuesta es
   * neutral. Antes el mensaje salía igual y el cliente esperaba a alguien que nunca fue avisado.
   */
  /**
   * La transacción LANZA. Es el único caso del sistema en que no se sabe qué quedó escrito: un
   * `runTransaction` puede fallar con el commit YA aplicado (UNAVAILABLE/DEADLINE sobre el RPC de
   * commit). Por eso acá NO se degrada: `markGenericMedia` decidiría sobre la clasificación leída
   * ANTES de la transacción y podría pisar con `generic_media` un candidato que sí se escribió,
   * dejando al pedido listándolo y al adjunto negándolo.
   *
   * Lo que §11 exige sí se cumple igual, y es lo que este test fija: no se promete revisión. No
   * degradar tampoco vuelve al archivo más frágil — la purga solo excluye evidencia de pago
   * (`payment_receipt_candidate`/`payment_receipt_linked`), así que `unclassified` y `generic_media`
   * corren exactamente la misma suerte.
   */
  it('si la transacción del vínculo LANZA, no se promete revisión Y no se pisa la clasificación', async () => {
    const deps = hacerDeps({
      link: vi.fn(async () => {
        throw new Error('firestore caído');
      }),
    });
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.orderCandidateId).toBeNull();
    expect(r.reply).not.toBe(MENSAJE_COMPROBANTE_PROPUESTO);
    expect(r.reply).not.toMatch(/revisa|vendedor/i);
    // Nada se escribe: ni la degradación, que en este caso sería una suposición sobre un commit
    // cuyo desenlace se desconoce.
    expect(deps.markGenericMedia).not.toHaveBeenCalled();
  });

  /**
   * Contraste deliberado con el test de arriba: cuando la transacción RESUELVE con `ok:false` el
   * desenlace es CONOCIDO —no se escribió nada— y ahí degradar sí es lo correcto.
   */
  it('si la transacción RESUELVE que no aplica, ahí sí se degrada a medio normal', async () => {
    const deps = hacerDeps({
      link: vi.fn(async () => ({ ok: false, reason: 'order_already_paid' }) as const),
    });
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.classification).toBe('generic_media');
    expect(r.orderCandidateId).toBeNull();
    expect(r.reply).not.toMatch(/revisa|vendedor/i);
    expect(deps.markGenericMedia).toHaveBeenCalled();
  });

  /**
   * DISCRIMINANTE B1 (ADR-0016 §10). Con el nivel B apagado el archivo se guarda igual y queda
   * como MEDIO NORMAL: cero candidato, cero campana, cero promesa. Y no se llega siquiera a la
   * transacción.
   */
  it('nivel B en OFF ⇒ medio normal, sin candidato ni promesa de revisión', async () => {
    const deps = hacerDeps({
      getConfig: async () => ({ ...DEFAULT_RECEIPT_GATE_CONFIG, enabled: false }),
      getSession: vi.fn(async () => sesion()),
      listCustomerOrders: vi.fn(async () => [pedido('ord_1', 'PENDING_PAYMENT')]),
    });
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.classification).toBe('generic_media');
    expect(r.orderCandidateId).toBeNull();
    expect(r.reply).not.toMatch(/revisa|vendedor|comprobante/i);
    expect(deps.link).not.toHaveBeenCalled();
    expect(deps.markGenericMedia).toHaveBeenCalled();
    // Y no se paga el costo de leer sesión ni la colección de pedidos del cliente: con el gate
    // apagado —el default de todo tenant— ese trabajo no lo usa nadie.
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.listCustomerOrders).not.toHaveBeenCalled();
  });

  it('el default del código está en OFF: desplegar no enciende el gate de nadie', async () => {
    const deps = hacerDeps({ getConfig: async () => DEFAULT_RECEIPT_GATE_CONFIG });
    const r = await crearReceiptAttachmentGate(deps)(entrada());

    expect(r.classification).toBe('generic_media');
    expect(deps.link).not.toHaveBeenCalled();
  });

  /**
   * ADR-0016 §10: «apagar el nivel B no puede ocultar ni borrar nada que ya exista». Enrutar al
   * gate genérico un adjunto YA propuesto lo DEGRADARÍA: el pedido seguiría listándolo como
   * candidato mientras el archivo dice `generic_media`.
   */
  it('nivel B en OFF NO degrada un candidato ya existente: se deja como está', async () => {
    const deps = hacerDeps({ getConfig: async () => ({ ...DEFAULT_RECEIPT_GATE_CONFIG, enabled: false }) });
    const yaPropuesto = adjunto({
      classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: null },
      orderCandidateId: 'ord_1',
    } as Partial<Attachment>);

    const r = await crearReceiptAttachmentGate(deps)(entrada(yaPropuesto));

    expect(r.classification).toBe('payment_receipt_candidate');
    expect(r.orderCandidateId).toBe('ord_1');
    expect(r.reply).toBe('');
    expect(deps.markGenericMedia).not.toHaveBeenCalled();
    expect(deps.link).not.toHaveBeenCalled();
  });

  it('nivel B en OFF NO degrada un comprobante vinculado por una persona', async () => {
    const deps = hacerDeps({ getConfig: async () => ({ ...DEFAULT_RECEIPT_GATE_CONFIG, enabled: false }) });
    const vinculado = adjunto({
      classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_v', at: null },
      orderCandidateId: 'ord_1',
    } as Partial<Attachment>);

    const r = await crearReceiptAttachmentGate(deps)(entrada(vinculado));

    expect(r.classification).toBe('payment_receipt_linked');
    expect(deps.markGenericMedia).not.toHaveBeenCalled();
  });

  it('el gate JAMÁS devuelve una clasificación de comprobante vinculado ni menciona PAID', async () => {
    const deps = hacerDeps();
    const r = await crearReceiptAttachmentGate(deps)(entrada());
    expect(r.classification).not.toBe('payment_receipt_linked');
    expect(JSON.stringify(r)).not.toMatch(/PAID/);
  });
});
