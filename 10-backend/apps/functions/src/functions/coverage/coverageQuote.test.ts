/**
 * SHIPPING-CHAT-3C — helpers PUROS de la saga de cotización.
 * La saga completa (TX-A → claim → Meta → TX-C, recuperación, unknown, sent_not_applied) se
 * verifica end-to-end en scripts/verify-shipping-quote-saga.mjs (emulador limpio).
 */
import { describe, it, expect } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { validarQuoteInput, outboxIdDeQuote, faseDeIntentoQuote, totalConEnvioSeguro } from './coverageQuote.js';

const base = {
  requestId: 'covr_abc123DEF456',
  sellerDraft: 'el costo de envío para tu ubicación es ₲30.000',
  confirmedShippingGs: 30000,
  expectedLocationFingerprint: 'geo:abc123',
  expectedCartFingerprint: 'cart2:def456',
};

describe('coverageQuote validarQuoteInput — validación pura del contrato', () => {
  it('input válido pasa tal cual (sellerDraft SIN normalizar — el server re-parsea el original)', () => {
    expect(validarQuoteInput(base)).toEqual(base);
  });
  it('requestId con formato covr_ obligatorio', () => {
    expect(() => validarQuoteInput({ ...base, requestId: 'ord_abc123DEF456' })).toThrow(HttpsError);
    expect(() => validarQuoteInput({ ...base, requestId: '' })).toThrow(/inválida/);
  });
  it('sellerDraft: no vacío y ≤ 4096 (tope de la Cloud API)', () => {
    expect(() => validarQuoteInput({ ...base, sellerDraft: '   ' })).toThrow(/Borrador/);
    expect(() => validarQuoteInput({ ...base, sellerDraft: 'a'.repeat(4097) })).toThrow(/Borrador/);
  });
  it('confirmedShippingGs: entero seguro ≥ 0 (0 = gratis confirmado); NaN/float/negativo/string rechazados', () => {
    expect(validarQuoteInput({ ...base, confirmedShippingGs: 0 }).confirmedShippingGs).toBe(0);
    for (const bad of [NaN, 1.5, -1, Infinity, Number.MAX_SAFE_INTEGER + 1, '30000' as unknown as number]) {
      expect(() => validarQuoteInput({ ...base, confirmedShippingGs: bad })).toThrow(/Monto/);
    }
  });
  it('fingerprints: obligatorias, ≤ 64', () => {
    expect(() => validarQuoteInput({ ...base, expectedLocationFingerprint: '' })).toThrow(/huellas/);
    expect(() => validarQuoteInput({ ...base, expectedCartFingerprint: 'x'.repeat(65) })).toThrow(/huellas/);
  });
  it('errores llevan details.kind estable sin datos sensibles', () => {
    try {
      validarQuoteInput({ ...base, requestId: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('invalid_input');
      expect((e as HttpsError).message).not.toContain(base.sellerDraft);
    }
  });
});

describe('coverageQuote outboxIdDeQuote — id determinístico por intento', () => {
  it('requestId + action quote + quoteAttemptId (nonce): jamás colisiona con los legacy', () => {
    const id = outboxIdDeQuote('covr_abc123DEF456', 'qat_XYZ987654321');
    expect(id).toBe('covr_abc123DEF456_quote_qat_XYZ987654321');
    // Los legacy son `${requestId}_{approved|rejected|expired|empty_cart}[_atm_*]` — sin 'quote'.
    expect(id).not.toMatch(/_approved|_rejected|_expired|_empty_cart/);
  });
});

// SHIPPING-CHAT-3C-HARDEN-1
describe('faseDeIntentoQuote — fase derivada del outbox (única fuente de verdad, sin duplicar estado)', () => {
  const now = 1_000_000;
  it('prepared ⇒ preparing', () => {
    expect(faseDeIntentoQuote('prepared', null, now)).toBe('preparing');
  });
  it('sending con lease vigente ⇒ in_progress', () => {
    expect(faseDeIntentoQuote('sending', now + 5_000, now)).toBe('in_progress');
  });
  it('sending con lease vencido o sin lease ⇒ unknown (el mensaje PUDO salir)', () => {
    expect(faseDeIntentoQuote('sending', now - 1, now)).toBe('unknown');
    expect(faseDeIntentoQuote('sending', null, now)).toBe('unknown');
  });
  it('sent ⇒ sent_pending_approval', () => {
    expect(faseDeIntentoQuote('sent', null, now)).toBe('sent_pending_approval');
  });
  it('failed y sent_not_applied ⇒ failed', () => {
    expect(faseDeIntentoQuote('failed', null, now)).toBe('failed');
    expect(faseDeIntentoQuote('sent_not_applied', null, now)).toBe('failed');
  });
  it('sent_applied con pointer vivo = invariante rota ⇒ failed (TX-C limpia el pointer en el mismo commit)', () => {
    expect(faseDeIntentoQuote('sent_applied', null, now)).toBe('failed');
  });
  it('unknown ⇒ unknown', () => {
    expect(faseDeIntentoQuote('unknown', null, now)).toBe('unknown');
  });
});

describe('totalConEnvioSeguro — total por la ÚNICA fuente compartida, jamás suma directa', () => {
  it('total válido = subtotal + envío (envío 0 = gratis confirmado)', () => {
    expect(totalConEnvioSeguro(100_000, 30_000)).toBe(130_000);
    expect(totalConEnvioSeguro(100_000, 0)).toBe(100_000);
  });
  it('subtotal + envío fuera del rango entero seguro ⇒ failed-precondition total_invalido', () => {
    try {
      totalConEnvioSeguro(Number.MAX_SAFE_INTEGER - 1000, 19_000);
      expect.unreachable();
    } catch (e) {
      expect((e as HttpsError).code).toBe('failed-precondition');
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('total_invalido');
    }
  });
  it('entradas corruptas (float/negativo/NaN) ⇒ total_invalido, jamás un número basura', () => {
    for (const bad of [1.5, -1, NaN]) {
      expect(() => totalConEnvioSeguro(bad, 1000)).toThrow(HttpsError);
      expect(() => totalConEnvioSeguro(100_000, bad)).toThrow(HttpsError);
    }
  });
});
