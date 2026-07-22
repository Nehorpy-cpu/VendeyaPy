/**
 * coverage.quote.test.ts — SHIPPING-CHAT-4B: adapters de la saga de cotización + mapQuoteError.
 * Cubre: payload exacto de las 3 callables, flow state nuevo y con skew antiguo, y el mapeo
 * kind-por-kind (defensivo: jamás por strings del mensaje; sin kind ⇒ generic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const llamadas: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('firebase/functions', () => ({
  httpsCallable: (_fns: unknown, name: string) => {
    llamadas[name] ??= vi.fn().mockResolvedValue({ data: {} });
    return (payload: unknown) => llamadas[name](payload);
  },
}));
vi.mock('./firebase', () => ({ firebaseFunctions: () => ({}), firebaseDb: () => ({}) }));

import {
  getCoverageFlowState,
  quoteAndApproveCoverage,
  getCoverageQuoteAttemptState,
  resolveCoverageQuoteUnknown,
  mapQuoteError,
} from './coverage';
import type { ShippingConfirmPayload } from './shippingQuote';

const payload: ShippingConfirmPayload = {
  requestId: 'covr_abc123DEF456',
  sellerDraft: 'El costo de envío para tu ubicación es ₲30.000',
  confirmedShippingGs: 30000,
  expectedLocationFingerprint: 'geo:abc',
  expectedCartFingerprint: 'cart2:def',
};
const evidencia = { canonical: 'El costo de envío para tu ubicación es ₲30.000.', totalGs: 130000 };

beforeEach(() => {
  for (const k of Object.keys(llamadas)) llamadas[k].mockClear().mockResolvedValue({ data: {} });
});

describe('adapters de la saga (payload exacto por callable)', () => {
  it('quoteAndApproveCoverage envía tenantId + el contrato compartido completo', async () => {
    llamadas['coverageQuoteAndApprove'] = vi.fn().mockResolvedValue({ data: { ok: true, status: 'coverage_approved', shippingGs: 30000, totalGs: 130000 } });
    const r = await quoteAndApproveCoverage('perfumeria', payload);
    expect(llamadas['coverageQuoteAndApprove']).toHaveBeenCalledTimes(1);
    expect(llamadas['coverageQuoteAndApprove']).toHaveBeenCalledWith({ tenantId: 'perfumeria', ...payload });
    expect(r.shippingGs).toBe(30000);
    expect(r.totalGs).toBe(130000);
  });
  it('getCoverageQuoteAttemptState envía tenantId + requestId', async () => {
    llamadas['coverageQuoteAttemptState'] = vi.fn().mockResolvedValue({ data: { ok: true, attempt: null } });
    const r = await getCoverageQuoteAttemptState('perfumeria', 'covr_abc123DEF456');
    expect(llamadas['coverageQuoteAttemptState']).toHaveBeenCalledWith({ tenantId: 'perfumeria', requestId: 'covr_abc123DEF456' });
    expect(r.attempt).toBeNull();
  });
  it('resolveCoverageQuoteUnknown envía resolución + nota + attemptId exactos', async () => {
    llamadas['coverageQuoteResolveUnknown'] = vi.fn().mockResolvedValue({ data: { ok: true, resolved: 'not_delivered' } });
    await resolveCoverageQuoteUnknown('perfumeria', 'covr_abc123DEF456', 'qat_XYZ987654321', 'not_delivered', 'verifiqué: no llegó');
    expect(llamadas['coverageQuoteResolveUnknown']).toHaveBeenCalledWith({
      tenantId: 'perfumeria',
      requestId: 'covr_abc123DEF456',
      quoteAttemptId: 'qat_XYZ987654321',
      resolution: 'not_delivered',
      note: 'verifiqué: no llegó',
    });
  });
});

describe('getCoverageFlowState — política tipada + deploy skew', () => {
  it('respuesta NUEVA: la política pasa tal cual', async () => {
    llamadas['coverageFlowState'] = vi.fn().mockResolvedValue({ data: { enabled: true, activationId: 'act-1', shippingQuote: { status: 'required', maxChargeGs: 5000000 } } });
    const r = await getCoverageFlowState('perfumeria');
    expect(r.shippingQuote).toEqual({ status: 'required', maxChargeGs: 5000000 });
  });
  it('respuesta VIEJA sin shippingQuote (skew de deploy) ⇒ off, jamás rompe', async () => {
    llamadas['coverageFlowState'] = vi.fn().mockResolvedValue({ data: { enabled: true, activationId: 'act-1' } });
    const r = await getCoverageFlowState('perfumeria');
    expect(r.shippingQuote).toEqual({ status: 'off' });
    expect(r.enabled).toBe(true);
  });
  it('permission-denied ⇒ estado OFF completo (fail-closed sin romper)', async () => {
    llamadas['coverageFlowState'] = vi.fn().mockRejectedValue({ code: 'functions/permission-denied' });
    const r = await getCoverageFlowState('perfumeria');
    expect(r).toEqual({ enabled: false, activationId: null, shippingQuote: { status: 'off' } });
  });
});

describe('mapQuoteError — kind por kind (defensivo, jamás por strings del mensaje)', () => {
  const err = (kind: string) => ({ code: 'functions/failed-precondition', details: { kind } });

  it('unknown CONFIRMADO ⇒ estado unknown con evidencia financiera obligatoria', () => {
    const s = mapQuoteError(err('unknown'), payload, evidencia);
    expect(s).toEqual({ status: 'unknown', requestId: payload.requestId, shippingGs: 30000, totalGs: 130000, canonical: evidencia.canonical });
  });
  it('in_progress ⇒ cierra el ciclo local (idle; el chip durable informa) — JAMÁS unknown', () => {
    const s = mapQuoteError(err('in_progress'), payload, evidencia);
    expect(s).toEqual({ status: 'idle' });
  });
  it('mapeos determinísticos de la tabla', () => {
    const casos: Array<[string, string]> = [
      ['meta_rejected', 'meta_rejected'],
      ['cart_changed', 'cart_changed'],
      ['cart_invalid', 'cart_changed'],
      ['cart_changed_post_send', 'no_aplicado'], // post-envío: el cliente PUDO recibir el costo
      ['location_changed', 'location_changed'],
      ['parse_mismatch', 'parse_mismatch'],
      ['expired', 'expired'],
      ['flow_off', 'flow_off'],
      ['quote_not_required', 'quote_not_required'],
      ['config_invalida', 'config_invalida'],
      ['config_cap', 'no_aplicado'], // config_cap solo ocurre en TX-C (post-envío)
      ['total_invalido', 'total_invalido'],
      ['quote_en_curso', 'quote_en_curso'],
      ['channel_unavailable', 'channel_unavailable'],
      ['not_assigned', 'not_assigned'],
      ['not_allowed', 'not_assigned'],
      ['already_decided', 'generic'],
      ['not_found', 'generic'],
      ['invalid_input', 'generic'],
      ['retry_tx', 'generic'],
    ];
    for (const [backend, ui] of casos) {
      const s = mapQuoteError(err(backend), payload, evidencia);
      expect(s.status, backend).toBe('error');
      expect((s as { kind: string }).kind, backend).toBe(ui);
    }
  });
  it('details en customData (forma alternativa del SDK) también se lee', () => {
    const s = mapQuoteError({ code: 'functions/failed-precondition', customData: { details: { kind: 'meta_rejected' } } }, payload, evidencia);
    expect((s as { kind: string }).kind).toBe('meta_rejected');
  });
  it('sin details / formas inválidas / transporte ambiguo ⇒ generic (la recuperación durable decide; sin retry ciego)', () => {
    for (const e of [new Error('network'), { code: 'functions/internal' }, { details: 'no-objeto' }, { details: { kind: 42 } }, null, undefined]) {
      const s = mapQuoteError(e, payload, evidencia);
      expect(s.status).toBe('error');
      expect((s as { kind: string }).kind).toBe('generic');
    }
  });
  it('el mensaje del error JAMÁS participa de la clasificación', () => {
    const s = mapQuoteError({ message: 'unknown meta_rejected cart_changed' }, payload, evidencia);
    expect((s as { kind: string }).kind).toBe('generic');
  });
});
