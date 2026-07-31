import { describe, it, expect } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertReceiptActor, mensajeDeMotivo, validarEntrada } from './attachmentCallables.js';

/**
 * ADR-0016 §5 — Quién puede decidir qué es un comprobante. Helpers PUROS de las callables;
 * la parte transaccional se cubre en `orders/receiptStore.test.ts`.
 */
const ATT = 'att_0123456789abcdef01234567';
const auth = (role: string, tenantId: string | undefined = 'tnt_demo', uid = 'uid_1') =>
  ({ uid, token: { role, tenantId } }) as unknown as Parameters<typeof assertReceiptActor>[0];

describe('attachmentCallables assertReceiptActor — roles REALES del sistema', () => {
  it('owner, manager y seller del tenant pueden', () => {
    for (const role of ['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER']) {
      expect(assertReceiptActor(auth(role)).tenantId).toBe('tnt_demo');
    }
  });

  it('TENANT_VIEWER no puede (es solo lectura)', () => {
    expect(() => assertReceiptActor(auth('TENANT_VIEWER'))).toThrowError(/rol/i);
  });

  it('PLATFORM_ADMIN tampoco: el soporte no decide comprobantes de un negocio ajeno', () => {
    expect(() => assertReceiptActor(auth('PLATFORM_ADMIN'))).toThrowError(/soporte de plataforma/);
  });

  it('sin sesión ⇒ unauthenticated; sin empresa ⇒ permission-denied', () => {
    expect(() => assertReceiptActor(null)).toThrowError(/sesión/i);
    const sinEmpresa = { uid: 'u', token: { role: 'TENANT_OWNER' } } as unknown as Parameters<typeof assertReceiptActor>[0];
    expect(() => assertReceiptActor(sinEmpresa)).toThrowError(/empresa/i);
  });

  it('cross-tenant imposible: el tenant sale de los claims y el pedido solo puede coincidir', () => {
    expect(assertReceiptActor(auth('SELLER'), 'tnt_demo').tenantId).toBe('tnt_demo');
    expect(() => assertReceiptActor(auth('SELLER'), 'tnt_otro')).toThrowError(/acceso/i);
  });
});

describe('attachmentCallables validarEntrada — forma cerrada del adjunto', () => {
  it('acepta un attachmentId válido y un orderId con forma de segmento', () => {
    expect(validarEntrada({ attachmentId: ` ${ATT} `, orderId: 'ord_abc123' })).toEqual({
      attachmentId: ATT,
      orderId: 'ord_abc123',
    });
  });

  it('rechaza adjuntos con formato inventado (nunca un mediaId crudo ni un path)', () => {
    for (const attachmentId of ['', 'att_XYZ', 'wamid.HBg', 'tenants/t/attachments/x', undefined]) {
      expect(() => validarEntrada({ attachmentId, orderId: 'ord_1' })).toThrowError(/Adjunto inválido/);
    }
  });

  it('rechaza orderId con separadores o path traversal', () => {
    for (const orderId of ['', '../otro', 'a/b', 'x'.repeat(200), undefined]) {
      expect(() => validarEntrada({ attachmentId: ATT, orderId })).toThrowError(/Pedido inválido/);
    }
  });
});

describe('attachmentCallables mensajeDeMotivo — el motivo interno nunca sale crudo', () => {
  it('mapea a códigos de HttpsError y a texto entendible, sin filtrar estructura', () => {
    expect(mensajeDeMotivo('attachment_not_found').code).toBe('not-found');
    expect(mensajeDeMotivo('order_already_paid')).toEqual({
      code: 'failed-precondition',
      message: expect.stringMatching(/ya está pagado/),
    });
    expect(mensajeDeMotivo('other_evidence_drives_status').message).toMatch(/Otro comprobante/);
    // Ningún mensaje devuelve el código interno ni menciona colecciones/rutas.
    for (const reason of ['tenant_mismatch', 'order_customer_mismatch', 'not_linked', 'linked_to_another_order'] as const) {
      const { message } = mensajeDeMotivo(reason);
      expect(message).not.toMatch(/tenants\/|attachments\/|_mismatch|_not_/);
    }
  });

  it('distingue "todavía no está" de "ya no está": un adjunto purgado no invita a reintentar', () => {
    const noStored = mensajeDeMotivo('attachment_not_stored');
    const purgado = mensajeDeMotivo('attachment_purged');
    expect(noStored.message).toMatch(/probá de nuevo/i);
    // Los bytes se borraron por retención y no vuelven: decir "probá de nuevo" mandaría al
    // vendedor a reintentar para siempre.
    expect(purgado.message).not.toMatch(/probá de nuevo/i);
    expect(purgado.message).toMatch(/retención/i);
    expect(purgado.message).not.toMatch(/tenants\/|attachments\/|_mismatch|_not_|purgedAt/);
  });

  it('un motivo desconocido cae en un mensaje genérico (fail-closed)', () => {
    const r = mensajeDeMotivo('classification_not_open');
    expect(r.code).toBe('failed-precondition');
    expect(new HttpsError(r.code, r.message).code).toBe('failed-precondition');
  });
});
