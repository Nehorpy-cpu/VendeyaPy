/**
 * registerTenantOwner.gate.test.ts — SINGLE-TENANT-LOCK (Fase 2 del cierre single-tenant)
 * El flag ALLOW_SELF_REGISTRATION cierra el alta self-service. Default ABIERTO (var ausente
 * o cualquier valor ≠ 'false') para que emulador y E2E existentes no cambien.
 */
import { describe, it, expect } from 'vitest';
import { selfRegistrationClosed } from './registerTenantOwner.js';

describe('selfRegistrationClosed (SINGLE-TENANT-LOCK)', () => {
  it('cerrado SOLO con el valor exacto "false"', () => {
    expect(selfRegistrationClosed({ ALLOW_SELF_REGISTRATION: 'false' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('abierto por default: var ausente, vacía, "true" u otros valores', () => {
    expect(selfRegistrationClosed({} as NodeJS.ProcessEnv)).toBe(false);
    expect(selfRegistrationClosed({ ALLOW_SELF_REGISTRATION: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(selfRegistrationClosed({ ALLOW_SELF_REGISTRATION: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(selfRegistrationClosed({ ALLOW_SELF_REGISTRATION: 'FALSE' } as NodeJS.ProcessEnv)).toBe(false); // estricto a propósito
  });
});
