import { describe, it, expect } from 'vitest';

/**
 * ADR-0016 §4 — «un rechazo NUNCA bloquea la conversación: se responde al cliente». Este archivo
 * prueba la pieza que hace posible esa promesa: para CUALQUIER motivo hay un texto, y ese texto es
 * honesto y sin vertical.
 */

import { respuestaPorAdjunto, ATTACHMENT_REPLIES, type AttachmentReplyReason } from './attachmentReplies.js';
// SOLO tipo: `meta/` no depende de `orders/` en runtime (costura del gate). La importación de tipo
// existe para que el compilador verifique que ningún motivo del gate se quede sin redacción.
import type { ReceiptGateDenyReason } from '../orders/receiptGate.js';

/**
 * GUARD DE COMPILACIÓN: si mañana se agrega un motivo al gate y no se agrega acá, esto no compila
 * (y `pnpm -r typecheck` se pone rojo) en vez de degradar en silencio al texto genérico.
 */
type MotivosDelGateCubiertos = ReceiptGateDenyReason extends AttachmentReplyReason ? true : never;
const _cobertura: MotivosDelGateCubiertos = true;
void _cobertura;

const TODOS: AttachmentReplyReason[] = [
  'too_large',
  'unsupported_type',
  'download_failed',
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
  'mime_not_allowed',
  'size_not_allowed',
];

describe('respuestaPorAdjunto — ninguna recepción de archivo queda muda', () => {
  it.each(TODOS)('el motivo "%s" siempre produce un texto para el cliente', (reason) => {
    for (const clase of ['image', 'document', 'unknown'] as const) {
      expect(respuestaPorAdjunto(reason, clase).trim().length).toBeGreaterThan(0);
    }
  });

  it('sin motivo (el caso más común: medio normal) también responde', () => {
    expect(respuestaPorAdjunto(null, 'image')).toContain('dejo en la conversación');
    expect(respuestaPorAdjunto(undefined, 'document')).toContain('dejo en la conversación');
  });

  it('el sustantivo se adapta: a un PDF del banco no se le dice "imagen"', () => {
    expect(respuestaPorAdjunto('no_admissible_order', 'image')).toContain('tu imagen');
    expect(respuestaPorAdjunto('no_admissible_order', 'document')).toContain('tu archivo');
    expect(respuestaPorAdjunto('no_admissible_order', 'document')).not.toContain('imagen');
  });

  it('los motivos de la ingesta reusan la MISMA redacción neutra (una sola fuente)', () => {
    expect(respuestaPorAdjunto('too_large', 'image')).toBe(ATTACHMENT_REPLIES.too_large);
    expect(respuestaPorAdjunto('size_not_allowed', 'document')).toBe(ATTACHMENT_REPLIES.too_large);
    expect(respuestaPorAdjunto('unsupported_type', 'image')).toBe(ATTACHMENT_REPLIES.unsupported_type);
    expect(respuestaPorAdjunto('mime_not_allowed', 'image')).toBe(ATTACHMENT_REPLIES.unsupported_type);
    expect(respuestaPorAdjunto('download_failed', 'image')).toBe(ATTACHMENT_REPLIES.download_failed);
  });

  it('NUNCA promete que el pago quedó confirmado ni menciona un rubro (multi-vertical)', () => {
    for (const reason of [...TODOS, null]) {
      const texto = respuestaPorAdjunto(reason, 'image').toLowerCase();
      expect(texto).not.toContain('perfum');
      expect(texto).not.toContain('crédito');
      // "pago confirmado" / "quedó pagado" jamás: confirmar un pago es una decisión humana (§5).
      expect(texto).not.toContain('confirmado');
      expect(texto).not.toContain('quedó pagado');
    }
  });

  it('un problema NUESTRO (tenant/cliente mal apareados) no se le explica al cliente', () => {
    // Se responde igual —no se lo deja mudo— pero con el texto genérico: los códigos internos no
    // se filtran a la conversación.
    for (const reason of ['tenant_mismatch', 'customer_mismatch', 'classification_not_open'] as const) {
      expect(respuestaPorAdjunto(reason, 'image')).toBe(respuestaPorAdjunto(null, 'image'));
    }
  });
});
