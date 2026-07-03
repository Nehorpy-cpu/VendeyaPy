import { describe, it, expect, vi } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { waConnectionId, runAddWhatsappNumber, type AddNumberDeps } from './multiNumber.js';
import { metaNumberTokenSecretName } from './secretName.js';
import type { ManualWhatsappInput } from './manualConnect.js';
import type { MetaGraphClient } from './graphClient.js';
import type { MetaAsset } from '@vpw/shared';

/**
 * MULTI-NUMBER-1: caminos de RECHAZO de runAddWhatsappNumber (retornan/lanzan ANTES de
 * escribir en Firestore → unit-testeables con DI puro). El camino feliz (batch + verify)
 * lo cubre verify-multi-number.mjs en el emulador.
 */
const input: ManualWhatsappInput = {
  wabaId: 'waba-1', phoneNumberId: '111222333', displayPhoneNumber: '+595 991 111 222',
  businessName: 'Test', accessToken: 'tok-fake', tokenExpiresAtMs: null,
};
const graph = {} as MetaGraphClient; // no se llega a usar en los caminos de rechazo

const deps = (over: Partial<AddNumberDeps>): AddNumberDeps => ({
  collisionTenant: async () => null,
  getAsset: async () => null,
  countActiveNumbers: async () => 1,
  assertQuota: async () => {},
  storeToken: vi.fn(async () => { throw new Error('no debería llegar a storeToken'); }),
  ...over,
});

describe('meta/multiNumber', () => {
  it('waConnectionId / metaNumberTokenSecretName: determinísticos y seguros para paths', () => {
    expect(waConnectionId('123')).toBe('wa_123');
    expect(metaNumberTokenSecretName('arfagi', '123')).toBe('meta-token-arfagi-123');
    expect(metaNumberTokenSecretName('a/b', '1/2')).toBe('meta-token-a_b-1_2'); // sin '/'
  });

  it('colisión cross-tenant → phone_number_collision (nunca secuestrar webhooks)', async () => {
    const r = await runAddWhatsappNumber('arfagi', input, 'admin', graph, deps({ collisionTenant: async () => 'otra-empresa' }));
    expect(r).toEqual({ ok: false, reason: 'phone_number_collision', conflictTenantId: 'otra-empresa' });
  });

  it('mismo tenant con el número ya ACTIVO → already_active', async () => {
    const r = await runAddWhatsappNumber('arfagi', input, 'admin', graph, deps({
      collisionTenant: async () => 'arfagi',
      getAsset: async () => ({ status: 'active' } as MetaAsset),
    }));
    expect(r).toEqual({ ok: false, reason: 'already_active' });
  });

  it('gate del plan: assertQuota recibe activos+1 y su rechazo se propaga (HttpsError)', async () => {
    const quota = vi.fn(async (_t: string, needed: number) => {
      if (needed > 2) throw new HttpsError('failed-precondition', 'límite del plan');
    });
    await expect(
      runAddWhatsappNumber('arfagi', input, 'admin', graph, deps({ countActiveNumbers: async () => 2, assertQuota: quota })),
    ).rejects.toThrow('límite del plan');
    expect(quota).toHaveBeenCalledWith('arfagi', 3, 'admin');
  });
});
