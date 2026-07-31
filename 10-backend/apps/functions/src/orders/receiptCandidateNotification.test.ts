import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  RECEIPT_CANDIDATE_NOTIFICATION_CATEGORY,
  buildReceiptCandidateNotification,
  receiptCandidateNotificationId,
} from './receiptCandidateNotification.js';

/**
 * DISCRIMINANTE B2 — al cliente se le promete que «un vendedor lo revisa». Este archivo prueba
 * que esa promesa produce una SEÑAL real, idempotente, que nadie confunde con un pago confirmado
 * y que no filtra el teléfono del cliente.
 *
 * La ESCRITURA del aviso se prueba en `receiptGateRollout.test.ts`: desde ADR-0016 §11 la hace la
 * misma transacción que crea el candidato, así que acá solo queda la forma del documento.
 */
const TENANT = 'tnt_demo';
const CLIENTE = '595981000111';
const ATT = 'att_0123456789abcdef01234567';
const NOW = Timestamp.fromMillis(1_700_000_000_000);

const entrada = { tenantId: TENANT, customerId: CLIENTE, orderId: 'ord_1', attachmentId: ATT };

describe('receiptCandidateNotification — la señal operativa del candidato', () => {
  it('el aviso usa la campana EXISTENTE y apunta a la conversación del cliente', () => {
    const { id, data } = buildReceiptCandidateNotification(entrada, NOW);

    expect(id).toBe(`receipt-candidate-${ATT}`);
    // Categoría conocida por el panel ⇒ el CTA abre /conversations?c=… y las rules la dejan leer.
    expect(data['category']).toBe(RECEIPT_CANDIDATE_NOTIFICATION_CATEGORY);
    expect(data['category']).toBe('handoff');
    expect(data['dedupeKey']).toBe(id);
    expect(data['read']).toBe(false);
    expect(data['customerId']).toBe(CLIENTE);
  });

  it('el texto NO afirma un pago confirmado ni dice que el bot se pausó', () => {
    const { data } = buildReceiptCandidateNotification(entrada, NOW);
    const texto = `${data['title'] as string} ${data['body'] as string}`;

    expect(texto).toMatch(/SUGERIDO|sugerido/);
    expect(texto).toMatch(/revisa/i);
    // El candidato NO confirma nada y NO saca al bot del chat (ADR-0016 §3).
    expect(texto).not.toMatch(/pago confirmado|pagado|cobrado/i);
    expect(texto).not.toMatch(/en pausa|dejó de responder|tomó la conversación/i);
  });

  it('NUNCA sale el teléfono completo del cliente en el texto del aviso', () => {
    const { data } = buildReceiptCandidateNotification(entrada, NOW);
    const texto = `${data['title'] as string} ${data['body'] as string}`;

    expect(texto).not.toContain(CLIENTE);
    expect(texto).toContain(`…${CLIENTE.slice(-4)}`);
  });

  it('el id es determinístico por adjunto (idempotencia por (tenant, attachmentId))', () => {
    expect(receiptCandidateNotificationId(ATT)).toBe(receiptCandidateNotificationId(ATT));
    expect(receiptCandidateNotificationId('att_ffffffffffffffffffffffff')).not.toBe(
      receiptCandidateNotificationId(ATT),
    );
    // Un id inesperado no puede fabricar un path con separadores.
    expect(receiptCandidateNotificationId('att_../../otro')).not.toMatch(/[/]/);
  });

  it('el documento es determinístico: mismos datos ⇒ mismo id y mismo cuerpo', () => {
    const a = buildReceiptCandidateNotification(entrada, NOW);
    const b = buildReceiptCandidateNotification(entrada, NOW);
    expect(a).toEqual(b);
    // Y el id que se guarda ADENTRO coincide con el que nombra el documento: el `create` de la
    // transacción usa ese id, así que si se desincronizaran la campana se duplicaría.
    expect(a.data['id']).toBe(a.id);
    expect(a.data['tenantId']).toBe(TENANT);
  });

  it('el aviso no lleva rutas de Storage, URLs firmadas ni ids del proveedor', () => {
    const { data } = buildReceiptCandidateNotification(entrada, NOW);
    const serializado = JSON.stringify(data);
    expect(serializado).not.toMatch(/https?:|tenants\/|wamid\.|storage/i);
  });
});
