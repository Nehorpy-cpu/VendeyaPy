import { describe, it, expect } from 'vitest';
import type { ShippingParseReason, ShippingParseResult } from '@vpw/shared';
import {
  blocksManualSend,
  classifyDraft,
  messageForReason,
  deriveShippingQuote,
  SEND_ERROR_TEXT,
  formatGs,
  type ShippingDraftContext,
} from './shippingQuote';

const none = (reason: ShippingParseReason): ShippingParseResult => ({ kind: 'none', reason, parserVersion: 'shipping-parser-3' });
const matched = (gs: number): ShippingParseResult => ({ kind: 'matched', shippingGs: gs, parserVersion: 'shipping-parser-3' });
const free = (): ShippingParseResult => ({ kind: 'free', shippingGs: 0, parserVersion: 'shipping-parser-3' });

const baseCtx = (over: Partial<ShippingDraftContext> = {}): ShippingDraftContext => ({
  requestId: 'covr_abc123',
  status: 'pending_coverage_review',
  subtotalGs: 250000,
  locationFingerprint: 'loc:abc',
  cartFingerprint: 'cart:abc',
  expiresAtMs: 10_000,
  nowMs: 5_000,
  required: true,
  flowActive: true,
  canDecide: true,
  maxChargeGs: 5_000_000,
  draft: '',
  ...over,
});

describe('blocksManualSend — clasificación completa (decisión 6)', () => {
  it('true para costo detectado', () => {
    expect(blocksManualSend(matched(30000))).toBe(true);
    expect(blocksManualSend(free())).toBe(true);
  });
  it('true para intentos de costo no-limpios', () => {
    for (const r of ['monto_ambiguo', 'monto_invalido', 'monto_no_exacto', 'monto_negado', 'excede_maximo', 'cero_sin_gratuidad', 'gratis_con_monto', 'gratuidad_negada', 'gratuidad_condicional'] as ShippingParseReason[]) {
      expect(blocksManualSend(none(r))).toBe(true);
    }
  });
  it('false para texto común (sin intención de costo)', () => {
    for (const r of ['vacio', 'sin_contexto_envio', 'sin_monto'] as ShippingParseReason[]) {
      expect(blocksManualSend(none(r))).toBe(false);
    }
  });
  it('false para limite_invalido (error de config, no bloquea mensajes comunes)', () => {
    expect(blocksManualSend(none('limite_invalido'))).toBe(false);
  });
});

describe('classifyDraft (decisión 5)', () => {
  it('valid_amount / valid_free', () => {
    expect(classifyDraft(matched(30000))).toBe('valid_amount');
    expect(classifyDraft(free())).toBe('valid_free');
  });
  it('invalid_configuration para limite_invalido', () => {
    expect(classifyDraft(none('limite_invalido'))).toBe('invalid_configuration');
  });
  it('idle_unrelated para texto sin costo', () => {
    expect(classifyDraft(none('vacio'))).toBe('idle_unrelated');
    expect(classifyDraft(none('sin_contexto_envio'))).toBe('idle_unrelated');
    expect(classifyDraft(none('sin_monto'))).toBe('idle_unrelated');
  });
  it('invalid_price_attempt para el resto', () => {
    expect(classifyDraft(none('monto_ambiguo'))).toBe('invalid_price_attempt');
    expect(classifyDraft(none('monto_negado'))).toBe('invalid_price_attempt');
  });
});

describe('messageForReason — cada motivo a su mensaje', () => {
  it('los motivos de bloqueo y config tienen texto', () => {
    for (const r of ['monto_ambiguo', 'monto_no_exacto', 'monto_negado', 'monto_invalido', 'excede_maximo', 'cero_sin_gratuidad', 'gratis_con_monto', 'gratuidad_negada', 'gratuidad_condicional', 'limite_invalido'] as ShippingParseReason[]) {
      expect(messageForReason(r)).toBeTruthy();
    }
  });
  it('los motivos idle no muestran mensaje', () => {
    expect(messageForReason('vacio')).toBeNull();
    expect(messageForReason('sin_contexto_envio')).toBeNull();
    expect(messageForReason('sin_monto')).toBeNull();
  });
  it('textos distintos por motivo (no genéricos)', () => {
    expect(messageForReason('monto_ambiguo')).not.toBe(messageForReason('monto_negado'));
  });
});

describe('deriveShippingQuote — matched', () => {
  it('costo, productos y total correctos + canónico + payload', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'el envío cuesta ₲30.000' }));
    expect(vm.visible).toBe(true);
    expect(vm.draftClass).toBe('valid_amount');
    expect(vm.shippingText).toBe('30.000');
    expect(vm.subtotalText).toBe('250.000');
    expect(vm.totalText).toBe('280.000');
    expect(vm.canonical).toBe('El costo de envío para tu ubicación es ₲30.000.');
    expect(vm.canApprove).toBe(true);
    expect(vm.payload).toEqual({
      requestId: 'covr_abc123',
      sellerDraft: 'el envío cuesta ₲30.000',
      expectedLocationFingerprint: 'loc:abc',
      expectedCartFingerprint: 'cart:abc',
      confirmedShippingGs: 30000,
    });
  });
});

describe('deriveShippingQuote — free', () => {
  it('envío gratis ⇒ shipping 0, total = productos, canónico sin costo', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'envío gratis' }));
    expect(vm.draftClass).toBe('valid_free');
    expect(vm.shippingText).toBe('0');
    expect(vm.totalText).toBe('250.000');
    expect(vm.canonical).toBe('El envío para tu ubicación es sin costo.');
    expect(vm.canApprove).toBe(true);
    expect(vm.payload?.confirmedShippingGs).toBe(0);
  });
});

describe('deriveShippingQuote — gates', () => {
  it('idle_unrelated ("hola") ⇒ sin aprobar, sin bloqueo', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'hola, gracias' }));
    expect(vm.draftClass).toBe('idle_unrelated');
    expect(vm.canApprove).toBe(false);
    expect(vm.blocksManualSend).toBe(false);
    expect(vm.payload).toBeNull();
  });
  it('maxChargeGs inválido ⇒ invalid_configuration, sin aprobar (bloquea por intención de costo)', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'el envío ₲30.000', maxChargeGs: 0 }));
    expect(vm.draftClass).toBe('invalid_configuration');
    expect(vm.canApprove).toBe(false);
    expect(vm.blocksManualSend).toBe(true); // HARDEN-1: intención re-clasificada con límite defensivo
    expect(vm.message).toBeTruthy();
  });
  it('ambiguo ⇒ invalid_price_attempt, bloquea envío manual, sin aprobar', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'el envío ₲30.000 o ₲40.000' }));
    expect(vm.draftClass).toBe('invalid_price_attempt');
    expect(vm.blocksManualSend).toBe(true);
    expect(vm.canApprove).toBe(false);
  });
  it('no usable (required=false) ⇒ invisible', () => {
    expect(deriveShippingQuote(baseCtx({ required: false, draft: 'el envío ₲30.000' })).visible).toBe(false);
  });
  it('flujo apagado ⇒ invisible', () => {
    expect(deriveShippingQuote(baseCtx({ flowActive: false, draft: 'el envío ₲30.000' })).visible).toBe(false);
  });
  it('sin capacidad de decidir ⇒ invisible', () => {
    expect(deriveShippingQuote(baseCtx({ canDecide: false, draft: 'el envío ₲30.000' })).visible).toBe(false);
  });
  it('vencido ⇒ visible pero sin aprobar ni payload', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'el envío ₲30.000', nowMs: 20_000 }));
    expect(vm.visible).toBe(true);
    expect(vm.expired).toBe(true);
    expect(vm.canApprove).toBe(false);
    expect(vm.payload).toBeNull();
  });
  it('subtotal corrupto (computeOrderTotals tira) ⇒ sin aprobar, con mensaje, sin payload', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'el envío cuesta ₲30.000', subtotalGs: -100 }));
    expect(vm.canApprove).toBe(false);
    expect(vm.message).toBeTruthy();
    expect(vm.payload).toBeNull();
  });
  it('el payload NUNCA lleva customerId/actor/subtotal/total/PII', () => {
    const vm = deriveShippingQuote(baseCtx({ draft: 'el envío ₲30.000' }));
    expect(Object.keys(vm.payload!).sort()).toEqual(
      ['confirmedShippingGs', 'expectedCartFingerprint', 'expectedLocationFingerprint', 'requestId', 'sellerDraft'].sort(),
    );
  });
});

describe('deriveShippingQuote — HARDEN-1 A: config inválida sin bypass', () => {
  const inv = (draft: string) => deriveShippingQuote(baseCtx({ draft, maxChargeGs: 0 }));
  it('max inválido + "hola" ⇒ blocksManualSend=false, sin aprobar, sin payload', () => {
    const vm = inv('hola, gracias');
    expect(vm.blocksManualSend).toBe(false);
    expect(vm.canApprove).toBe(false);
    expect(vm.payload).toBeNull();
  });
  it('max inválido + "te confirmo luego el envío" ⇒ false', () => {
    expect(inv('te confirmo luego el envío').blocksManualSend).toBe(false);
  });
  it('max inválido + "el envío cuesta ₲30.000" ⇒ true (intención de costo)', () => {
    const vm = inv('el envío cuesta ₲30.000');
    expect(vm.blocksManualSend).toBe(true);
    expect(vm.canApprove).toBe(false);
    expect(vm.payload).toBeNull();
  });
  it('max inválido + monto ambiguo ⇒ true', () => {
    expect(inv('el envío ₲30.000 o ₲40.000').blocksManualSend).toBe(true);
  });
  it('max inválido + gratuidad condicional ⇒ true', () => {
    expect(inv('envío gratis desde ₲150.000').blocksManualSend).toBe(true);
  });
  it('max inválido: canApprove=false y payload=null en todos los casos', () => {
    for (const d of ['hola', 'el envío cuesta ₲30.000', 'el envío ₲30.000 o ₲40.000', 'envío gratis']) {
      const vm = inv(d);
      expect(vm.canApprove).toBe(false);
      expect(vm.payload).toBeNull();
    }
  });
});

describe('SEND_ERROR_TEXT / formatGs', () => {
  it('unknown tiene el texto EXACTO', () => {
    expect(SEND_ERROR_TEXT.unknown).toBe('No pudimos confirmar el envío. Revisá el historial antes de intentar otra acción.');
  });
  it('formatGs reusa el helper compartido', () => {
    expect(formatGs(280000)).toBe('280.000');
    expect(formatGs(0)).toBe('0');
  });
});
