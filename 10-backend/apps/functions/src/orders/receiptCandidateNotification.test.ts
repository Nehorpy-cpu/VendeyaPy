import { describe, it, expect, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  RECEIPT_CANDIDATE_NOTIFICATION_CATEGORY,
  buildReceiptCandidateNotification,
  notifyReceiptCandidate,
  receiptCandidateNotificationId,
  type ReceiptCandidateNotifyDeps,
} from './receiptCandidateNotification.js';

/**
 * DISCRIMINANTE B2 — al cliente se le promete que «un vendedor lo revisa». Este archivo prueba
 * que esa promesa produce una SEÑAL real, idempotente, que nadie confunde con un pago confirmado
 * y que no filtra el teléfono del cliente.
 */
const TENANT = 'tnt_demo';
const CLIENTE = '595981000111';
const ATT = 'att_0123456789abcdef01234567';
const NOW = Timestamp.fromMillis(1_700_000_000_000);

const entrada = { tenantId: TENANT, customerId: CLIENTE, orderId: 'ord_1', attachmentId: ATT };

const deps = (over: Partial<ReceiptCandidateNotifyDeps> = {}): ReceiptCandidateNotifyDeps => ({
  create: vi.fn(async () => undefined),
  now: () => NOW,
  ...over,
});

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

  it('crea el aviso una sola vez: el reintento del webhook choca con el id y no duplica', async () => {
    const yaExiste = Object.assign(new Error('already exists'), { code: 6 });
    const d = deps({ create: vi.fn(async () => { throw yaExiste; }) });

    await expect(notifyReceiptCandidate(entrada, d)).resolves.toBe(false);
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.create).toHaveBeenCalledWith(TENANT, `receipt-candidate-${ATT}`, expect.objectContaining({ tenantId: TENANT }));
  });

  it('BEST-EFFORT: si la campana falla, NO se propaga el error (el archivo ya está guardado)', async () => {
    const d = deps({ create: vi.fn(async () => { throw new Error('firestore caído'); }) });
    await expect(notifyReceiptCandidate(entrada, d)).resolves.toBe(false);
  });

  it('camino feliz: devuelve true y escribe una sola vez', async () => {
    const d = deps();
    await expect(notifyReceiptCandidate(entrada, d)).resolves.toBe(true);
    expect(d.create).toHaveBeenCalledTimes(1);
  });
});
