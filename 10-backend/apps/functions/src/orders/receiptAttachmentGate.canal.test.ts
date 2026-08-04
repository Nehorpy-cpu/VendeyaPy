import { describe, it, expect, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Attachment, Order, Session } from '@vpw/shared';
import { crearReceiptAttachmentGate, type ReceiptAttachmentGateDeps } from './receiptAttachmentGate.js';
import { DEFAULT_RECEIPT_GATE_CONFIG } from './receiptGate.js';
import type { AttachmentGateInput } from '../meta/attachmentGate.js';

/**
 * ADR-0017 §2 — EL COMPROBANTE SE EVALÚA CONTRA LA CONVERSACIÓN QUE LO RECIBIÓ.
 * ==============================================================================
 * El gate del comprobante decide con DOS hechos de la sesión: si el checkout declaró que espera
 * un pago (`AWAITING_PAYMENT`) y a qué pedido apunta (`pendingOrderId`). Los leía de
 * `sessions/active` sin importar por qué número llegó el archivo.
 *
 * Efecto en el número nuevo: el cliente manda su comprobante, el gate mira una sesión que no es la
 * suya —típicamente sin espera de pago declarada—, el archivo se degrada a MEDIO NORMAL y el
 * pedido nunca lo lista. El vendedor no recibe la campana y el cliente se queda esperando la
 * confirmación de un pago que el sistema no vinculó a nada.
 *
 * Un adjunto sin canal declarado sigue leyendo el heredado: es el comportamiento de hoy.
 */
const TENANT = 'tnt_demo';
const CLIENTE = '595981000111';
const AHORA = 1_700_000_000_000;

const adjunto = (): Attachment =>
  ({
    attachmentId: 'att_0123456789abcdef01234567',
    tenantId: TENANT,
    customerId: CLIENTE,
    ingestState: 'stored',
    classification: { value: 'unclassified', source: 'rule', confidence: 0, by: null, at: null },
    orderCandidateId: null,
    mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
    bytes: 80_000,
  }) as unknown as Attachment;

const pedido = (id: string): Order =>
  ({ id, tenantId: TENANT, customerId: CLIENTE, status: 'PENDING_PAYMENT', createdAt: Timestamp.fromMillis(AHORA - 120_000) }) as unknown as Order;

/** Solo la sesión del canal nuevo declara la espera del comprobante. */
const SESIONES: Record<string, Session> = {
  active: { state: 'BROWSING', context: { pendingOrderId: null } } as unknown as Session,
  wa_444555666: { state: 'AWAITING_PAYMENT', context: { pendingOrderId: 'ord_1' } } as unknown as Session,
};

const entrada = (sessionKey: string | undefined): AttachmentGateInput => ({
  tenantId: TENANT,
  customerId: CLIENTE,
  channel: 'whatsapp',
  attachment: adjunto(),
  messageId: 'msg_1',
  receivedByPhoneNumberId: '444555666',
  ...(sessionKey ? { sessionKey } : {}),
});

const hacerDeps = (): { deps: ReceiptAttachmentGateDeps; getSession: ReturnType<typeof vi.fn> } => {
  const getSession = vi.fn(async (_t: string, _c: string, sessionKey: string) => SESIONES[sessionKey] ?? null);
  return {
    getSession,
    deps: {
      getSession: getSession as unknown as ReceiptAttachmentGateDeps['getSession'],
      getOrder: async (_t, id) => pedido(id),
      listCustomerOrders: async () => [pedido('ord_1')],
      getConfig: async () => ({ ...DEFAULT_RECEIPT_GATE_CONFIG, enabled: true }),
      link: vi.fn(async (_t, i) => ({ ok: true as const, orderId: i.orderId, alreadyLinked: false })),
      markGenericMedia: vi.fn(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null })),
      nowMs: () => AHORA,
    },
  };
};

describe('receiptAttachmentGate — la sesión que decide es la del canal (ADR-0017 §2)', () => {
  it('comprobante del canal nuevo: se lee ESA sesión y el archivo queda propuesto', async () => {
    const { deps, getSession } = hacerDeps();

    const r = await crearReceiptAttachmentGate(deps)(entrada('wa_444555666'));

    expect(getSession).toHaveBeenCalledWith(TENANT, CLIENTE, 'wa_444555666');
    // El defecto: leyendo `active` (sin espera declarada) el comprobante se degradaba a medio normal.
    expect(r.classification).toBe('payment_receipt_candidate');
    expect(r.orderCandidateId).toBe('ord_1');
  });

  it('sin canal declarado se lee el heredado (`active`): comportamiento de hoy, intacto', async () => {
    const { deps, getSession } = hacerDeps();

    await crearReceiptAttachmentGate(deps)(entrada(undefined));

    expect(getSession).toHaveBeenCalledWith(TENANT, CLIENTE, 'active');
  });
});
