/**
 * orderReceipts — lectura de los comprobantes de un pedido (ADR-0016 §3, §5, §6 y §7 · Área C).
 *
 * Lo que fijan estos tests, en orden de gravedad:
 *  1. el pedido encuentra sus comprobantes en las DOS superficies posibles (la nueva
 *     `receiptAttachments` y la vieja colgada de `payment`);
 *  2. un id que no es un attachmentId JAMÁS se usa para armar una ruta de documento;
 *  3. la proyección deja afuera `storage.path` (la ruta del archivo de un cliente no vuelve al panel);
 *  4. un adjunto de OTRO cliente referenciado por el pedido no se muestra;
 *  5. el error de Firestore no se reenvía crudo: su `message` trae la ruta del documento adentro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Attachment, Order } from '@vpw/shared';
import {
  MAX_ORDER_ATTACHMENTS,
  friendlyOrderAttachmentError,
  listAttachmentsByIds,
  readOrderReceiptRefs,
  separarAdjuntosDelCliente,
} from './orderReceipts';
import { toPanelAttachment } from './attachments';

const getDocMock = vi.fn();
vi.mock('firebase/firestore', () => ({
  // `doc(db, ...segmentos)` → la ruta como string: así el test puede afirmar QUÉ se leyó.
  doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
  getDoc: (ref: string) => getDocMock(ref),
  // El resto solo existe para que los módulos vecinos importen sin romper: nadie los llama acá.
  collection: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@/lib/firebase', () => ({
  firebaseDb: () => ({}),
  firebaseFunctions: () => ({}),
}));

const A1 = 'att_' + '1'.repeat(24);
const A2 = 'att_' + '2'.repeat(24);
const A3 = 'att_' + '3'.repeat(24);
const CLIENTE = '595981000000';
const PATH_STORAGE = 'tenants/tnt_1/attachments/11/att_secreto';

const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Attachment['createdAt'];

/** Documento CRUDO de Firestore (con todo lo que el panel no debe ver). */
function rawAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: A1,
    tenantId: 'tnt_1',
    customerId: CLIENTE,
    conversationId: CLIENTE,
    messageId: 'msg_1',
    providerMessageId: 'pmid_' + 'b'.repeat(24),
    channel: 'whatsapp',
    class: 'image',
    direction: 'in',
    author: 'customer',
    ingestState: 'stored',
    classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_1', at: ts(2) },
    caption: '',
    filename: null,
    mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
    bytes: 2048,
    checksum: 'checksum-secreto',
    storage: { path: PATH_STORAGE },
    orderCandidateId: 'ord_1',
    retentionUntil: ts(99),
    purgedAt: null,
    createdAt: ts(1),
    updatedAt: ts(2),
    lastError: null,
    ...over,
  } as Attachment;
}

const orden = (over: Record<string, unknown> = {}): Order =>
  ({
    id: 'ord_1',
    tenantId: 'tnt_1',
    customerId: CLIENTE,
    status: 'PENDING_VERIFICATION',
    items: [],
    totals: { subtotal: 0, discount: 0, total: 0, currency: 'PYG' },
    payment: { method: 'transfer', paymentId: 'pay_1', paidAt: null, comprobanteUrl: null },
    ...over,
  }) as unknown as Order;

const snap = (data: unknown) => ({ exists: () => data != null, data: () => data });

beforeEach(() => {
  getDocMock.mockReset();
});

describe('readOrderReceiptRefs — superficie NUEVA', () => {
  it('separa vinculados de candidatos y pone primero al que sostiene el estado', () => {
    const refs = readOrderReceiptRefs(
      orden({
        receiptAttachments: { linkedIds: [A2, A1], candidateIds: [A3], statusDrivenBy: A1 },
      }),
    );
    expect(refs.linkedIds).toEqual([A2, A1]);
    expect(refs.candidateIds).toEqual([A3]);
    expect(refs.statusDrivenBy).toBe(A1);
    expect(refs.allIds).toEqual([A1, A2, A3]); // el que mueve el estado, primero
  });

  it('un id vinculado que también quedó en candidateIds se cuenta UNA vez y como vinculado', () => {
    // `receiptStore` acumula el id en las dos listas al vincular: mostrarlo dos veces (una como
    // "posible", otra como "vinculado") le mentiría al vendedor sobre cuántos archivos hay.
    const refs = readOrderReceiptRefs(
      orden({ receiptAttachments: { linkedIds: [A1], candidateIds: [A1, A2], statusDrivenBy: A1 } }),
    );
    expect(refs.linkedIds).toEqual([A1]);
    expect(refs.candidateIds).toEqual([A2]);
    expect(refs.allIds).toEqual([A1, A2]);
  });

  it('pedido viejo sin metadata de adjuntos: no rompe y no inventa referencias', () => {
    const refs = readOrderReceiptRefs(orden());
    expect(refs.allIds).toEqual([]);
    expect(refs.statusDrivenBy).toBeNull();
    expect(readOrderReceiptRefs(null).allIds).toEqual([]);
    expect(readOrderReceiptRefs('no soy un pedido').allIds).toEqual([]);
  });
});

describe('readOrderReceiptRefs — superficie VIEJA (payment) y legacy', () => {
  it('lee el mismo objeto colgado de `payment` (por si el vínculo se escribe ahí)', () => {
    const refs = readOrderReceiptRefs(
      orden({
        payment: {
          method: 'transfer',
          paymentId: 'p',
          paidAt: null,
          comprobanteUrl: null,
          receiptAttachments: { linkedIds: [A1], candidateIds: [A2], statusDrivenBy: A1 },
        },
      }),
    );
    expect(refs.linkedIds).toEqual([A1]);
    expect(refs.candidateIds).toEqual([A2]);
    expect(refs.statusDrivenBy).toBe(A1);
  });

  it('lee un `payment.comprobanteAttachmentId` suelto como comprobante VINCULADO', () => {
    const refs = readOrderReceiptRefs(
      orden({
        payment: { method: 'transfer', paymentId: 'p', paidAt: null, comprobanteUrl: null, comprobanteAttachmentId: A2 },
      }),
    );
    expect(refs.linkedIds).toEqual([A2]);
    expect(refs.allIds).toEqual([A2]);
  });

  it('el comprobante LEGACY (una ruta en `payment.comprobanteUrl`) no produce ninguna referencia', () => {
    // Es una RUTA, no un attachmentId: lo abre el visor de pedido de siempre. Si acá se colara,
    // el panel intentaría leer `tenants/{t}/attachments/tenants/...` y el path traversal entraría
    // por la puerta de adelante.
    const refs = readOrderReceiptRefs(
      orden({
        payment: {
          method: 'transfer',
          paymentId: 'p',
          paidAt: null,
          comprobanteUrl: 'tenants/tnt_1/orders/ord_1/comprobantes/foto.jpg',
        },
      }),
    );
    expect(refs.allIds).toEqual([]);
  });
});

describe('readOrderReceiptRefs — validación de ids (seguridad)', () => {
  it('descarta todo lo que no sea un attachmentId: traversal, vacíos, tipos raros', () => {
    const refs = readOrderReceiptRefs(
      orden({
        receiptAttachments: {
          linkedIds: ['../../orders/ord_2', '', 'att_NO_HEX', 42, null, { attachmentId: A1 }, A1],
          candidateIds: 'no soy una lista',
          statusDrivenBy: '../../../tenants/otro/attachments/x',
        },
      }),
    );
    expect(refs.linkedIds).toEqual([A1]);
    expect(refs.candidateIds).toEqual([]);
    expect(refs.statusDrivenBy).toBeNull();
  });

  it('recorta la cantidad de adjuntos a leer por pedido', () => {
    const muchos = Array.from({ length: MAX_ORDER_ATTACHMENTS + 5 }, (_, i) =>
      'att_' + i.toString(16).padStart(24, '0'),
    );
    expect(readOrderReceiptRefs(orden({ receiptAttachments: { linkedIds: muchos } })).allIds).toHaveLength(
      MAX_ORDER_ATTACHMENTS,
    );
  });
});

describe('listAttachmentsByIds', () => {
  it('lee cada adjunto por su documento y devuelve la PROYECCIÓN, sin la ruta de Storage', async () => {
    getDocMock.mockImplementation((ref: string) =>
      Promise.resolve(snap(ref === `tenants/tnt_1/attachments/${A1}` ? rawAttachment() : null)),
    );
    const r = await listAttachmentsByIds('tnt_1', [A1]);
    expect(r.items).toHaveLength(1);
    const a = r.items[0]!;
    // La ruta, el checksum y la retención son datos del servidor: no vuelven al panel de ninguna
    // forma (ni como campo propio ni escondidos en un objeto anidado).
    expect(JSON.stringify(a)).not.toContain(PATH_STORAGE);
    expect(JSON.stringify(a)).not.toContain('checksum-secreto');
    expect(Object.keys(a)).not.toContain('storage');
    expect(a.attachmentId).toBe(A1);
    expect(a.mime.verified).toBe('image/jpeg');
  });

  it('un id referenciado que ya no existe se informa como faltante, no como error de pantalla', async () => {
    getDocMock.mockResolvedValue(snap(null));
    const r = await listAttachmentsByIds('tnt_1', [A1, A2]);
    expect(r.items).toEqual([]);
    expect(r.missingIds).toEqual([A1, A2]);
  });

  it('NUNCA arma una ruta con un id inválido (path traversal)', async () => {
    getDocMock.mockResolvedValue(snap(rawAttachment()));
    await listAttachmentsByIds('tnt_1', ['../../orders/ord_2', A1]);
    expect(getDocMock).toHaveBeenCalledTimes(1);
    expect(getDocMock).toHaveBeenCalledWith(`tenants/tnt_1/attachments/${A1}`);
  });

  it('sin ids válidos no toca Firestore', async () => {
    const r = await listAttachmentsByIds('tnt_1', ['', 'att_x']);
    expect(getDocMock).not.toHaveBeenCalled();
    expect(r).toEqual({ items: [], missingIds: [] });
  });

  it('propaga el rechazo de las reglas: la UI decide qué mostrar, no se traga el error', async () => {
    getDocMock.mockRejectedValue({ code: 'permission-denied', message: 'x' });
    await expect(listAttachmentsByIds('tnt_1', [A1])).rejects.toBeTruthy();
  });
});

describe('separarAdjuntosDelCliente', () => {
  it('deja afuera el adjunto de otro cliente aunque el pedido lo referencie', () => {
    const propio = toPanelAttachment(rawAttachment())!;
    const ajeno = toPanelAttachment(rawAttachment({ attachmentId: A2, customerId: '595990999999' }))!;
    const r = separarAdjuntosDelCliente([propio, ajeno], CLIENTE);
    expect(r.propios.map((a) => a.attachmentId)).toEqual([A1]);
    expect(r.ajenos.map((a) => a.attachmentId)).toEqual([A2]);
  });

  it('un adjunto sin customerId no se asume propio', () => {
    const sinCliente = toPanelAttachment({ ...rawAttachment(), customerId: undefined })!;
    expect(separarAdjuntosDelCliente([sinCliente], CLIENTE).propios).toEqual([]);
  });
});

describe('friendlyOrderAttachmentError', () => {
  it('nunca reenvía el mensaje crudo de Firestore (trae la ruta del documento adentro)', () => {
    const msg = friendlyOrderAttachmentError({
      code: 'permission-denied',
      message: `Missing or insufficient permissions on tenants/tnt_1/attachments/${A1}`,
    });
    expect(msg).not.toContain('tenants/');
    expect(msg).not.toContain(A1);
    expect(msg).toMatch(/permiso/i);
  });

  it('distingue falta de conexión de falta de permiso, y siempre dice qué hacer', () => {
    expect(friendlyOrderAttachmentError({ code: 'unavailable' })).toMatch(/conexión|reintent/i);
    expect(friendlyOrderAttachmentError(new Error('boom'))).toMatch(/reintent/i);
  });
});
