/**
 * resolveWhatsappCreds.cutover.test.ts — el token sale de la conexión DUEÑA del número (correctivo, ALTO 7).
 * =========================================================================================================
 * Post-cutover, el asset `selected:true` es el de la conexión `wa_{pnid}` (el número real), pero el
 * resolvedor leía SIEMPRE `metaConnections/main`: emparejaba el PNID nuevo con el token del legacy.
 * Meta rechaza ese par — o peor, lo acepta con permisos cruzados. El remitente por defecto y su
 * credencial tienen que salir del MISMO lugar: la conexión dueña del asset seleccionado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
const secretos = new Map<string, string>();

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({ path, get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }) }),
    collection: (path: string) => ({
      where: (campo: string, _op: string, valor: unknown) => ({
        where: (campo2: string, _op2: string, valor2: unknown) => ({
          limit: () => ({
            get: async () => ({
              docs: [...docs.entries()]
                .filter(([k, v]) => k.startsWith(`${path}/`) && v[campo] === valor && v[campo2] === valor2)
                .map(([k, v]) => ({ id: k.split('/').pop()!, data: () => v })),
            }),
          }),
        }),
      }),
    }),
  }),
  paths: {
    metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}`,
    metaAssets: (t: string) => `tenants/${t}/metaAssets`,
  },
}));
vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ get: async (ref: string) => secretos.get(ref) ?? null }),
}));

import { resolveTenantWhatsappCreds } from './resolveWhatsappCreds.js';

const T = 'tnt_cut';
const PNID_LEGACY = '111000111';
const PNID_NUEVO = '999000999';

beforeEach(() => {
  docs.clear();
  secretos.clear();
  vi.useFakeTimers();
  vi.setSystemTime(1_760_000_000_000);
});

/** El estado que DEJA el cutover: el número real seleccionado en su propia conexión. */
function sembrarPostCutover(): void {
  docs.set(`tenants/${T}/metaConnections/main`, { id: 'main', status: 'active', tokenSecretRef: 'secret://main' });
  secretos.set('secret://main', 'token-del-legacy');
  docs.set(`tenants/${T}/metaConnections/wa_${PNID_NUEVO}`, { id: `wa_${PNID_NUEVO}`, status: 'active', tokenSecretRef: 'secret://coex' });
  secretos.set('secret://coex', 'token-del-numero-real');
  docs.set(`tenants/${T}/metaAssets/${PNID_LEGACY}`, {
    assetType: 'whatsapp_phone_number', externalId: PNID_LEGACY, connectionId: 'main', selected: false,
  });
  docs.set(`tenants/${T}/metaAssets/${PNID_NUEVO}`, {
    assetType: 'whatsapp_phone_number', externalId: PNID_NUEVO, connectionId: `wa_${PNID_NUEVO}`, selected: true,
  });
}

describe('resolveTenantWhatsappCreds — la credencial es de la conexión dueña del seleccionado', () => {
  it('post-cutover: el PNID nuevo sale con SU token, no con el de main', async () => {
    sembrarPostCutover();

    const r = await resolveTenantWhatsappCreds(T);

    expect(r).toMatchObject({ ok: true, phoneNumberId: PNID_NUEVO, accessToken: 'token-del-numero-real' });
  });

  it('CERO REGRESIÓN: con el legacy seleccionado (producción hoy), main sigue mandando', async () => {
    sembrarPostCutover();
    docs.set(`tenants/${T}/metaAssets/${PNID_LEGACY}`, { ...docs.get(`tenants/${T}/metaAssets/${PNID_LEGACY}`)!, selected: true });
    docs.set(`tenants/${T}/metaAssets/${PNID_NUEVO}`, { ...docs.get(`tenants/${T}/metaAssets/${PNID_NUEVO}`)!, selected: false });

    const r = await resolveTenantWhatsappCreds(T);

    expect(r).toMatchObject({ ok: true, phoneNumberId: PNID_LEGACY, accessToken: 'token-del-legacy' });
  });

  it('la conexión dueña caída ⇒ not_connected, aunque main esté sana (jamás el token equivocado)', async () => {
    sembrarPostCutover();
    docs.set(`tenants/${T}/metaConnections/wa_${PNID_NUEVO}`, { id: `wa_${PNID_NUEVO}`, status: 'error', tokenSecretRef: 'secret://coex' });

    const r = await resolveTenantWhatsappCreds(T);

    expect(r.ok).toBe(false);
    expect((r as { reason?: string }).reason).toBe('not_connected');
  });

  it('CERO REGRESIÓN: asset legacy SIN connectionId (anterior al campo) sigue resolviendo por main', async () => {
    docs.set(`tenants/${T}/metaConnections/main`, { id: 'main', status: 'active', tokenSecretRef: 'secret://main' });
    secretos.set('secret://main', 'token-del-legacy');
    docs.set(`tenants/${T}/metaAssets/${PNID_LEGACY}`, { assetType: 'whatsapp_phone_number', externalId: PNID_LEGACY, selected: true });

    const r = await resolveTenantWhatsappCreds(T);

    expect(r).toMatchObject({ ok: true, phoneNumberId: PNID_LEGACY, accessToken: 'token-del-legacy' });
  });
});
