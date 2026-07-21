import { describe, it, expect } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  assertCoverageActor,
  resolveTenant,
  validarInput,
  MENSAJE_MAS_INFORMACION,
  assertShippingPolicyPermitsApprove,
} from './coverageCallables.js';

/**
 * COVERAGE-1C: helpers PUROS de autorización/validación de las callables de revisión.
 * La lógica transaccional (doble clic, fingerprint, expiración, seller asignado) se
 * verifica end-to-end en scripts/verify-coverage-review.mjs.
 */
const auth = (role: string, tenantId = 't1', uid = 'u1') =>
  ({ uid, token: { role, tenantId, name: 'Test' } }) as Parameters<typeof assertCoverageActor>[0];

describe('coverage assertCoverageActor — quién decide cobertura', () => {
  it('owner y manager del tenant deciden; seller pasa el gate de rol (la asignación se valida en la tx)', () => {
    expect(assertCoverageActor(auth('TENANT_OWNER'), 't1').role).toBe('TENANT_OWNER');
    expect(assertCoverageActor(auth('TENANT_MANAGER'), 't1').role).toBe('TENANT_MANAGER');
    expect(assertCoverageActor(auth('SELLER'), 't1').role).toBe('SELLER');
  });

  it('PLATFORM_ADMIN sin rol operativo NO decide cobertura', () => {
    expect(() => assertCoverageActor(auth('PLATFORM_ADMIN'), 't1')).toThrowError(/soporte de plataforma/);
  });

  it('cross-tenant y roles sin permiso → permission-denied; sin sesión → unauthenticated', () => {
    expect(() => assertCoverageActor(auth('TENANT_OWNER', 'otro-tenant'), 't1')).toThrowError(/acceso/);
    expect(() => assertCoverageActor(auth('TENANT_VIEWER'), 't1')).toThrowError(/rol/);
    expect(() => assertCoverageActor(null, 't1')).toThrowError(/sesión/i);
  });
});

describe('coverage resolveTenant — el tenant SIEMPRE sale de los claims', () => {
  it('usa los claims e ignora coincidencias; rechaza discrepancias y usuarios sin tenant', () => {
    expect(resolveTenant(auth('TENANT_OWNER', 'mi-tenant'), undefined)).toBe('mi-tenant');
    expect(resolveTenant(auth('TENANT_OWNER', 'mi-tenant'), 'mi-tenant')).toBe('mi-tenant');
    expect(() => resolveTenant(auth('TENANT_OWNER', 'mi-tenant'), 'otro')).toThrowError(/acceso/);
    expect(() => resolveTenant({ uid: 'u', token: {} } as Parameters<typeof resolveTenant>[0], undefined)).toThrowError(/empresa/);
  });
});

describe('coverage validarInput — entrada estructurada', () => {
  it('requestId con formato covr_ + fingerprint obligatorio', () => {
    const ok = validarInput({ requestId: 'covr_abc123DEF456', expectedFingerprint: 'geo:0123456789abcdef' });
    expect(ok.requestId).toBe('covr_abc123DEF456');
    expect(ok.note).toBeNull();
    expect(() => validarInput({ requestId: 'ord_abc123DEF456', expectedFingerprint: 'x' })).toThrowError(/inválida/);
    expect(() => validarInput({ requestId: 'covr_abc123DEF456' })).toThrowError(/huella/i);
    expect(() => validarInput({ requestId: 'covr_abc123DEF456', expectedFingerprint: '' })).toThrowError(/huella/i);
  });

  it('nota: trim, colapso y tope de 300 — jamás obligatoria', () => {
    const r = validarInput({ requestId: 'covr_abc123DEF456', expectedFingerprint: 'txt:x', note: '  fuera   de zona  ' });
    expect(r.note).toBe('fuera de zona');
    expect(validarInput({ requestId: 'covr_abc123DEF456', expectedFingerprint: 'txt:x', note: 'z'.repeat(900) }).note).toHaveLength(300);
  });
});

describe('coverage MENSAJE_MAS_INFORMACION — determinístico y seguro', () => {
  it('pide ciudad/barrio/calle/referencia sin prometer nada', () => {
    expect(MENSAJE_MAS_INFORMACION).toMatch(/ciudad, barrio, calle y una referencia/);
    expect(MENSAJE_MAS_INFORMACION).not.toMatch(/llegamos|cobertura confirmada|te paso/i);
  });
});

describe('SHIPPING-CHAT-3B — assertShippingPolicyPermitsApprove (gate del approve VIEJO)', () => {
  it('policy off ⇒ comportamiento actual (no lanza)', () => {
    expect(() => assertShippingPolicyPermitsApprove({ status: 'off' })).not.toThrow();
  });
  it('policy required ⇒ rechaza con details.kind shipping_quote_required (sin datos sensibles)', () => {
    try {
      assertShippingPolicyPermitsApprove({ status: 'required', maxChargeGs: 5_000_000 });
      expect.unreachable('debió lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      expect((e as HttpsError).code).toBe('failed-precondition');
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('shipping_quote_required');
      expect((e as HttpsError).message).not.toMatch(/5000000|5\.000\.000/); // sin config en el mensaje
    }
  });
  it('policy invalid ⇒ rechaza fail-closed con kind shipping_quote_config_invalid (jamás degrada a off)', () => {
    try {
      assertShippingPolicyPermitsApprove({ status: 'invalid' });
      expect.unreachable('debió lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('shipping_quote_config_invalid');
    }
  });
});
