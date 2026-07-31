/**
 * attachmentReplies.contrato.test.ts — El contrato entre el gate y la respuesta al cliente.
 *
 * Por qué existe: el gate de comprobante (`orders/receiptGate.ts`) y los textos que se le mandan al
 * cliente (`meta/attachmentReplies.ts`) viven en módulos distintos a propósito — `meta/` no puede
 * importar `orders/`, esa es la costura del ADR-0016 §4. El precio de ese desacople es que las dos
 * listas de motivos pueden desalinearse en silencio: durante este mismo programa se agregó
 * `attachment_purged` al gate y quedó SIN mensaje, así que un rechazo real habría caído al texto
 * genérico sin que nada avisara.
 *
 * Este test ata las dos listas. Si alguien suma un motivo de rechazo en el gate y no le escribe una
 * respuesta, acá se entera. El desacople sigue siendo deliberado; lo que deja de ser opcional es
 * mantenerlo coherente.
 */
import { describe, it, expect } from 'vitest';
import type { ReceiptGateDenyReason } from '../orders/receiptGate.js';
import { respuestaPorAdjunto, type AttachmentReplyReason } from './attachmentReplies.js';

/**
 * Comprobación EN TIEMPO DE COMPILACIÓN: `AttachmentReplyReason` debe ser superconjunto de
 * `ReceiptGateDenyReason`. Si el gate suma un motivo que no existe acá, esta línea no compila y
 * `pnpm -r typecheck` falla — antes incluso de correr los tests.
 */
type _TodoMotivoDelGateTieneRespuesta = ReceiptGateDenyReason extends AttachmentReplyReason ? true : never;
const _prueba: _TodoMotivoDelGateTieneRespuesta = true;

/** Lista exhaustiva y explícita: si el gate agrega uno, el test de abajo lo detecta. */
const MOTIVOS_DEL_GATE: ReceiptGateDenyReason[] = [
  'tenant_mismatch',
  'customer_mismatch',
  'classification_not_open',
  'no_explicit_payment_context',
  'no_admissible_order',
  'ambiguous_orders',
  'order_customer_mismatch',
  'order_not_admissible',
  'order_already_paid',
  'outside_time_window',
  'attachment_not_stored',
  'attachment_purged',
  'mime_not_allowed',
  'size_not_allowed',
];

describe('contrato gate ↔ respuesta al cliente', () => {
  it('la comprobación de tipos se mantiene (si esto no compila, el typecheck ya falló)', () => {
    expect(_prueba).toBe(true);
  });

  it('TODO motivo de rechazo del gate produce una respuesta no vacía', () => {
    for (const motivo of MOTIVOS_DEL_GATE) {
      for (const clase of ['image', 'document', 'unknown'] as const) {
        const texto = respuestaPorAdjunto(motivo, clase);
        expect(texto, `${motivo} / ${clase}`).toBeTruthy();
        expect(texto.trim().length, `${motivo} / ${clase}`).toBeGreaterThan(10);
      }
    }
  });

  /**
   * Motivos que comparten el texto genérico A PROPÓSITO. Los cuatro primeros son inconsistencias
   * INTERNAS: decirle al cliente "ese pedido es de otro cliente" o "tu adjunto ya estaba
   * clasificado" filtraría información del sistema y no le sirve para nada. El quinto es
   * literalmente la definición del genérico: sin contexto de pago, un archivo es un archivo.
   */
  const GENERICO_DELIBERADO: ReceiptGateDenyReason[] = [
    'tenant_mismatch',
    'customer_mismatch',
    'classification_not_open',
    'order_customer_mismatch',
    'no_explicit_payment_context',
  ];

  it('cada motivo tiene texto propio, o está en la lista de genéricos deliberados', () => {
    // El valor de este test no es prohibir el genérico: es obligar a DECIDIR. Un motivo nuevo o
    // tiene su propia redacción, o queda explícitamente acá con su razón — nunca por olvido.
    const generico = respuestaPorAdjunto(undefined, 'image');
    const compartenGenerico = MOTIVOS_DEL_GATE.filter((m) => respuestaPorAdjunto(m, 'image') === generico);
    expect(compartenGenerico.sort()).toEqual([...GENERICO_DELIBERADO].sort());
  });

  it('los motivos internos NO le cuentan al cliente por qué falló de verdad', () => {
    // Un mensaje que dijera "el pedido pertenece a otro cliente" filtraría la existencia de ese
    // pedido. El genérico es la respuesta correcta, y tiene que seguir siéndolo.
    for (const motivo of ['tenant_mismatch', 'customer_mismatch', 'order_customer_mismatch'] as const) {
      const texto = respuestaPorAdjunto(motivo, 'image').toLowerCase();
      expect(texto).not.toMatch(/otro cliente|otra empresa|tenant|pertenece/);
    }
  });

  it('una recepción nunca queda muda: sin motivo también hay respuesta', () => {
    for (const clase of ['image', 'document', 'unknown'] as const) {
      expect(respuestaPorAdjunto(null, clase).trim()).not.toBe('');
      expect(respuestaPorAdjunto(undefined, clase).trim()).not.toBe('');
    }
  });
});
