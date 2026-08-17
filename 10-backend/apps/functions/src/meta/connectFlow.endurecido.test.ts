/**
 * connectFlow.endurecido.test.ts — EL CONNECT REAL NO PUEDE APAGAR AL NÚMERO QUE VENDE
 * =====================================================================================
 * `runMetaConnect` es el camino REAL del Embedded Signup y hasta este cambio no tenía ni un solo
 * test (`connectFlow.test.ts` cubre dos helpers puros). Los defectos que se fijan acá:
 *
 * C1 — CUALQUIER FALLO DEL CONNECT DEGRADABA LA CONEXIÓN SANA. `writeFailureStatus` escribía
 *      `status` + `tokenSecretRef: ''` sobre `metaConnections/main`. Un reintento fallido del
 *      Embedded Signup —un code vencido alcanza— dejaba SIN CREDENCIALES a la conexión que está
 *      vendiendo: `resolveTenantWhatsappCreds` exige `status === 'active'` y un `tokenSecretRef`
 *      con contenido, así que el número quedaba mudo hasta que alguien reconectara. Es un defecto
 *      VIVO, independiente de Coexistence. El precedente correcto ya estaba en el propio archivo:
 *      `over_number_limit` no persiste nada.
 *
 * A1 — EL `wabaId` LO MANDA EL CLIENTE y se usaba sin contrastarlo contra los `granular_scopes`
 *      del token, que ya venían resueltos en `dbg.wabaIds` y solo se usaban como fallback.
 *
 * A2 — `pickSelectedPhone` CAÍA EN SILENCIO AL PRIMER NÚMERO cuando el pedido no existía: el
 *      usuario elegía un número y el sistema conectaba OTRO, sin decírselo.
 *
 * A3 — EL SECRETO SE ESCRIBÍA ANTES QUE LA CONEXIÓN, fuera de toda transacción: si la escritura
 *      posterior fallaba quedaba un secreto huérfano y, peor, una conexión a medio hacer.
 *
 * C2 — LA COLISIÓN CROSS-TENANT DE PNID tiene que llegar al usuario como un motivo propio, no como
 *      una excepción cruda.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetaPhoneNumber, MetaGraphClient, DebugTokenResult } from './graphClient.js';

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const secretos = new Map<string, string>();
  return {
    docs,
    secretos,
    escribirAssets: vi.fn(async (_t: string, _c: string, _a: unknown[]) => {}),
    guardarSecreto: vi.fn(async (name: string, valor: string) => {
      const ref = `secret://${name}`;
      secretos.set(ref, valor);
      return ref;
    }),
    borrarSecreto: vi.fn(async (ref: string) => {
      secretos.delete(ref);
    }),
    auditar: vi.fn(async (_e: unknown) => {}),
    verificar: vi.fn(async () => ({ ready: true, reason: 'ok', status: 'active' })),
  };
});

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: h.docs.has(path), data: () => h.docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        h.docs.set(path, opts?.merge ? { ...(h.docs.get(path) ?? {}), ...data } : { ...data });
      },
    }),
  }),
  paths: { metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}` },
}));

vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ set: h.guardarSecreto, get: async (ref: string) => h.secretos.get(ref) ?? null, remove: h.borrarSecreto }),
}));

vi.mock('./discovery.js', () => ({
  buildMetaAssets: (i: { phones: MetaPhoneNumber[] }) =>
    i.phones.map((p) => ({ externalId: p.id, assetType: 'whatsapp_phone_number', name: p.id, selected: true })),
  writeDiscoveredAssets: h.escribirAssets,
}));

vi.mock('./preflight.js', () => ({ verifyWhatsappChannel: h.verificar }));

vi.mock('../entitlements/entitlements.js', () => ({
  resolveEntitlements: async () => ({ limits: { maxWhatsappNumbers: 10 } }),
}));

vi.mock('../audit/audit.js', () => ({ recordAudit: h.auditar }));

import { runMetaConnect } from './connectFlow.js';
import { PnidOcupadoError } from './pnidOwnership.js';

const TENANT = 'tnt_alpha';
const WABA = 'waba_1';
const PNID_QUE_VENDE = '111222333';
const PNID_OTRO = '444555666';
const CONN = `tenants/${TENANT}/metaConnections/main`;
const REF_PREVIA = `secret://meta-token-${TENANT}`;

const numero = (id: string): MetaPhoneNumber => ({
  id,
  displayPhoneNumber: id,
  verifiedName: '',
  qualityRating: '',
  codeVerificationStatus: '',
});

const SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'];

/** Graph de mentira: nunca sale a la red, nunca muta nada en Meta. */
const graphFake = (over: Partial<MetaGraphClient> & { dbg?: Partial<DebugTokenResult> } = {}): MetaGraphClient => ({
  exchangeCode: async () => ({ accessToken: 'token-de-prueba', tokenType: 'bearer', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: SCOPES, wabaIds: [WABA], expiresAtMs: null, ...over.dbg }),
  listWabaPhoneNumbers: async () => [numero(PNID_QUE_VENDE)],
  getPhoneNumber: async () => null,
  subscribeApp: async () => {},
  ...over,
});

/** La conexión que HOY está vendiendo: activa y con su token referenciado. */
const sembrarConexionQueVende = (): void => {
  h.docs.set(CONN, {
    id: 'main',
    tenantId: TENANT,
    status: 'active',
    tokenSecretRef: REF_PREVIA,
    scopes: SCOPES,
    errorMessage: '',
  });
  h.secretos.set(REF_PREVIA, 'token-que-vende');
};

beforeEach(() => {
  h.docs.clear();
  h.secretos.clear();
  vi.clearAllMocks();
  h.escribirAssets.mockImplementation(async () => {});
  h.verificar.mockImplementation(async () => ({ ready: true, reason: 'ok', status: 'active' }));
});

describe('C1 — un connect FALLIDO no puede degradar la conexión que está vendiendo', () => {
  it('el intercambio del code falla → la conexión previa sigue activa y CON su token', async () => {
    sembrarConexionQueVende();

    const r = await runMetaConnect(
      TENANT,
      { code: 'code-de-prueba' },
      'uid-1',
      graphFake({ exchangeCode: async () => { throw new Error('falla simulada del intercambio'); } }),
    );

    expect(r.ok).toBe(false);
    const conn = h.docs.get(CONN)!;
    expect(conn['status']).toBe('active');
    expect(conn['tokenSecretRef']).toBe(REF_PREVIA);
  });

  it('token inválido → tampoco degrada (era el mismo `writeFailureStatus`)', async () => {
    sembrarConexionQueVende();

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake({ dbg: { isValid: false } }));

    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe(REF_PREVIA);
  });

  it('scopes insuficientes → tampoco degrada', async () => {
    sembrarConexionQueVende();

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake({ dbg: { scopes: [] } }));

    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe(REF_PREVIA);
  });

  it('sin números en el WABA → tampoco degrada', async () => {
    sembrarConexionQueVende();

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake({ listWabaPhoneNumbers: async () => [] }));

    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe(REF_PREVIA);
  });

  it('el fallo SÍ queda registrado, pero en campos propios (si no, nadie lo puede diagnosticar)', async () => {
    sembrarConexionQueVende();

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake({ dbg: { isValid: false } }));

    const conn = h.docs.get(CONN)!;
    expect(typeof conn['lastConnectError']).toBe('string');
    expect(conn['lastConnectError']).not.toBe('');
    expect(conn['lastConnectErrorAt']).toBeDefined();
  });

  it('un fallo NO puede fingir que revalidamos la conexión (`lastVerifiedAt` no se toca)', async () => {
    sembrarConexionQueVende();
    h.docs.set(CONN, { ...h.docs.get(CONN)!, lastVerifiedAt: 'marca-previa' });

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake({ dbg: { isValid: false } }));

    expect(h.docs.get(CONN)?.['lastVerifiedAt']).toBe('marca-previa');
  });

  it('sin conexión previa el fallo tampoco inventa una conexión activa', async () => {
    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake({ dbg: { isValid: false } }));

    expect(h.docs.get(CONN)?.['status']).not.toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef'] ?? '').toBe('');
  });

  it('ningún camino de fallo guarda el token', async () => {
    sembrarConexionQueVende();

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake({ dbg: { isValid: false } }));

    expect(h.guardarSecreto).not.toHaveBeenCalled();
  });
});

describe('C2 — un fallo DESPUÉS del set del secreto no puede destruir la credencial que vende (correctivo, CRÍTICO 2)', () => {
  it('writeDiscoveredAssets falla → el secreto de main conserva su VALOR previo, no el del intento', async () => {
    sembrarConexionQueVende();
    h.escribirAssets.mockImplementation(async () => { throw new Error('firestore caído'); });

    const r = await runMetaConnect(
      TENANT,
      { code: 'code-nuevo' },
      'uid-1',
      graphFake({ exchangeCode: async () => ({ accessToken: 'token-del-intento', tokenType: 'bearer', expiresInS: 3600 }) }),
    );

    expect(r.ok).toBe(false);
    // El naming del secreto es determinístico ⇒ el set PISÓ el documento. El rollback que solo
    // comparaba referencias (misma string siempre) dejaba el token del intento fallido en el
    // lugar del que vende: la conexión seguía 'active' apuntando a una credencial destruida.
    expect(h.secretos.get(REF_PREVIA)).toBe('token-que-vende');
  });
});

describe('A1 — el `wabaId` que manda el cliente se contrasta contra el token', () => {
  it('un wabaId que NO está en los granular_scopes del token → no_waba, sin escribir nada', async () => {
    sembrarConexionQueVende();

    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba', wabaId: 'waba_ajena' }, 'uid-1', graphFake());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_waba');
    expect(h.guardarSecreto).not.toHaveBeenCalled();
    expect(h.escribirAssets).not.toHaveBeenCalled();
    expect(h.docs.get(CONN)?.['status']).toBe('active');
  });

  it('SIN REGRESIÓN: el wabaId pedido que SÍ está en el token sigue conectando', async () => {
    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-1', graphFake());
    expect(r.ok).toBe(true);
  });

  it('SIN REGRESIÓN: sin wabaId en el input se sigue usando el del token', async () => {
    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());
    expect(r.ok).toBe(true);
  });
});

describe('A2 — el número PEDIDO no se sustituye en silencio', () => {
  it('el phoneNumberId pedido no está entre los del WABA → falla; NO conecta otro número', async () => {
    sembrarConexionQueVende();

    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba', phoneNumberId: PNID_OTRO }, 'uid-1', graphFake());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('phone_number_mismatch');
    expect(h.escribirAssets).not.toHaveBeenCalled();
  });

  it('SIN REGRESIÓN: sin pedido explícito se sigue tomando el primero del WABA', async () => {
    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.selectedPhoneNumberId).toBe(PNID_QUE_VENDE);
  });
});

describe('A3 — un fallo a mitad de la escritura no deja la conexión aparentando estar bien', () => {
  it('si el discovery falla, la conexión previa queda intacta (no a medio hacer)', async () => {
    sembrarConexionQueVende();
    h.escribirAssets.mockImplementation(async () => { throw new Error('falla simulada del discovery'); });

    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());

    expect(r.ok).toBe(false);
    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe(REF_PREVIA);
  });

  it('el secreto PREEXISTENTE nunca se borra en el rollback (borrarlo dejaría mudo al que vende)', async () => {
    sembrarConexionQueVende();
    h.escribirAssets.mockImplementation(async () => { throw new Error('falla simulada del discovery'); });

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());

    expect(h.borrarSecreto).not.toHaveBeenCalled();
    expect(h.secretos.has(REF_PREVIA)).toBe(true);
  });

  it('un secreto RECIÉN creado (no había conexión previa) sí se limpia', async () => {
    h.escribirAssets.mockImplementation(async () => { throw new Error('falla simulada del discovery'); });

    await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());

    expect(h.borrarSecreto).toHaveBeenCalledWith(REF_PREVIA);
    expect(h.secretos.size).toBe(0);
  });
});

describe('C2 — la colisión cross-tenant llega como motivo propio', () => {
  it('si el guard de propiedad rechaza el PNID, el resultado lo dice y la conexión previa queda sana', async () => {
    sembrarConexionQueVende();
    h.escribirAssets.mockImplementation(async () => { throw new PnidOcupadoError(PNID_QUE_VENDE, 'tnt_beta'); });

    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('phone_number_collision');
    expect(h.docs.get(CONN)?.['status']).toBe('active');
  });
});

describe('MEDIO — el alta REAL también deja auditoría', () => {
  it('un connect exitoso registra la acción, sin el número completo', async () => {
    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());

    expect(r.ok).toBe(true);
    expect(h.auditar).toHaveBeenCalledTimes(1);
    const entrada = h.auditar.mock.calls[0]![0] as { action: string; tenantId: string; metadata?: Record<string, unknown> };
    expect(entrada.action).toBe('meta.connected');
    expect(entrada.tenantId).toBe(TENANT);
    expect(JSON.stringify(entrada)).not.toContain(PNID_QUE_VENDE);
    expect(JSON.stringify(entrada)).not.toContain('token-de-prueba');
  });
});

describe('C6 — el WABA del flujo estándar también se elige EXPLÍCITO (release-safety del cierre final)', () => {
  it('varios WABAs autorizados y ningún pedido ⇒ NO adivina el primero: queda en selección pendiente', async () => {
    sembrarConexionQueVende();

    const r = await runMetaConnect(
      TENANT,
      { code: 'code-de-prueba' }, // sin wabaId: el token autoriza DOS cuentas
      'uid-1',
      graphFake({ dbg: { wabaIds: [WABA, 'waba_de_otro_cliente'] } }),
    );

    // «El primero de la lista» puede ser el WABA de OTRO cliente del Tech Provider: conectar main
    // contra esa cuenta redirigiría el negocio entero. La elección tiene que ser explícita.
    // ADR-0020 (G2): el code ya se canjeó y reclamó, así que el rechazo terminal (`no_waba`) se
    // reemplaza por la SELECCIÓN PENDIENTE — mismo invariante (acá no se conecta nada), pero el
    // owner puede desambiguar sin otro login. El detalle vive en connectFlow.seleccionWaba.test.ts.
    expect(r.ok).toBe(false);
    expect((r as { reason?: string }).reason).toBe('waba_selection_required');
    expect(h.escribirAssets).not.toHaveBeenCalled();
    // Y la conexión que vende quedó intacta.
    expect((h.docs.get(CONN) as { status?: string })['status']).toBe('active');
    expect((h.docs.get(CONN) as { tokenSecretRef?: string })['tokenSecretRef']).toBe(REF_PREVIA);
  });

  it('CERO REGRESIÓN: un solo WABA autorizado sin pedido sigue conectando', async () => {
    sembrarConexionQueVende();

    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, 'uid-1', graphFake());

    expect(r.ok).toBe(true);
  });
});
