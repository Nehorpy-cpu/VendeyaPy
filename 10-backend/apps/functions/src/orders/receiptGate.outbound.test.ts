import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Attachment } from '@vpw/shared';
import {
  decideMarkAsReceipt,
  evaluateReceiptGate,
  DEFAULT_RECEIPT_GATE_CONFIG,
  type ReceiptGateAttachmentFacts,
  type ReceiptMarkOrderFacts,
} from './receiptGate.js';
import { toReceiptAttachmentFacts } from './receiptStore.js';
import { mensajeDeMotivo } from '../functions/attachments/attachmentCallables.js';

/**
 * ADR-0021 §5 — UN ADJUNTO SALIENTE JAMÁS PUEDE VOLVERSE COMPROBANTE.
 * El envío manual del panel crea adjuntos `direction:'out'` del MISMO customerId que los
 * entrantes: sin este guard, una imagen que mandó el PROPIO equipo podía marcarse como
 * comprobante de pago del cliente.
 */

const facts = (over: Partial<ReceiptGateAttachmentFacts> = {}): ReceiptGateAttachmentFacts => ({
  attachmentId: 'att_0123456789abcdef01234567',
  tenantId: 'arfagi',
  customerId: '595994893000',
  ingestState: 'stored',
  classification: 'generic_media',
  orderCandidateId: null,
  mimeVerified: 'image/jpeg',
  bytes: 1024,
  purgedAtMs: null,
  ...over,
});

const orderFacts = (over: Partial<ReceiptMarkOrderFacts> = {}): ReceiptMarkOrderFacts => ({
  orderId: 'ord_1',
  customerId: '595994893000',
  status: 'PENDING_PAYMENT',
  createdAtMs: 0,
  linkedAttachmentIds: [],
  linkedReceiptIds: [],
  statusDrivenBy: null,
  ...over,
});

describe('decideMarkAsReceipt — guard de dirección', () => {
  it('adjunto SALIENTE (direction out) ⇒ attachment_outbound, aunque todo lo demás sea válido', () => {
    const r = decideMarkAsReceipt({ tenantId: 'arfagi', attachment: facts({ direction: 'out' }), order: orderFacts() });
    expect(r).toEqual({ ok: false, reason: 'attachment_outbound' });
  });

  it('adjunto entrante (direction in o ausente/legacy) sigue marcándose normalmente', () => {
    for (const direction of ['in' as const, undefined]) {
      const r = decideMarkAsReceipt({ tenantId: 'arfagi', attachment: facts({ direction }), order: orderFacts() });
      expect(r.ok).toBe(true);
    }
  });

  it('mensajeDeMotivo traduce attachment_outbound a un failed-precondition claro', () => {
    const { code, message } = mensajeDeMotivo('attachment_outbound');
    expect(code).toBe('failed-precondition');
    expect(message).toMatch(/saliente|equipo/i);
  });
});

describe('toReceiptAttachmentFacts — la dirección viaja a las reglas puras', () => {
  const doc = (direction: 'in' | 'out'): Attachment =>
    ({
      attachmentId: 'att_0123456789abcdef01234567',
      tenantId: 'arfagi',
      customerId: '595994893000',
      conversationId: '595994893000',
      messageId: 'pmid_0123456789abcdef01234567',
      providerMessageId: 'pmid_0123456789abcdef01234567',
      channel: 'whatsapp',
      class: 'image',
      direction,
      author: direction === 'out' ? 'seller' : 'customer',
      ingestState: 'stored',
      classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: null },
      caption: '',
      filename: null,
      mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
      bytes: 10,
      checksum: 'x',
      storage: { path: 'tenants/arfagi/attachments/01/att_0123456789abcdef01234567' },
      orderCandidateId: null,
      retentionUntil: null,
      purgedAt: null,
      createdAt: Timestamp.fromMillis(0),
      updatedAt: Timestamp.fromMillis(0),
      lastError: null,
    }) as Attachment;

  it('mapea direction out/in desde el documento', () => {
    expect(toReceiptAttachmentFacts(doc('out')).direction).toBe('out');
    expect(toReceiptAttachmentFacts(doc('in')).direction).toBe('in');
  });
});

describe('gate automático — el doc saliente tampoco puede proponerse como candidato', () => {
  it('nace generic_media ⇒ classification_not_open (el gate solo opina sobre unclassified)', () => {
    const r = evaluateReceiptGate({
      tenantId: 'arfagi',
      customerId: '595994893000',
      nowMs: 1000,
      attachment: facts({ direction: 'out', classification: 'generic_media' }),
      session: { awaitingPaymentDeclared: true, pendingOrderId: null },
      candidateOrders: [orderFacts()],
      config: { ...DEFAULT_RECEIPT_GATE_CONFIG, enabled: true },
    });
    expect(r).toMatchObject({ ok: false, reason: 'classification_not_open' });
  });
});
