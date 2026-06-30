import { describe, it, expect, vi } from 'vitest';
import {
  parseManualWhatsappInput,
  whatsappIndexId,
  runManualWhatsappConnect,
  type ManualWhatsappInput,
  type ManualConnectDeps,
} from './manualConnect.js';
import type { MetaGraphClient } from './graphClient.js';

const VALID = {
  tenantId: 'tnt-1',
  wabaId: '100000000000001',
  phoneNumberId: '109876543210987',
  displayPhoneNumber: '+595 99 123 4567',
  businessId: '200000000000002',
  businessName: 'Mi Tienda',
  accessToken: 'EAAG-long-lived-token',
  tokenExpiresAt: 1893456000000,
};

describe('parseManualWhatsappInput', () => {
  it('acepta un input válido y normaliza', () => {
    const r = parseManualWhatsappInput(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.wabaId).toBe('100000000000001');
      expect(r.value.phoneNumberId).toBe('109876543210987');
      expect(r.value.accessToken).toBe('EAAG-long-lived-token');
      expect(r.value.tokenExpiresAtMs).toBe(1893456000000);
    }
  });

  it('acepta el mínimo (sin business ni expiración) → tokenExpiresAtMs null', () => {
    const r = parseManualWhatsappInput({ wabaId: 'waba1', phoneNumberId: '12345', displayPhoneNumber: '+1', accessToken: 'tok' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.businessId).toBeUndefined();
      expect(r.value.tokenExpiresAtMs).toBeNull();
    }
  });

  it('rechaza wabaId faltante', () => {
    expect(parseManualWhatsappInput({ ...VALID, wabaId: '' }).ok).toBe(false);
  });

  it('rechaza phoneNumberId faltante', () => {
    expect(parseManualWhatsappInput({ ...VALID, phoneNumberId: '' }).ok).toBe(false);
  });

  it('rechaza phoneNumberId NO numérico (ej. el +595…, no el id de Meta)', () => {
    const r = parseManualWhatsappInput({ ...VALID, phoneNumberId: '+595991234567' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/phoneNumberId/);
  });

  it('rechaza displayPhoneNumber faltante', () => {
    expect(parseManualWhatsappInput({ ...VALID, displayPhoneNumber: '   ' }).ok).toBe(false);
  });

  it('rechaza accessToken vacío', () => {
    expect(parseManualWhatsappInput({ ...VALID, accessToken: '   ' }).ok).toBe(false);
  });

  it('rechaza tokenExpiresAt inválido (0/negativo/NaN)', () => {
    expect(parseManualWhatsappInput({ ...VALID, tokenExpiresAt: 0 }).ok).toBe(false);
    expect(parseManualWhatsappInput({ ...VALID, tokenExpiresAt: -5 }).ok).toBe(false);
    expect(parseManualWhatsappInput({ ...VALID, tokenExpiresAt: 'x' as unknown as number }).ok).toBe(false);
  });

  it('ignora campos extra peligrosos (status/source/tokenSecretRef no llegan al value)', () => {
    const r = parseManualWhatsappInput({ ...VALID, status: 'active', source: 'manual_admin', tokenSecretRef: 'hack' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual(
        ['accessToken', 'businessId', 'businessName', 'displayPhoneNumber', 'phoneNumberId', 'tokenExpiresAtMs', 'wabaId'].sort(),
      );
    }
  });
});

describe('whatsappIndexId', () => {
  it('arma la clave del índice global', () => {
    expect(whatsappIndexId('109876543210987')).toBe('whatsapp_109876543210987');
  });
});

// ---- runManualWhatsappConnect (deps inyectables; sin emulador) ----

const input: ManualWhatsappInput = {
  wabaId: '100000000000001',
  phoneNumberId: '109876543210987',
  displayPhoneNumber: '+595 99 123 4567',
  businessId: '200000000000002',
  businessName: 'Mi Tienda',
  accessToken: 'EAAG-secret-token',
  tokenExpiresAtMs: null,
};

const fakeGraph = { subscribeApp: vi.fn(async () => {}) } as unknown as MetaGraphClient;

function makeDeps(over: Partial<ManualConnectDeps> = {}): ManualConnectDeps & {
  storeToken: ReturnType<typeof vi.fn>;
  writeConnection: ReturnType<typeof vi.fn>;
  writeAssets: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    collisionTenant: vi.fn(async () => null),
    storeToken: vi.fn(async () => 'secret://firestore/meta-token-tnt-1'),
    writeConnection: vi.fn(async () => {}),
    writeAssets: vi.fn(async () => {}),
    verify: vi.fn(async () => ({ ready: true, reason: 'ok', status: 'active', phoneNumber: '+595 99 123 4567' })),
    ...over,
  } as never;
}

describe('runManualWhatsappConnect', () => {
  it('colisión con otro tenant → falla y NO guarda token ni conexión', async () => {
    const deps = makeDeps({ collisionTenant: vi.fn(async () => 'otra-empresa') });
    const r = await runManualWhatsappConnect('tnt-1', input, 'admin-1', fakeGraph, deps);
    expect(r).toEqual({ ok: false, reason: 'phone_number_collision', conflictTenantId: 'otra-empresa' });
    expect(deps.storeToken).not.toHaveBeenCalled();
    expect(deps.writeConnection).not.toHaveBeenCalled();
  });

  it('mismo tenant (recarga) NO es colisión → procede', async () => {
    const deps = makeDeps({ collisionTenant: vi.fn(async () => 'tnt-1') });
    const r = await runManualWhatsappConnect('tnt-1', input, 'admin-1', fakeGraph, deps);
    expect(r.ok).toBe(true);
    expect(deps.storeToken).toHaveBeenCalledTimes(1);
  });

  it('happy path: guarda token cifrado, conexión pending_review+source, y estado final desde verify', async () => {
    const deps = makeDeps();
    const r = await runManualWhatsappConnect('tnt-1', input, 'admin-1', fakeGraph, deps);
    expect(r).toMatchObject({ ok: true, status: 'active', ready: true, phoneNumberId: '109876543210987' });
    // token va a SecretStore, no al doc
    expect(deps.storeToken).toHaveBeenCalledWith('tnt-1', 'EAAG-secret-token');
    const connFields = deps.writeConnection.mock.calls[0][1];
    expect(connFields.status).toBe('pending_review');
    expect(connFields.source).toBe('manual_admin');
    expect(connFields.tokenSecretRef).toBe('secret://firestore/meta-token-tnt-1');
    // el token CRUDO nunca se pasa a la escritura de la conexión
    expect(JSON.stringify(connFields)).not.toContain('EAAG-secret-token');
    expect(deps.writeAssets).toHaveBeenCalledTimes(1);
    expect(deps.verify).toHaveBeenCalledTimes(1);
  });

  it('NO marca active a ciegas: si verify dice permission_missing, el estado refleja eso', async () => {
    const deps = makeDeps({ verify: vi.fn(async () => ({ ready: false, reason: 'permission_missing', status: 'permission_missing' })) });
    const r = await runManualWhatsappConnect('tnt-1', input, 'admin-1', fakeGraph, deps);
    expect(r).toMatchObject({ ok: true, status: 'permission_missing', ready: false });
  });

  it('si verify lanza, queda pending_review (no active)', async () => {
    const deps = makeDeps({ verify: vi.fn(async () => { throw new Error('graph down'); }) });
    const r = await runManualWhatsappConnect('tnt-1', input, 'admin-1', fakeGraph, deps);
    expect(r).toMatchObject({ ok: true, status: 'pending_review', ready: false });
  });

  it('el asset del número queda selected con externalId = phoneNumberId', async () => {
    const deps = makeDeps();
    await runManualWhatsappConnect('tnt-1', input, 'admin-1', fakeGraph, deps);
    const assets = deps.writeAssets.mock.calls[0][1];
    const phone = assets.find((a: { assetType: string }) => a.assetType === 'whatsapp_phone_number');
    expect(phone).toMatchObject({ externalId: '109876543210987', selected: true });
  });
});
